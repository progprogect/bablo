import { deleteListenKey, extendListenKey, generateListenKey, type BingXCredentials } from "../bingx/client.js";
import { ManagedWsConnection } from "./wsClient.js";

const ACCOUNT_WS_BASE = "wss://open-api-swap.bingx.com/swap-market";
const EXTEND_INTERVAL_MS = 30 * 60 * 1000;

export type AccountUpdatePosition = {
  s: string;
  pa: string;
  ep: string;
  up: string;
  mt: string;
  ps: string;
};

export type OrderTradeUpdate = {
  s: string;
  S: string;
  o: string;
  X: string;
  i: number | string;
  ap?: string;
  rp?: string;
  ps?: string;
};

export type AccountStreamHandlers = {
  onAccountUpdate?: (positions: AccountUpdatePosition[]) => void;
  onOrderUpdate?: (order: OrderTradeUpdate) => void;
};

type IncomingEvent = {
  e?: string;
  a?: { P?: AccountUpdatePosition[] };
  o?: OrderTradeUpdate;
};

let connection: ManagedWsConnection | null = null;
let extendTimer: NodeJS.Timeout | null = null;
let currentCredentials: BingXCredentials | null = null;
let currentListenKey: string | null = null;
let handlers: AccountStreamHandlers = {};

function scheduleExtend(listenKey: string): void {
  if (extendTimer) {
    clearInterval(extendTimer);
  }
  extendTimer = setInterval(() => {
    if (!currentCredentials) return;
    extendListenKey(currentCredentials, listenKey).catch((error) => {
      console.error("[ws:account] не удалось продлить listenKey:", error);
    });
  }, EXTEND_INTERVAL_MS);
}

async function resolveUrl(): Promise<string> {
  if (!currentCredentials) {
    throw new Error("Нет ключей BingX для account-стрима");
  }
  // На каждое (пере)подключение — свежий listenKey, включая случай истечения текущего
  // (listenKeyExpired) или обычного разрыва сети. Так не нужно различать причины реконнекта.
  const listenKey = await generateListenKey(currentCredentials);
  currentListenKey = listenKey;
  scheduleExtend(listenKey);
  return `${ACCOUNT_WS_BASE}?listenKey=${listenKey}`;
}

function handleMessage(text: string): void {
  let event: IncomingEvent;
  try {
    event = JSON.parse(text) as IncomingEvent;
  } catch {
    return;
  }

  if (event.e === "ACCOUNT_UPDATE" && event.a?.P) {
    handlers.onAccountUpdate?.(event.a.P);
  } else if (event.e === "ORDER_TRADE_UPDATE" && event.o) {
    handlers.onOrderUpdate?.(event.o);
  }
  // listenKeyExpired: сервер сам закроет соединение, реконнект получит новый listenKey.
}

/** Запускает (или перезапускает с новыми ключами) приватный account-стрим BingX. */
export function startAccountStream(credentials: BingXCredentials, accountHandlers: AccountStreamHandlers): void {
  stopAccountStream();
  currentCredentials = credentials;
  handlers = accountHandlers;

  connection = new ManagedWsConnection({
    label: "account",
    url: resolveUrl,
    onMessage: handleMessage,
  });
  void connection.start();
}

export function stopAccountStream(): void {
  connection?.stop();
  connection = null;
  if (extendTimer) {
    clearInterval(extendTimer);
    extendTimer = null;
  }
  // Явно закрываем listenKey на бирже, а не просто бросаем — иначе он живёт
  // до истечения (~1ч без продления). Best-effort: не критично, если не удалось.
  if (currentCredentials && currentListenKey) {
    deleteListenKey(currentCredentials, currentListenKey).catch(() => {});
  }
  currentCredentials = null;
  currentListenKey = null;
}
