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

  // Тело читаем как текст и разбираем сами: при ошибке оно может прийти не JSON-ом
  // (страница прокси, обрезанный ответ), и тогда важно показать хотя бы код статуса.
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const fromServer = (body as { error?: string } | null)?.error;
    // Голое «Запрос не выполнен» ничего не говорит ни пользователю, ни логам: по коду
    // видно хотя бы, ответил ли сервер (4xx/5xx) или вмешался прокси. 04.11.2026.
    throw new ApiError(fromServer ?? `Запрос не выполнен (ошибка ${response.status})`);
  }

  return body as T;
}
