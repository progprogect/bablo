import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { runMigrations } from "./db/runMigrations.js";
import { ensureSeedAssets } from "./db/repositories/assets.js";
import { ensureRiskSeeded } from "./risk/service.js";
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


}

bootstrap().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
