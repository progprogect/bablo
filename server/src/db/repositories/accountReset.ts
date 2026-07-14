import { getDb } from "../client.js";
import { dailyStats, riskLocks, riskState, trades } from "../schema.js";

/**
 * Полный сброс данных, привязанных к конкретному BingX-аккаунту: история сделок,
 * дневная статистика, активные блокировки и прогресс риск-плана (уровень/накопленный R).
 * Настройки риск-плана, лестница уровней, активы и PIN не трогаются — это конфигурация
 * приложения, а не данные аккаунта. Вызывающий код обязан убедиться, что нет активной
 * сделки — эта функция не проверяет и не закрывает позиции на бирже.
 */
export async function resetAccountData(): Promise<{ tradesDeleted: number }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const deletedTrades = await tx.delete(trades).returning({ id: trades.id });
    await tx.delete(riskLocks);
    await tx.delete(dailyStats);
    await tx.delete(riskState);
    return { tradesDeleted: deletedTrades.length };
  });
}
