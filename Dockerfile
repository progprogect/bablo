# Образ для Fly.io (ноябрь 2026). Railway и Render собирают приложение своими
# билдерами по railway.json / render.yaml — этот файл нужен только Fly, который
# деплоит контейнерами. Подробности про хостинг — в docs/DEPLOY.md.

# --- сборка: нужны devDependencies (vite, tsc) ---
FROM node:22-slim AS build
WORKDIR /app
# Сначала манифесты — слой с npm ci переиспользуется, пока зависимости не менялись.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci
COPY . .
RUN npm run build

# --- рантайм: только прод-зависимости и собранные артефакты ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev && npm cache clean --force
# Сервер отдаёт статику клиента по пути ../../client/dist относительно server/dist,
# поэтому раскладка папок должна повторять репозиторий.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
# Миграции drizzle ищутся по относительному пути "./drizzle" от рабочей директории —
# отсюда и WORKDIR ниже, и копирование папки рядом с dist.
COPY --from=build /app/server/drizzle ./server/drizzle
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
