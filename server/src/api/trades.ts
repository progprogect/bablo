import type { FastifyInstance } from "fastify";
import { requireAuth } from "./plugins/auth-guard.js";
import { openTrade, setTakeProfit, closeTrade, getActiveTradeView, TradeError } from "../trades/service.js";
import type { TradeSide } from "../trades/math.js";
import { listClosedTrades, type Trade } from "../db/repositories/trades.js";
import { resolveTradeOutcome, type TradeOutcome } from "../history/outcome.js";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

function isTradeSide(value: unknown): value is TradeSide {
  return value === "long" || value === "short";
}

/** Строка истории + фактический исход сделки для подписи в UI. */
function withOutcome(trade: Trade): Trade & { outcome: TradeOutcome } {
  return {
    ...trade,
    outcome: resolveTradeOutcome(
      {
        closeReason: trade.closeReason,
        entryPrice: trade.entryPrice !== null ? Number(trade.entryPrice) : null,
        slPrice: trade.slPrice !== null ? Number(trade.slPrice) : null,
        side: trade.side,
        statsOutcome: trade.statsOutcome,
      },
      trade.resultR !== null ? Number(trade.resultR) : 0,
    ),
  };
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
