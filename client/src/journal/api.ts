import { request } from "../api/http";
import type {
  AnalysisResponse,
  AnswerType,
  AnswerValue,
  ConstructorCategory,
  JournalOverview,
  PagedJournalTrades,
  TradeDetailResponse,
} from "./types";

/** Типизированный клиент /api/journal/*. Транспорт общий с терминалом (api/http.ts). */

export type TradesFilter = "unsorted" | "all" | number;

export const getOverview = () => request<JournalOverview>("/journal/overview");

export const getJournalTrades = (filter: TradesFilter, limit: number, offset: number) =>
  request<PagedJournalTrades>(
    `/journal/trades?filter=${encodeURIComponent(String(filter))}&limit=${limit}&offset=${offset}`,
  );

export const getJournalTrade = (id: number) => request<TradeDetailResponse>(`/journal/trades/${id}`);

export const saveEntry = (tradeId: number, categoryId: number, answers: { itemId: number; value: AnswerValue }[]) =>
  request<TradeDetailResponse>(`/journal/trades/${tradeId}/entry`, {
    method: "PUT",
    body: JSON.stringify({ categoryId, answers }),
  });

export const removeEntry = (tradeId: number) =>
  request<void>(`/journal/trades/${tradeId}/entry`, { method: "DELETE" });

export const getCategories = () => request<{ categories: ConstructorCategory[] }>("/journal/categories");

export const createCategory = (name: string) =>
  request<{ id: number; name: string }>("/journal/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const renameCategory = (id: number, name: string) =>
  request<{ id: number; name: string }>(`/journal/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const deleteCategory = (id: number) =>
  request<{ archived: boolean }>(`/journal/categories/${id}`, { method: "DELETE" });

export const createItem = (categoryId: number, label: string, answerType: AnswerType) =>
  request<{ id: number; label: string; answerType: AnswerType }>(`/journal/categories/${categoryId}/items`, {
    method: "POST",
    body: JSON.stringify({ label, answerType }),
  });

export const renameItem = (id: number, label: string) =>
  request<{ id: number; label: string }>(`/journal/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ label }),
  });

export const reorderItems = (categoryId: number, itemIds: number[]) =>
  request<{ ok: boolean }>(`/journal/categories/${categoryId}/items-order`, {
    method: "PUT",
    body: JSON.stringify({ itemIds }),
  });

export const deleteItem = (id: number) =>
  request<{ archived: boolean }>(`/journal/items/${id}`, { method: "DELETE" });

export const getAnalysis = (categoryId: number) =>
  request<AnalysisResponse>(`/journal/analysis/${categoryId}`);
