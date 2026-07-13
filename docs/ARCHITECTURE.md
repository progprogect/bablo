# Архитектура

## Обзор

Один сервис на Railway (Node.js) + PostgreSQL. Сервис раздаёт статику PWA и предоставляет API.
Realtime — без поллинга: сервер держит WebSocket-соединения с BingX, клиент получает события по SSE.

```
┌─────────────────┐          ┌──────────────────────────────┐          ┌────────────┐
│  PWA (iPhone)   │   HTTPS  │   Node.js сервис (Railway)   │    WSS   │   BingX    │
│  React + Vite   │ ───────► │                              │ ───────► │            │
│                 │   REST   │  API (Fastify)               │  market  │  USDT-M    │
│  manifest.json  │ ◄─────── │  Risk Engine                 │  stream  │  Perpetual │
│  service worker │    SSE   │  BingX Connector             │ ───────► │  Futures   │
│                 │ ◄─────── │  Trade Tracker               │  account │            │
└─────────────────┘  events  │  Static (dist фронта)        │  stream  └────────────┘
                             └──────────────┬───────────────┘
                                            │ SQL
                                     ┌──────▼──────┐
                                     │ PostgreSQL  │
                                     │  (Railway)  │
                                     └─────────────┘
```

## Стек

| Слой | Выбор | Почему |
|---|---|---|
| Frontend | React + TypeScript + Vite, `vite-plugin-pwa` | Быстро, минимально, готовый PWA-манифест и SW |
| Стили | Tailwind CSS | Минимальный UI без библиотек компонентов |
| Backend | Node.js + TypeScript + Fastify | Лёгкий, быстрый, встроенный SSE через reply.raw |
| БД | PostgreSQL + Drizzle ORM | Railway из коробки; Drizzle — типобезопасно и без магии |
| Realtime BingX→сервер | WebSocket (market + account stream) | Официальный механизм, без поллинга |
| Realtime сервер→клиент | SSE (Server-Sent Events) | Проще WS, автопереподключение в браузере, хватает односторонних событий |
| Деплой | Railway: 1 сервис + Postgres | Монолит достаточен для одного пользователя |

## Структура репозитория (монорепо)

```
bablo/
├── docs/                  # эта документация
├── client/                # React PWA
│   └── src/
│       ├── screens/       # Dashboard, History, Admin
│       ├── components/
│       └── api/           # типизированный клиент API + SSE
├── server/
│   └── src/
│       ├── api/           # HTTP-роуты (Fastify)
│       ├── bingx/         # REST-клиент + WS-коннектор BingX
│       ├── trades/        # оркестрация сделок (open/TP) + чистая математика (R/R, риск)
│       ├── risk/          # риск-движок: лестница уровней, дневные лимиты (чистая логика, без I/O)
│       ├── tracker/       # трекинг активной сделки (MFE, безубыток)
│       ├── security/      # шифрование, PIN, сессии
│       ├── db/            # схема Drizzle, миграции, репозитории
│       └── events/        # внутренняя шина → SSE
└── package.json           # workspaces
```

## Модули сервера

### BingX Connector (`server/src/bingx`)
- REST: ордера (market, STOP_MARKET, TAKE_PROFIT_MARKET), плечо, тип маржи, баланс, listenKey.
- WS market (`wss://open-api-swap.bingx.com/swap-market`): подписка на цены только активных символов
  (последняя цена для дашборда; тик-поток для трекера, пока есть открытая сделка). GZIP, Ping→Pong.
- WS account (`...?listenKey=`): ACCOUNT_UPDATE, ORDER_TRADE_UPDATE. listenKey продлевается каждые 30 мин.
- **Известный нюанс BingX**: срабатывание STOP_MARKET/TAKE_PROFIT_MARKET может не приходить
  в ORDER_TRADE_UPDATE. Компенсация без поллинга: закрытие позиции детектится по ACCOUNT_UPDATE
  (позиция исчезла/обнулилась) + одиночный REST-запрос для уточнения деталей закрытия.
  Это событийная сверка, а не циклический опрос.

### Risk Engine (`server/src/risk`)
- Чистые функции без I/O — легко тестировать.
- Вход: состояние (уровень, прогресс R, сделки дня, активная сделка) + заявка.
- Выход: allow / deny с причиной. Вызывается в API до любого обращения к BingX.
- Дневные окна считаются от настраиваемого «времени сброса» (07:00).

### Trade Tracker (`server/src/tracker`)
- Активен только при открытой сделке: подписан на тики цены, обновляет MFE,
  флаг пересечения безубытка. Пишет в БД инкрементально.
- При закрытии сделки фиксирует итог, считает R-результат, передаёт в Risk Engine
  (обновление прогресса уровня, дневных счётчиков, установка блокировок).

### Events → SSE (`server/src/events`)
- Внутренняя шина (EventEmitter): `price.updated`, `trade.opened`, `trade.closed`,
  `lock.changed`, `balance.updated`, `level.progressed`.
- Endpoint `GET /api/events` — SSE-стрим для клиента.

## Схема БД (основные таблицы)

```
settings        — ключ/значение: API-ключи (зашифрованы AES-256-GCM, ключ в ENV),
                  таймзона/время сброса, PIN-хэш
assets          — symbol, leverage, sort_order, is_active
risk_levels     — уровень, risk_usd, required_r (редактируемая лестница)
risk_state      — текущий уровень, накопленные R, активные блокировки (тип, until)
trades          — вся сделка: symbol, side, qty, leverage, entry_price, sl, tp, rr_preset,
                  risk_usd, opened_at, closed_at, close_reason, close_price,
                  result_r, result_pct, mfe_price, be_crossed (bool),
                  bingx_order_ids (jsonb), signals (jsonb)
daily_stats     — агрегат по дню: sum_r, trades_count (для быстрых проверок лимитов)
```

## API (набросок контракта)

```
POST /api/auth/pin              — вход по PIN → сессионная кука
GET  /api/dashboard             — баланс, активы, активная сделка (risk_state/блокировки — этап 3)
GET  /api/price/:symbol         — текущая цена символа (REST по действию, без поллинга)
POST /api/trades                — открыть { symbol, side, quantity, slPrice } → market + SL
GET  /api/trades/active         — активная сделка + живые данные позиции (ликвидация, PnL)
POST /api/trades/:id/takeprofit — { tpPrice | rrPreset } → выставить TP
POST /api/trades/:id/close      — закрыть вручную (этап 3+)
GET  /api/trades                — история с фильтрами (этап 5)
GET  /api/stats                 — агрегаты: время дня прибыльных сделок и т.д. (этап 5)
GET  /api/events                — SSE (этап 4)
GET/POST/PATCH/DELETE /api/admin/* — ключи, активы, параметры риск-плана
```

Контракт стабилен: клиент не знает про BingX напрямую, все специфичные детали — за прослойкой.

## PWA

- `manifest.webmanifest`: name, icons (180/192/512), `display: standalone`, theme-color.
- iOS-мета: `apple-mobile-web-app-capable`, `apple-touch-icon`.
- Service worker: кэш статики (app shell). API не кэшируем — торговые данные всегда живые.
- Нижняя таб-навигация (Дашборд · История · Админка) — под большой палец.

## Безопасность

- API-ключи BingX только на сервере, в БД — зашифрованы (ключ шифрования в Railway ENV).
- Вход в PWA по PIN → httpOnly session cookie. Все `/api/*` кроме auth — под сессией.
- Rate limit на auth endpoint.

## Стратегия «без поллинга»

| Данные | Механизм |
|---|---|
| Цены активов | WS market stream → SSE (throttle ~1 сообщение/сек на клиента) |
| Статус ордеров/позиции | WS account stream (ACCOUNT_UPDATE / ORDER_TRADE_UPDATE) |
| Закрытие по SL/TP | ACCOUNT_UPDATE + одиночная REST-сверка деталей (событийно) |
| Баланс | ACCOUNT_UPDATE |
| Блокировки/таймеры | Считаются на сервере, отдаются событием + дедлайном; клиент рисует таймер локально |
