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
  risk: RiskSnapshot;
};

export type BingxKeyStatus = {
  configured: boolean;
};

export type OpenTradeResult = {
  trade: Trade;
  slWarning: string | null;
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

export type PeriodKey = "night" | "morning" | "day" | "evening";

export type PeriodStats = {
  key: PeriodKey;
  totalTrades: number;
  profitableTrades: number;
  winRate: number;
};

export type TimeOfDayStats = {
  periods: PeriodStats[];
  bestPeriod: PeriodKey | null;
};
