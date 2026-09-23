/** Типы контракта /api/journal/* — зеркало server/src/journal (routes.ts, view.ts, logic.ts). */

export type TradeSide = "long" | "short";
export type TradeOutcome = "tp" | "sl" | "be" | "other";
export type AnswerType = "yes_no" | "scale_0_10" | "stars_0_5" | "choice" | "text";
export type AnswerValue = boolean | number | string;

export type JournalOverview = {
  unsortedCount: number;
  categories: { id: number; name: string; tradesCount: number; itemsCount: number }[];
};

export type JournalTradeCard = {
  id: number;
  symbol: string;
  side: TradeSide;
  openedAt: string;
  closedAt: string | null;
  entryPrice: number | null;
  /** Стоп ПРИ ВХОДЕ (восстановлен из исходного риска — текущий стоп могли подтянуть). */
  initialSlPrice: number | null;
  /** Тейк по плану входа. */
  plannedTpPrice: number | null;
  plannedRR: number | null;
  outcome: TradeOutcome;
  /** Фактический R — тот же, что во всей статистике терминала. */
  statsResultR: number | null;
  resultUsd: number | null;
  categoryId: number | null;
};

export type JournalTradeDetail = JournalTradeCard & {
  quantity: number | null;
  leverage: number;
  riskUsd: number | null;
  closePrice: number | null;
  closeReason: string | null;
  resultR: number | null;
  resultPct: number | null;
  finalSlPrice: number | null;
  plannedProfitUsd: number | null;
  marginUsd: number | null;
  mfePrice: number | null;
  mfeR: number | null;
  beCrossed: boolean;
};

export type EntryAnswer = {
  itemId: number;
  label: string;
  answerType: AnswerType;
  itemArchived: boolean;
  value: AnswerValue | null;
};

export type EntryBlock = {
  categoryId: number;
  categoryName: string;
  categoryArchived: boolean;
  categorizedAt: string;
  updatedAt: string;
  answers: EntryAnswer[];
};

export type TradeDetailResponse = {
  trade: JournalTradeDetail;
  entry: EntryBlock | null;
};

export type PagedJournalTrades = {
  trades: JournalTradeCard[];
  total: number;
};

export type ConstructorItem = {
  id: number;
  label: string;
  answerType: AnswerType;
  /** Только для answerType='choice': варианты ответа (фиксируются при создании). */
  options?: string[];
  hasAnswers: boolean;
};

export type ConstructorCategory = {
  id: number;
  name: string;
  entriesCount: number;
  items: ConstructorItem[];
};

export type AnalysisColumn = {
  itemId: number;
  label: string;
  answerType: AnswerType;
  options?: string[];
  archived: boolean;
};

export type AnalysisRow = {
  tradeId: number;
  symbol: string;
  side: TradeSide;
  closedAt: string | null;
  outcome: TradeOutcome;
  statsResultR: number | null;
  resultUsd: number | null;
  answers: Record<number, AnswerValue>;
};

export type ColumnAggregate =
  | { kind: "yes_no"; yesCount: number; total: number }
  | { kind: "scale"; average: number | null; total: number }
  | { kind: "choice"; top: { value: string; count: number } | null; total: number }
  | { kind: "text"; total: number };

export type AnalysisResponse = {
  category: { id: number; name: string; archived: boolean };
  columns: AnalysisColumn[];
  rows: AnalysisRow[];
  // Агрегаты «В плюсе/В минусе» клиент считает сам по отфильтрованным строкам
  // (CategoryTable.tsx#aggregateGroup) — сервер их не шлёт с появлением фильтров.
};

export type ChartCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type ChartDrawing = { id: string; t1: number; p1: number; t2: number; p2: number };

export type PriceLevel = { price: number; touches: number; kind: "support" | "resistance" | "mixed" };
export type ConsolidationZone = { fromTime: number; toTime: number; high: number; low: number };
export type StructureBreak = { time: number; price: number; direction: "up" | "down" };
export type Engulfing = { index: number; time: number; direction: "bull" | "bear" };

export type PriceStructure = {
  levels: PriceLevel[];
  zones: ConsolidationZone[];
  breaks: StructureBreak[];
  engulfings: Engulfing[];
};

export type TradeChartResponse = {
  interval: "15m" | "1h";
  stepMs: number;
  range: { fromMs: number; toMs: number };
  candles: ChartCandle[];
  structure?: PriceStructure;
  drawings: ChartDrawing[];
};

export type ExtendChartResponse = TradeChartResponse & { added: number; exhausted: boolean };
