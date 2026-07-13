# Bablo

Личный минималистичный торговый терминал-прослойка для BingX (USDT-M Perpetual Futures)
с принудительным соблюдением риск-плана. PWA для iPhone, деплой на Railway.

## Документация

- [Описание продукта](docs/PROJECT.md) — что это, экраны, флоу открытия сделки
- [Риск-движок](docs/RISK_ENGINE.md) — лестница уровней, дневные лимиты, геймификация
- [Архитектура](docs/ARCHITECTURE.md) — стек, модули, схема БД, API, realtime без поллинга
- [Roadmap](docs/ROADMAP.md) — этапы разработки с критериями приёмки

## Структура репозитория

```
bablo/
├── docs/           # документация проекта (источник правды)
├── client/         # React + Vite PWA (Tailwind, react-router)
├── server/         # Fastify API + раздача статики клиента + Drizzle/PostgreSQL
├── railway.json    # конфигурация деплоя Railway
└── package.json    # npm workspaces (общие скрипты)
```

## Локальная разработка

Требуется Node.js 22+ (см. `.nvmrc`) и локальный PostgreSQL (для этапов с БД).

```bash
npm install

# Копируем и заполняем переменные окружения
cp .env.example .env

# Разработка: сервер и клиент отдельно (Vite проксирует /api на сервер)
npm run dev:server   # http://localhost:3000
npm run dev:client   # http://localhost:5173

# Проверка типов всего монорепо
npm run typecheck

# Юнит-тесты чистой логики (риск-движок и т.д.)
npm run test

# Продакшн-сборка (клиент + сервер) и запуск как в проде
npm run build
npm start            # раздаёт собранный клиент + API на PORT (по умолчанию 3000)
```

### База данных (Drizzle)

```bash
npm run db:generate  # сгенерировать SQL-миграцию из server/src/db/schema.ts
npm run db:migrate    # применить миграции к DATABASE_URL
```

## Деплой на Railway

1. Создать проект на Railway, подключить этот репозиторий.
2. Добавить плагин **PostgreSQL** — Railway автоматически пробросит `DATABASE_URL`.
3. `railway.json` уже описывает сборку и старт:
   - build: `npm ci && npm run build`
   - release (перед каждым деплоем): `npm run db:migrate`
   - start: `npm run start`
   - healthcheck: `GET /api/health`
4. Задеплоить — Railway выдаст публичный HTTPS-домен.

## Установка как PWA на iPhone

1. Открыть публичный URL Railway в Safari на iPhone.
2. Нажать «Поделиться» → **«На экран Домой»**.
3. Приложение откроется в standalone-режиме (без адресной строки Safari), без Apple-подписи —
   через встроенный `manifest.webmanifest` и Apple-мета-теги.

## Статус разработки

- [x] Этап 0 — скелет проекта, деплой, PWA
- [x] Этап 1 — админка: ключи и активы
- [x] Этап 2 — открытие сделки (ядро)
- [x] Этап 3 — риск-движок
- [x] Этап 4 — realtime без поллинга
- [x] Этап 5 — история и статистика
- [x] Этап 6 — геймификация: дерево роста
- [x] Этап 7 — расширенный трекинг (сигналы — набор уточняется отдельно)

Подробности и критерии приёмки — в [ROADMAP.md](docs/ROADMAP.md).
