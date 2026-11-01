import { getOrderHistory, type BingXCredentials } from "../bingx/client.js";
import { listActiveAssets } from "../db/repositories/assets.js";
import { insertImportedTrade, listKnownBingxOrderIds } from "../db/repositories/trades.js";
import { getRiskSettings } from "../db/repositories/settings.js";
import {
  buildTradesFromOrders,
  summarizeHours,
  toImportOrder,
  type ImportedTrade,
  type ImportHourStat,
  type ImportSkip,
} from "./bingxImport.js";

/**
 * I/O-обвязка восстановления истории с BingX: решение, что считать сделкой, — в
 * bingxImport.ts (под тестами), здесь только запросы к бирже, защита от дублей и запись.
 *
 * Работает в два шага НАМЕРЕННО: сначала предпросмотр (ничего не пишет), потом импорт.
 * История восстанавливается один раз и становится основой всей статистики — увидеть, что
 * именно нашлось, нужно до того, как оно окажется в базе.
 */

/** BingX отдаёт историю ордеров окнами; 7 суток — безопасный размер одного запроса. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Сколько дней истории тянуть по умолчанию. Глубину хранения биржа ограничивает сама. */
export const DEFAULT_IMPORT_DAYS = 30;
export const MAX_IMPORT_DAYS = 180;

export type ImportedTradeView = Omit<ImportedTrade, "openedAt" | "closedAt"> & {
  openedAt: string;
  closedAt: string;
  /** Уже есть в базе (ордер входа знаком) — импортирована не будет. */
  duplicate: boolean;
};

export type BingxImportPreview = {
  from: string;
  to: string;
  symbols: string[];
  ordersFetched: number;
  trades: ImportedTradeView[];
  /**
   * Сводка по часам открытия — первый шаг восстановления: прибыльные и убыточные часы
   * видно до того, как история окажется в базе. Считается тем же правилом, что живая
   * гистограмма (history/insights.ts).
   */
  hourly: ImportHourStat[];
  /** Таймзона риск-плана, в которой разложены часы. */
  tzOffsetMinutes: number;
  skipped: ImportSkip[];
  /** Ошибки по конкретным активам — остальные всё равно обрабатываются. */
  errors: { symbol: string; error: string }[];
};

export type BingxImportResult = BingxImportPreview & { imported: number };

/**
 * Чем забирать ордера. По умолчанию — реальный запрос к бирже; подменяется в проверках,
 * чтобы прогнать весь путь «ордера → сделки → база» на выдуманной истории, не трогая
 * боевой аккаунт (правило из CLAUDE.md).
 */
export type OrderFetcher = (
  symbol: string,
  from: number,
  to: number,
) => Promise<Record<string, unknown>[]>;

function defaultFetcher(credentials: BingXCredentials): OrderFetcher {
  return async (symbol, from, to) =>
    (await getOrderHistory(credentials, symbol, from, to)) as unknown as Record<string, unknown>[];
}

function toView(trade: ImportedTrade, duplicate: boolean): ImportedTradeView {
  return {
    ...trade,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt.toISOString(),
    duplicate,
  };
}

/**
 * Собирает историю с биржи и показывает, что из неё получится. Ничего не пишет.
 * `days` — глубина запроса; биржа может отдать меньше, чем просили.
 */
export async function previewBingxImport(
  credentials: BingXCredentials,
  days: number = DEFAULT_IMPORT_DAYS,
  now: Date = new Date(),
  fetchOrders: OrderFetcher = defaultFetcher(credentials),
): Promise<BingxImportPreview> {
  const depth = Math.min(Math.max(Math.trunc(days) || DEFAULT_IMPORT_DAYS, 1), MAX_IMPORT_DAYS);
  const to = now.getTime();
  const from = to - depth * 24 * 60 * 60 * 1000;

  const [assets, known, settings] = await Promise.all([
    listActiveAssets(),
    listKnownBingxOrderIds(),
    getRiskSettings(),
  ]);

  const trades: ImportedTradeView[] = [];
  const skipped: ImportSkip[] = [];
  const errors: { symbol: string; error: string }[] = [];
  let ordersFetched = 0;

  for (const asset of assets) {
    const raw: Record<string, unknown>[] = [];
    for (let windowStart = from; windowStart < to; windowStart += WINDOW_MS) {
      const windowEnd = Math.min(windowStart + WINDOW_MS, to);
      try {
        raw.push(...(await fetchOrders(asset.symbol, windowStart, windowEnd)));
      } catch (error) {
        // Биржа может не отдать глубокое окно — это не повод терять остальные.
        errors.push({
          symbol: asset.symbol,
          error: error instanceof Error ? error.message : "Не удалось получить историю ордеров",
        });
      }
    }

    ordersFetched += raw.length;
    // Один и тот же ордер может прийти в двух соседних окнах — убираем повторы по orderId.
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of raw) {
      const parsed = toImportOrder(item);
      if (parsed) byId.set(parsed.orderId, item);
    }
    const orders = [...byId.values()]
      .map(toImportOrder)
      .filter((order): order is NonNullable<ReturnType<typeof toImportOrder>> => order !== null);

    const built = buildTradesFromOrders(orders);
    skipped.push(...built.skipped);
    for (const trade of built.trades) {
      const duplicate = trade.orderIds.entry.some((id) => known.has(id));
      trades.push(toView(trade, duplicate));
    }
  }

  trades.sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : 0));

  // Сводка — по ВСЕМ собранным сделкам, включая уже известные базе: час описывает
  // поведение рынка и твоё поведение в нём, а не состояние импорта.
  const hourly = summarizeHours(
    trades.map((trade) => ({
      ...trade,
      openedAt: new Date(trade.openedAt),
      closedAt: new Date(trade.closedAt),
    })),
    settings.tzOffsetMinutes,
  );

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    symbols: assets.map((asset) => asset.symbol),
    ordersFetched,
    trades,
    hourly,
    tzOffsetMinutes: settings.tzOffsetMinutes,
    skipped,
    errors,
  };
}

/**
 * Импорт: тот же сбор, что в предпросмотре, плюс запись новых сделок. Повторный запуск
 * безопасен — сделки с уже известным ордером входа пропускаются.
 *
 * Плечо берётся из текущих настроек актива: биржа в журнале ордеров его не отдаёт. На
 * деньги и R это не влияет (они считаются от цен и объёма), только на подпись в карточке.
 */
export async function runBingxImport(
  credentials: BingXCredentials,
  days: number = DEFAULT_IMPORT_DAYS,
  now: Date = new Date(),
  fetchOrders: OrderFetcher = defaultFetcher(credentials),
): Promise<BingxImportResult> {
  const preview = await previewBingxImport(credentials, days, now, fetchOrders);
  const assets = await listActiveAssets();
  const leverageOf = new Map(assets.map((asset) => [asset.symbol, asset.leverage]));

  let imported = 0;
  for (const trade of preview.trades) {
    if (trade.duplicate) continue;
    await insertImportedTrade({
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      leverage: leverageOf.get(trade.symbol) ?? 1,
      entryPrice: trade.entryPrice,
      slPrice: trade.slPrice,
      riskUsd: trade.riskUsd,
      openedAt: new Date(trade.openedAt),
      closedAt: new Date(trade.closedAt),
      closeReason: trade.closeReason,
      closePrice: trade.closePrice,
      resultR: trade.resultR,
      resultPct: trade.resultPct,
      bingxOrderIds: { entry: trade.orderIds.entry, exit: trade.orderIds.exit, source: "import" },
    });
    imported += 1;
  }

  return { ...preview, imported };
}
