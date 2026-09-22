import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { registerHealthRoutes } from "./api/health.js";
import { registerAuthRoutes } from "./api/auth.js";
import { registerAdminRoutes } from "./api/admin.js";
import { registerDashboardRoutes } from "./api/dashboard.js";
import { registerTradeRoutes } from "./api/trades.js";
import { registerPriceRoutes } from "./api/price.js";
import { registerEventsRoutes } from "./api/events.js";
import { registerStatsRoutes } from "./api/stats.js";
import { registerRiskRoutes } from "./api/risk.js";
import { registerPushRoutes } from "./api/push.js";
import { registerWithdrawalRoutes } from "./api/withdrawals.js";
import { registerPauseRoutes } from "./api/pause.js";
import { registerJournalRoutes } from "./journal/routes.js";
import { env } from "./config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/ и dist/ находятся на одном уровне внутри server/, поэтому путь одинаков
// как в dev-режиме (tsx), так и после сборки.
const clientDistPath = path.resolve(__dirname, "../../client/dist");

export function buildApp() {
  const app = Fastify({
    logger: {
      level: env.isProduction ? "info" : "debug",
    },
  });

  app.register(fastifyCookie);
  // global: false — лимит применяется только там, где явно указан config.rateLimit
  // (эндпоинты входа по PIN), остальные маршруты не ограничиваются по умолчанию.
  app.register(fastifyRateLimit, { global: false });

  // Страховка от утечки внутренних деталей (например, полей ответа BingX) наружу
  // при непредвиденных ошибках — маршруты сами оборачивают ожидаемые ошибки.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(statusCode).send({
      error: statusCode < 500 ? error.message : "Внутренняя ошибка сервера",
    });
  });

  app.register(registerHealthRoutes, { prefix: "/api" });
  app.register(registerAuthRoutes, { prefix: "/api" });
  app.register(registerAdminRoutes, { prefix: "/api" });
  app.register(registerDashboardRoutes, { prefix: "/api" });
  app.register(registerTradeRoutes, { prefix: "/api" });
  app.register(registerPriceRoutes, { prefix: "/api" });
  app.register(registerEventsRoutes, { prefix: "/api" });
  app.register(registerStatsRoutes, { prefix: "/api" });
  app.register(registerRiskRoutes, { prefix: "/api" });
  app.register(registerPushRoutes, { prefix: "/api" });
  app.register(registerWithdrawalRoutes, { prefix: "/api" });
  app.register(registerPauseRoutes, { prefix: "/api" });
  app.register(registerJournalRoutes, { prefix: "/api" });

  const clientBuildExists = existsSync(path.join(clientDistPath, "index.html"));

  if (clientBuildExists) {
    app.register(fastifyStatic, {
      root: clientDistPath,
      index: "index.html",
    });
  } else {
    app.log.warn(
      `Client build not found at ${clientDistPath} — API-only mode (run "npm run build:client" or client dev server separately).`,
    );
  }

  // SPA fallback: любой не-/api маршрут отдаёт index.html, роутинг — на клиенте.
  // Журнал (/journal…) — отдельная точка входа со своим бандлом, манифестом и палитрой
  // (PWA «Bablo.Дневник»): его пути получают journal.html. Ссылок между терминалом и
  // журналом нет ни в одну сторону — попасть в журнал можно только прямым URL.
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api")) {
      reply.code(404).send({ error: "Not Found" });
      return;
    }
    if (clientBuildExists) {
      // Путь без query: /journal?x=1 — тоже журнал (url в raw содержит query string).
      const pathOnly = (request.raw.url ?? "").split("?")[0] ?? "";
      const isJournal = pathOnly === "/journal" || pathOnly.startsWith("/journal/");
      reply.sendFile(isJournal ? "journal.html" : "index.html", clientDistPath);
      return;
    }
    reply.code(404).send({ error: "Client build not found" });
  });

  return app;
}
