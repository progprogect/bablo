/**
 * Общий fetch-хелпер для обоих приложений: терминала (api/client.ts) и журнала
 * (journal/api.ts). Сессия одна на origin (httpOnly-кука после входа по PIN),
 * поэтому и транспорт один.
 */
export class ApiError extends Error {}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
