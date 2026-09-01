import type { FastifyInstance } from "fastify";
import { requireAuth } from "./plugins/auth-guard.js";
import { openTrade, setTakeProfit, closeTrade, getActiveTradeView, TradeError } from "../trades/service.js";
import type { TradeSide } from "../trades/math.js";
import { listClosedTrades, listClosedTradesBetween, type Trade } from "../db/repositories/trades.js";
import { getBingxCredentials, getRiskSettings } from "../db/repositories/settings.js";
import { getIncomeHistory, type BingXCredentials, type BingXIncomeRecord } from "../bingx/client.js";
import { summarizeIncome, type IncomeSummary } from "../history/incomeSummary.js";
import { localMonthUtcRange } from "../history/monthlyStats.js";
import { resolveStatsResultR, resolveTradeOutcome, type TradeOutcome } from "../history/outcome.js";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function isTradeSide(value: unknown): value is TradeSide {
  return value === "long" || value === "short";
}

/**
 * Строка истории + фактический исход и фактический R сделки для UI.
 *
 * `statsResultR` — тот же R, что идёт во всю статистику (с учётом ручного столбца R из
 * админки). Считает сервер, чтобы карточка в Истории и цифры в отчётах не могли разойтись.
 */
function withOutcome(trade: Trade): Trade & { outcome: TradeOutcome; statsResultR: number | null } {
  const resultR = trade.resultR !== null ? Number(trade.resultR) : null;
  const outcome = resolveTradeOutcome(
    {
      closeReason: trade.closeReason,
      entryPrice: trade.entryPrice !== null ? Number(trade.entryPrice) : null,
      slPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
      side: trade.side,
      statsOutcome: trade.statsOutcome,
    },
    resultR ?? 0,
  );
  return {
    ...trade,
    outcome,
    statsResultR: resolveStatsResultR({ statsRrPreset: trade.statsRrPreset, resultR }, outcome),
  };
}

/** До 1000 записей за запрос у BingX — догружаем месяц страницами по time (кап — 5 страниц). */
async function listIncomeForRange(
  credentials: BingXCredentials,
  fromMs: number,
  toMs: number,
): Promise<BingXIncomeRecord[]> {
  const PAGE_LIMIT = 1000;
  const MAX_PAGES = 5;
  const all: BingXIncomeRecord[] = [];
  let startTime = fromMs;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await getIncomeHistory(credentials, { startTime, endTime: toMs, limit: PAGE_LIMIT });
    all.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    const lastTime = Math.max(...batch.map((record) => record.time));
    if (!(lastTime >= startTime)) break;
    startTime = lastTime + 1;
  }
  return all;
}

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/trades/active", async () => {
    return getActiveTradeView();
  });

  app.get<{ Querystring: { limit?: string; offset?: string } }>("/trades", async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const page = await listClosedTrades({ limit, offset });
    // Исход считает сервер (history/outcome.ts), а не клиент: та же трактовка, что в
    // статистике и дневных лимитах — иначе подпись в истории разошлась бы с цифрами.
    return { ...page, trades: page.trades.map(withOutcome) };
  });

  // Все сделки одного локального месяца (детализация карточки в «Статистике»). Границы
  // месяца — те же, что у группировки monthlyStats (localMonthUtcRange), иначе сделка
  // на стыке месяцев попала бы в карточку одного месяца, а в список — другого.
  // Дополнительно — ФАКТ начислений BingX за месяц (комиссии/funding/переводы/PnL)
  // для сверки, best-effort: без него детализация работает, exchange = null.
  app.get<{ Querystring: { year?: string; month?: string } }>(
    "/trades/month",
    async (request, reply) => {
      const year = Number(request.query.year);
      const month = Number(request.query.month);
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        reply.code(400).send({ error: "Укажите year и month (1–12)" });
        return;
      }
      const { tzOffsetMinutes } = await getRiskSettings();
      const { from, to } = localMonthUtcRange(year, month, tzOffsetMinutes);
      const rows = await listClosedTradesBetween(from, to);

      let exchange: IncomeSummary | null = null;
      try {
        const credentials = await getBingxCredentials();
        if (credentials) {
          const records = await listIncomeForRange(credentials, from.getTime(), to.getTime());
          const summary = summarizeIncome(records);
          // Пустой ответ при наличии сделок — глубина хранения BingX закончилась,
          // а не «месяц без комиссий»: сверку не показываем, чтобы не врать нулями.
          exchange = summary.recordCount > 0 ? summary : null;
        }
      } catch (error) {
        request.log.warn({ err: error }, "не удалось получить начисления BingX за месяц");
      }

      return { trades: rows.map(withOutcome), exchange };
    },
  );

  app.post<{ Body: { symbol?: string; side?: string; quantity?: number; slPrice?: number } }>(
    "/trades",
    async (request, reply) => {
      const { symbol, side, quantity, slPrice } = request.body ?? {};

      if (!symbol || !isTradeSide(side) || typeof quantity !== "number" || typeof slPrice !== "number") {
        reply.code(400).send({ error: "Укажите symbol, side ('long'|'short'), quantity и slPrice" });
        return;
      }

      try {
        const result = await openTrade({ symbol, side, quantity, slPrice });
        reply.code(201);
        return result;
      } catch (error) {
        if (error instanceof TradeError) {
          reply.code(error.status).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { tpPrice?: number; rrPreset?: string; partialTpPrice?: number };
  }>(
    "/trades/:id/takeprofit",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        reply.code(400).send({ error: "Некорректный id" });
        return;
      }

      try {
        return await setTakeProfit(id, request.body ?? {});
      } catch (error) {
        if (error instanceof TradeError) {
          reply.code(error.status).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/trades/:id/close", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      reply.code(400).send({ error: "Некорректный id" });
      return;
    }

    try {
      return await closeTrade(id);
    } catch (error) {
      if (error instanceof TradeError) {
        reply.code(error.status).send({ error: error.message });
        return;
      }
      throw error;
    }
  });
}
