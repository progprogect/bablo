export type AuthStatus = {
  hasPin: boolean;
  authenticated: boolean;
};

export type Asset = {
  id: number;
  symbol: string;
  leverage: number;
  sortOrder: number;
  isActive: boolean;
};

export type BingXBalance = {
  asset: string;
  balance: string;
  equity: string;
  availableMargin: string;
  unrealizedProfit: string;
};

export type TradeSide = "long" | "short";

export type Trade = {
  id: number;
  symbol: string;
  side: TradeSide;
  status: "active" | "closed";
  quantity: string;
  leverage: number;
  entryPrice: string | null;
  slPrice: string | null;
  tpPrice: string | null;
  rrPreset: string | null;
  riskUsd: string | null;
  partialTpPrice: string | null;
  partialTpPercent: string | null;
  partialTpQuantity: string | null;
  partialTpFilledAt: string | null;
  partialTpFillPrice: string | null;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  closePrice: string | null;
  resultR: string | null;
  resultPct: string | null;
  bingxOrderIds: Record<string, string | number> | null;
  mfePrice: string | null;
  beCrossed: boolean;
  signals: Record<string, unknown> | null;
};

export type ActiveTradeView = Trade & {
  liquidationPrice: number | null;
  unrealizedProfit: number | null;
  positionFlat: boolean;
};

/** Позиция на BingX, открытая не через приложение — без SL/TP/riskUsd, известных нам. */
export type ExternalPosition = {
  symbol: string;
  side: TradeSide;
  quantity: number;
  entryPrice: number;
  leverage: number;
  liquidationPrice: number | null;
  unrealizedProfit: number | null;
};

export type RiskLock = {
  type: string;
  reason: string;
  until: string;
};

export type RiskSnapshot = {
  currentLevel: number;
  levelRiskUsd: number;
  accumulatedR: number;
  requiredR: number | null;
  dailySumR: number;
  hasActiveTrade: boolean;
  activeLocks: RiskLock[];
};

export type DashboardResponse = {
  balance: BingXBalance | null;
  balanceError: string | null;
  assets: Asset[];
  activeTrade: ActiveTradeView | null;
  externalPositions: ExternalPosition[];
  risk: RiskSnapshot;
};

export type BingxKeyStatus = {
  configured: boolean;
};

export type OpenTradeResult = {
  trade: Trade;
  slWarning: string | null;
};

export type SetTakeProfitResult = {
  trade: Trade;
  partialTpWarning: string | null;
};

export type RiskLevel = {
  id: number;
  level: number;
  riskUsd: string;
  requiredR: string;
};

export type RiskSettings = {
  cooldownMinutes: number;
  dailyLossLimitR: number;
  dailyProfitLimitR: number;
  resetHour: number;
  tzOffsetMinutes: number;
};

export type PagedTrades = {
  trades: Trade[];
  total: number;
};

export type PresetOutcome = {
  preset: string;
  totalTrades: number;
  tpCount: number;
  hitRate: number;
  slCount: number;
  avgSlResultR: number;
};

export type TradeInsights = {
  topProfitableHours: { hour: number; tpCount: number; total: number }[];
  topStopHours: { hour: number; count: number }[];
  bestAsset: { symbol: string; tpCount: number; totalTrades: number } | null;
  dailyTargetHour: { targetR: number; hour: number } | null;
  presetOutcomes: PresetOutcome[];
};

export type MonthlyRRPresetCount = { preset: string; count: number };

export type MonthlyStat = {
  year: number;
  month: number;
  totalTrades: number;
  tpCount: number;
  slCount: number;
  beCount: number;
  otherCount: number;
  winRate: number;
  sumR: number;
  sumPositiveR: number;
  sumNegativeR: number;
  resultPct: number | null;
  tradingDays: number;
  daysWithoutTrading: number;
  daysInMonth: number;
  byRRPreset: MonthlyRRPresetCount[];
};

export type StatsResponse = {
  insights: TradeInsights;
  monthly: MonthlyStat[];
};

/** Точка графика роста депозита — один снимок эквити за календарный день. */
export type EquitySnapshot = {
  date: string;
  equity: number;
};
