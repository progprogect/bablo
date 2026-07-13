import type { FastifyInstance } from "fastify";
import { listRiskLevels } from "../db/repositories/riskLevels.js";
import { requireAuth } from "./plugins/auth-guard.js";

/**
 * Публичное (в рамках приложения) чтение лестницы уровней — для дерева роста на
 * дашборде (Этап 6). Отдельно от /admin/risk-levels: та же лестница, но здесь
 * только чтение и без семантики "настройки", чтобы не завязывать основной экран
 * на admin-неймспейс.
 */
export async function registerRiskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/risk/levels", { preHandler: requireAuth }, async () => {
    return listRiskLevels();
  });
}
