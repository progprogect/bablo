import type {
  ActiveTradeView,
  Asset,
  AuthStatus,
  BingxKeyStatus,
  DashboardResponse,
  BingXBalance,
  OpenTradeResult,
  PagedTrades,
  RiskLevel,
  RiskSettings,
  TimeOfDayStats,
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
  input: { tpPrice?: number; rrPreset?: string },
) => request<Trade>(`/trades/${tradeId}/takeprofit`, { method: "POST", body: JSON.stringify(input) });

export const closeTradeRequest = (tradeId: number) =>
  request<Trade>(`/trades/${tradeId}/close`, { method: "POST" });

// --- История и статистика ---

export const getTradeHistory = (limit: number, offset: number) =>
  request<PagedTrades>(`/trades?limit=${limit}&offset=${offset}`);

export const getStats = () => request<TimeOfDayStats>("/stats");

// --- Дерево роста (Этап 6) ---

export const getRiskTreeLevels = () => request<RiskLevel[]>("/risk/levels");

// --- Цена ---

export const getPrice = (symbol: string) =>
  request<{ symbol: string; price: number }>(`/price/${encodeURIComponent(symbol)}`);

// --- Админка: риск-план ---

export const getRiskLevels = () => request<RiskLevel[]>("/admin/risk-levels");

export const updateRiskLevelRequest = (level: number, patch: { riskUsd?: number; requiredR?: number }) =>
  request<RiskLevel>(`/admin/risk-levels/${level}`, { method: "PATCH", body: JSON.stringify(patch) });

export const getRiskSettings = () => request<RiskSettings>("/admin/risk-settings");

export const updateRiskSettingsRequest = (patch: Partial<RiskSettings>) =>
  request<RiskSettings>("/admin/risk-settings", { method: "PUT", body: JSON.stringify(patch) });
