import type {
  ActiveTradeView,
  Asset,
  AuthStatus,
  BingxKeyStatus,
  DashboardResponse,
  BingXBalance,
  EquitySnapshot,
  OpenTradeResult,
  PagedTrades,
  RiskLevel,
  RiskSettings,
  SetTakeProfitResult,
  StatsResponse,
  Trade,
  TradeSide,
} from "./types";

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? "Запрос не выполнен";
    throw new ApiError(message);
  }

  return body as T;
}

// --- Аутентификация ---

export const getAuthStatus = () => request<AuthStatus>("/auth/status");

export const setupPin = (pin: string) =>
  request<{ authenticated: boolean }>("/auth/setup", {
    method: "POST",
    body: JSON.stringify({ pin }),
  });

export const loginPin = (pin: string) =>
  request<{ authenticated: boolean }>("/auth/pin", {
    method: "POST",
    body: JSON.stringify({ pin }),
  });

export const logout = () => request<{ authenticated: boolean }>("/auth/logout", { method: "POST" });

// --- Дашборд ---

export const getDashboard = () => request<DashboardResponse>("/dashboard");

// --- Админка: ключи BingX ---

export const getBingxKeyStatus = () => request<BingxKeyStatus>("/admin/bingx-key");

export const saveBingxKey = (apiKey: string, secretKey: string) =>
  request<{ configured: boolean; balance: BingXBalance }>("/admin/bingx-key", {
    method: "POST",
    body: JSON.stringify({ apiKey, secretKey }),
  });

/** Полный сброс истории сделок и прогресса риск-плана — перед подключением другого аккаунта. */
export const resetAccountData = () =>
  request<{ ok: boolean; tradesDeleted: number }>("/admin/reset-account-data", {
    method: "POST",
    body: JSON.stringify({}),
  });

export type ReclassifyTradeDetail = {
  tradeId: number;
  symbol: string;
  openedAt: string;
  fixed: boolean;
  fixedAs?: "sl" | "tp";
  orderIds: Record<string, string | number>;
  historyOrdersCount: number;
  historyError: string | null;
  slFoundInHistory: { orderId: string | number; status: string } | null;
  tpFoundInHistory: { orderId: string | number; status: string } | null;
  slStatusLookup: { status: string | null; error: string | null } | null;
  tpStatusLookup: { status: string | null; error: string | null } | null;
  historyOrders: unknown[];
};

/**
 * Повторная сверка сделок, закрытых как "external", с BingX — чинит closeReason/результат
 * там, где раньше не удалось точно определить SL/TP (баг в getOrderStatus, исправлен 16.07.2026).
 * details — диагностика по каждой сделке, на случай если фикс всё равно не сработал.
 */
export const reclassifyTrades = () =>
  request<{ ok: boolean; checked: number; fixed: number; details: ReclassifyTradeDetail[] }>(
    "/admin/reclassify-trades",
    { method: "POST", body: JSON.stringify({}) },
  );

/**
 * Пересчитать дневной агрегат и блокировки за текущий торговый день
 * (после фикса недоучёта R при partial / правила +3R).
 */
export const resyncDailyLimits = () =>
  request<{
    ok: boolean;
    dayKey: string;
    tradesCount: number;
    sumR: number;
    tradesFixed: number;
    lockTypes: string[];
  }>("/admin/resync-daily-limits", { method: "POST", body: JSON.stringify({}) });

/** Сделки без SL/TP (external/manual) — для ручной атрибуции в админке. */
export const getUnclassifiedTrades = () => request<Trade[]>("/admin/trades/unclassified");

export const setTradeCloseReasonRequest = (tradeId: number, closeReason: "sl" | "tp") =>
  request<Trade>(`/admin/trades/${tradeId}/close-reason`, {
    method: "POST",
    body: JSON.stringify({ closeReason }),
  });

// --- Админка: корректировки баланса (пополнения/выводы) ---

export type EquityAdjustment = {
  id: number;
  date: string;
  amountUsd: string;
  note: string | null;
  createdAt: string;
};

export const getEquityAdjustments = () => request<EquityAdjustment[]>("/admin/equity-adjustments");

export const createEquityAdjustmentRequest = (input: { date: string; amountUsd: number; note?: string }) =>
  request<EquityAdjustment>("/admin/equity-adjustments", { method: "POST", body: JSON.stringify(input) });

export const deleteEquityAdjustmentRequest = (id: number) =>
  request<void>(`/admin/equity-adjustments/${id}`, { method: "DELETE" });

// --- Админка: активы ---

export const getAssets = () => request<Asset[]>("/admin/assets");

export const createAssetRequest = (input: { symbol: string; leverage: number }) =>
  request<Asset>("/admin/assets", { method: "POST", body: JSON.stringify(input) });

export const updateAssetRequest = (id: number, patch: Partial<Omit<Asset, "id">>) =>
  request<Asset>(`/admin/assets/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteAssetRequest = (id: number) =>
  request<void>(`/admin/assets/${id}`, { method: "DELETE" });

// --- Сделки ---

export const getActiveTrade = () => request<ActiveTradeView | null>("/trades/active");

export const openTradeRequest = (input: {
  symbol: string;
  side: TradeSide;
  quantity: number;
  slPrice: number;
}) => request<OpenTradeResult>("/trades", { method: "POST", body: JSON.stringify(input) });

export const setTakeProfitRequest = (
  tradeId: number,
  input: { tpPrice?: number; rrPreset?: string; partialTpPrice?: number },
) =>
  request<SetTakeProfitResult>(`/trades/${tradeId}/takeprofit`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const closeTradeRequest = (tradeId: number) =>
  request<Trade>(`/trades/${tradeId}/close`, { method: "POST" });

// --- История и статистика ---

export const getTradeHistory = (limit: number, offset: number) =>
  request<PagedTrades>(`/trades?limit=${limit}&offset=${offset}`);

export const getStats = () => request<StatsResponse>("/stats");

export const getEquityHistory = () => request<EquitySnapshot[]>("/stats/equity-history");

// --- Дерево роста (Этап 6) ---

export const getRiskTreeLevels = () => request<RiskLevel[]>("/risk/levels");

// --- Цена ---

export type PriceQuote = {
  symbol: string;
  price: number;
  minQuantity: number | null;
  minNotionalUsdt: number | null;
};

export const getPrice = (symbol: string) => request<PriceQuote>(`/price/${encodeURIComponent(symbol)}`);

// --- Админка: риск-план ---

export const getRiskLevels = () => request<RiskLevel[]>("/admin/risk-levels");

export const updateRiskLevelRequest = (level: number, patch: { riskUsd?: number; requiredR?: number }) =>
  request<RiskLevel>(`/admin/risk-levels/${level}`, { method: "PATCH", body: JSON.stringify(patch) });

export const getRiskSettings = () => request<RiskSettings>("/admin/risk-settings");

export const updateRiskSettingsRequest = (patch: Partial<RiskSettings>) =>
  request<RiskSettings>("/admin/risk-settings", { method: "PUT", body: JSON.stringify(patch) });
