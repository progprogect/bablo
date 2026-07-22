import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { runMigrations } from "./db/runMigrations.js";
import { ensureSeedAssets } from "./db/repositories/assets.js";
import { ensureRiskSeeded, resyncTradingDayRisk } from "./risk/service.js";
import { startRealtime } from "./realtime/manager.js";

const app = buildApp();

async function bootstrap() {
  // Гарантируем схему БД перед первым запросом — не полагаемся только на отдельный
  // releaseCommand на Railway (если он не выполнится, приложение иначе поднимется
  // с healthcheck 200, но полностью неработающим API). Идемпотентно, безопасно
  // при каждом рестарте. В отличие от сидов ниже — ошибка здесь фатальна.
  await runMigrations();

  try {
    await ensureSeedAssets();
    await ensureRiskSeeded();
  } catch (error) {
    // БД может быть временно недоступна при рестарте — сервер всё равно должен
    // подняться и ответить на healthcheck; сиды досеются при следующем старте.
    app.log.error({ error }, "Не удалось засеять данные по умолчанию");
  }

  await app.listen({ port: env.port, host: "0.0.0.0" });
  app.log.info(`Server listening on port ${env.port}`);

  try {
    await startRealtime();
  } catch (error) {
    // Реалтайм-стримы не блокируют старт сервера — без них дашборд просто вернётся
    // к точечным REST-запросам (цена, позиция), риск-логика и торговля не зависят от WS.
    app.log.error({ error }, "Не удалось запустить реалтайм-стримы BingX");
  }

  // Пересчитать дневные лимиты по уже закрытым сделкам текущего дня (идемпотентно).
  // Нужно, чтобы фикс недоучёта R при partial и правило +3R применились сразу после
  // деплоя, без ожидания новой сделки.
  try {
    const result = await resyncTradingDayRisk();
    if (result.lockTypes.length > 0 || result.tradesFixed > 0) {
      app.log.info({ resync: result }, "Дневные лимиты пересчитаны при старте");
    }
  } catch (error) {
    app.log.error({ error }, "Не удалось пересчитать дневные лимиты при старте (некритично)");
  }
}

bootstrap().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
