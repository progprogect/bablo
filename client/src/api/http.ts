/**
 * Общий fetch-хелпер для обоих приложений: терминала (api/client.ts) и журнала
 * (journal/api.ts). Сессия одна на origin (httpOnly-кука после входа по PIN),
 * поэтому и транспорт один.
 */
export class ApiError extends Error {}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Content-Type описывает ТЕЛО запроса, поэтому без тела заголовок не ставим:
  // Fastify отклоняет запрос с `application/json` и пустым телом ошибкой
  // «Body cannot be empty when content-type is set to 'application/json'».
  // Из-за этого не работал ни один DELETE — ни в журнале (пункт чек-листа,
  // категория, снятие разбора), ни в админке терминала (актив, пополнение,
  // ручная блокировка часа). Найдено 23.09.2026 по сообщению пользователя.
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers = hasBody
    ? { "Content-Type": "application/json", ...init?.headers }
    : init?.headers;

  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers,
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
