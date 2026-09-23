/** Типы контракта /api/journal/* — зеркало server/src/journal (routes.ts, view.ts, logic.ts). */

export type TradeSide = "long" | "short";
export type TradeOutcome = "tp" | "sl" | "be" | "other";
export type AnswerType = "yes_no" | "scale_0_10" | "stars_0_5" | "text";
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
  | { kind: "text"; total: number };

export type GroupAggregates = {
  tradesCount: number;
  byItem: Record<number, ColumnAggregate>;
};

export type AnalysisResponse = {
  category: { id: number; name: string; archived: boolean };
  columns: AnalysisColumn[];
  rows: AnalysisRow[];
  aggregates: { plus: GroupAggregates; minus: GroupAggregates };
};

export type ChartCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type ChartDrawing = { id: string; t1: number; p1: number; t2: number; p2: number };

export type TradeChartResponse = {
  interval: "15m" | "1h";
  stepMs: number;
  range: { fromMs: number; toMs: number };
  candles: ChartCandle[];
  drawings: ChartDrawing[];
};
