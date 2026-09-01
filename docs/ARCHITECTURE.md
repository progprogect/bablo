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
- **Поиск исполнившегося SL/TP вынесен в `realtime/filledOrder.ts`** (без зависимостей от
  `trades/`, чтобы не было цикла service ↔ reconcile). Им пользуются все пути, где нужно
  понять причину закрытия: сверка по ACCOUNT_UPDATE, ручное закрытие при уже закрытой
  позиции, разовая сверка при старте сервера и досверка по загрузке дашборда
  (`reconcileActiveTradeIfExchangeFlat` в manager.ts — когда ACCOUNT_UPDATE потерян при
  РАБОТАЮЩЕМ сервере и дашборд видит positionFlat; fire-and-forget, по завершении клиент
  обновляется через SSE-refresh, дубли гасятся in-flight флагом). Раньше в этом случае
  сделка висела «активной» до ручного «Закрыть», а причина записывалась как `external` —
  и выпадала из статистики и дневных лимитов (правки от 13.08 и 15.08.2026).
- **Баг №1 найден и исправлен 16.07.2026**: `GET /openApi/swap/v2/trade/order` у BingX (как
  и ответ `placeOrder`) оборачивает данные в `{ data: { order: {...} } }`, а не отдаёт поля
  ордера прямо в `data`. `getOrderStatus` в `bingx/client.ts` этого не учитывал — `status`
  всегда был `undefined`.
- **Баг №2 найден и исправлен 16.07.2026**: даже после фикса №1 точечный лукап ордера по
  `orderId` (`GET .../trade/order`) у BingX ненадёжен для STOP_MARKET/TAKE_PROFIT_MARKET
  (условных/trigger) ордеров — после срабатывания он может отдавать «order not exist» по
  исходному orderId (задокументированная особенность BingX). Из-за обоих багов REST-сверка
  (`reconcilePositionFlat`) практически никогда не могла определить, какой из SL/TP сработал,
  и почти всегда помечала закрытие как `"external"`, даже когда сделка реально закрылась по
  стопу/тейку — это искажало все инсайты и месячную статистику, завязанные на `closeReason`.
  Исправление: `findFilledSlOrTp` (`realtime/reconcile.ts`) сначала сканирует историю ордеров
  символа (`getOrderHistory` → `GET .../trade/allOrders`, окно от `openedAt` сделки до сейчас,
  максимум 7 дней — ограничение BingX) и ищет в списке нужный `orderId` — это надёжнее
  точечного лукапа для condition-ордеров. Точечный `getOrderStatus` остаётся запасным путём,
  если ордер почему-то не попал в список истории (лимит 500 записей на очень активном
  символе). Для восстановления уже закрытых "external"-сделок есть админ-эндпоинт
  `POST /admin/reclassify-trades` (`trades/reclassify.ts`) — использует ту же логику поиска
  и чинит `closeReason`/результат там, где BingX ещё хранит данные по ордеру.

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

### Web Push (`server/src/push`)
- Уведомление «Сделка закрыта» на устройства через Web Push (`web-push`), вызывается из
  `finalizeTradeClose` fire-and-forget — сбой рассылки не влияет на закрытие сделки.
- Всё состояние в kv-таблице `settings`, без миграций: `push_vapid_keys` (генерируются
  один раз при первом обращении; потерять их = потерять все подписки) и
  `push_subscriptions` (список `PushSubscription.toJSON()` устройств, дедуп по endpoint).
- Протухшие подписки (404/410 от push-сервиса) удаляются при отправке.
- Текст уведомления использует ту же логику исхода, что и статистика
  (`resolveTradeOutcome` + `roundStatsR`) — цифры в пуше и в приложении совпадают.

### Деплой (Railway)
- Один сервис из корня монорепо: собирает и клиент, и сервер (`npm run build`).
- **Watch Paths: НЕ задавать нигде** — ни в railway.json, ни в UI сервиса (там выставлено
  пусто; проверять при изменении настроек). Пусто = деплой на любой коммит в main.
  История граблей (21.08.2026): в UI стояло `/client/**` — чисто серверные коммиты Railway
  молча пропускал (`SKIPPED`), правки риск-движка не доезжали до прода. Попытка задать
  `watchPatterns: ["/**"]` в railway.json сделала хуже: файл перебивает UI, а паттерн
  `/**` их матчер не понимает (не матчит ничего) — пропускались уже ВСЕ коммиты.
- `releaseCommand` из railway.json Railway фактически не применяет (в манифесте
  `preDeployCommand: null`); миграции гарантируются на старте сервера (`runMigrations()`
  до `listen`, ошибка фатальна) — это и есть рабочий путь.

## Схема БД (основные таблицы)

```
settings        — ключ/значение: API-ключи (зашифрованы AES-256-GCM, ключ в ENV),
                  таймзона/время сброса, PIN-хэш, VAPID-ключи и push-подписки устройств
assets          — symbol, leverage, sort_order, is_active
risk_levels     — уровень, risk_usd, required_r (редактируемая лестница)
risk_state      — текущий уровень, накопленные R, активные блокировки (тип, until)
trades          — вся сделка: symbol, side, qty, leverage, entry_price, sl, tp, rr_preset,
                  stats_outcome (ручной исход для статистики: tp/sl/be, null — авто),
                  risk_usd, opened_at, closed_at, close_reason, close_price,
                  result_r, result_pct, mfe_price, be_crossed (bool),
                  bingx_order_ids (jsonb), signals (jsonb)
daily_stats     — агрегат по дню: sum_r, trades_count, sl_count, tp_count,
                  strong_recovery_after_sl (для быстрых проверок дневных лимитов:
                  2 стопа / 2 тейка / сильный откуп ≥2R после стопа)
equity_snapshots — снимок эквити на календарный день (date, equity), один в день, лениво
                   создаётся при загрузке дашборда — якорь для "% к депозиту" в /api/stats
equity_adjustments — ручные пополнения/выводы (date, amount_usd: + пополнение, − вывод,
                   note) — заполняются в админке; учитываются при восстановлении баланса
                   прошлых месяцев "в обратную сторону" от последнего снимка эквити
                   (history/monthlyStats.ts), см. docs/PROJECT.md
```

## API (набросок контракта)

```
POST /api/auth/pin              — вход по PIN → сессионная кука
GET  /api/dashboard             — баланс, активы, активная сделка, внешние позиции BingX (risk_state/блокировки — этап 3)
GET  /api/price/:symbol         — текущая цена символа (REST по действию, без поллинга)
POST /api/trades                — открыть { symbol, side, quantity, slPrice } → market + SL
GET  /api/trades/active         — активная сделка + живые данные позиции (ликвидация, PnL)
POST /api/trades/:id/takeprofit — { tpPrice | rrPreset } → выставить TP
POST /api/trades/:id/close      — закрыть вручную (этап 3+)
GET  /api/trades                — история (пагинация limit/offset), сначала новые
GET  /api/trades/month          — ?year&month: все сделки локального месяца (границы —
                                   localMonthUtcRange, как в группировке monthlyStats);
                                   детализация карточки месяца в «Статистике»
GET  /api/stats                 — { insights, monthly }: инсайты по часам открытия/пресетам/
                                   дневной цели (history/insights.ts) и месячная статистика
                                   (history/monthlyStats.ts), см. docs/PROJECT.md
GET  /api/stats/equity-history  — [{ date, equity }] по всем снимкам equity_snapshots,
                                   по возрастанию даты — данные для графика роста депозита
GET  /api/events                — SSE (этап 4)
GET/POST/PATCH/DELETE /api/admin/* — ключи, активы, параметры риск-плана
GET/POST/DELETE /api/admin/equity-adjustments — пополнения/выводы (date, amountUsd, note)
POST /api/admin/reclassify-trades — пересверка "external"-сделок с BingX (см. выше)
POST /api/admin/trades/:id/stats-outcome — ручной исход сделки для статистики
                                   ('tp' | 'sl' | 'be' | null — авто); closeReason не меняет
GET  /api/push/public-key       — публичный VAPID-ключ для подписки на push
POST /api/push/subscribe        — { subscription } — регистрация устройства
POST /api/push/unsubscribe      — { endpoint } — снятие подписки устройства
```

Контракт стабилен: клиент не знает про BingX напрямую, все специфичные детали — за прослойкой.

## PWA

- `manifest.webmanifest`: name, icons (180/192/512), `display: standalone`, theme-color.
- iOS-мета: `apple-mobile-web-app-capable`, `apple-touch-icon`.
- Service worker — собственный `client/src/sw.ts` (`strategies: "injectManifest"` в
  vite-plugin-pwa, 30.08.2026; раньше generateSW): то же кэширование статики (app shell,
  API не кэшируем — торговые данные всегда живые) плюс обработчики `push` /
  `notificationclick` для уведомлений о закрытии сделки. На iPhone push работает только
  из PWA с экрана «Домой» (iOS 16.4+).
- Звук о закрытии в открытом приложении — `client/src/lib/chime.ts` (Web Audio, два тона,
  без аудиофайла; AudioContext разблокируется первым касанием) по SSE `refresh
  { reason: "trade.closed" }`, слушает `components/TradeCloseChime.tsx` на уровне App.
- Нижняя таб-навигация (Дашборд · История) — под большой палец. Админка доступна только
  прямым переходом по `/admin`, в меню не выведена (см. `client/src/components/navTabs.tsx`).

## Безопасность

- API-ключи BingX только на сервере, в БД — зашифрованы (ключ шифрования в Railway ENV).
- Вход в PWA по PIN → httpOnly session cookie. Все `/api/*` кроме auth — под сессией.
- Rate limit на auth endpoint.
- Приложение однопользовательское и не привязывает данные к аккаунту (нет `accountId`). При
  смене BingX-ключей на другой аккаунт старые `trades`/`risk_state`/`daily_stats`/`risk_locks`
  не сбрасываются автоматически — админка даёт кнопку «Очистить данные для нового аккаунта»
  (`POST /api/admin/reset-account-data`), которая работает только при отсутствии активной
  сделки и не трогает позиции на бирже.

## Стратегия «без поллинга»

| Данные | Механизм |
|---|---|
| Цены активов | WS market stream → SSE (throttle ~1 сообщение/сек на клиента) |
| Статус ордеров/позиции | WS account stream (ACCOUNT_UPDATE / ORDER_TRADE_UPDATE) |
| Закрытие по SL/TP | ACCOUNT_UPDATE + одиночная REST-сверка деталей (событийно) |
| Баланс | ACCOUNT_UPDATE |
| Блокировки/таймеры | Считаются на сервере, отдаются событием + дедлайном; клиент рисует таймер локально |
