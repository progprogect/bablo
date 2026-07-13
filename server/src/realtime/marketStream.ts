import { eventBus } from "../events/bus.js";
import { ManagedWsConnection } from "./wsClient.js";

const MARKET_WS_URL = "wss://open-api-swap.bingx.com/swap-market";

type LastPriceMessage = {
  dataType?: string;
  data?: { s?: string; c?: string };
};

let connection: ManagedWsConnection | null = null;
let subscribedSymbols: string[] = [];

function sendSub(symbol: string, reqType: "sub" | "unsub"): void {
  connection?.socket?.send(
    JSON.stringify({ id: `${symbol}-lastPrice`, reqType, dataType: `${symbol}@lastPrice` }),
  );
}

function subscribeAll(): void {
  for (const symbol of subscribedSymbols) {
    sendSub(symbol, "sub");
  }
}

function handleMessage(text: string): void {
  let parsed: LastPriceMessage;
  try {
    parsed = JSON.parse(text) as LastPriceMessage;
  } catch {
    return;
  }
  if (!parsed.dataType?.endsWith("@lastPrice") || !parsed.data?.s || !parsed.data?.c) {
    return;
  }
  const price = Number(parsed.data.c);
  if (!Number.isFinite(price)) {
    return;
  }
  eventBus.emitTyped("price", { symbol: parsed.data.s, price });
}

/** Запускает публичный market-стрим BingX (без авторизации). Безопасно вызывать один раз при бутстрапе. */
export function startMarketStream(initialSymbols: string[]): void {
  subscribedSymbols = initialSymbols;
  if (connection) return;

  connection = new ManagedWsConnection({
    label: "market",
    url: () => MARKET_WS_URL,
    onOpen: subscribeAll,
    onMessage: handleMessage,
  });
  void connection.start();
}

/**
 * Пересобирает подписки под текущий набор активных активов — вызывается из админки
 * при изменении списка (создание/редактирование/удаление). Без реконнекта WS —
 * просто подписываемся на новые символы и отписываемся от убранных.
 */
export function setMarketStreamSymbols(symbols: string[]): void {
  const added = symbols.filter((s) => !subscribedSymbols.includes(s));
  const removed = subscribedSymbols.filter((s) => !symbols.includes(s));
  subscribedSymbols = symbols;
  for (const symbol of added) {
    sendSub(symbol, "sub");
  }
  for (const symbol of removed) {
    sendSub(symbol, "unsub");
  }
}
