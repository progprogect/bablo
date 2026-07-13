import { createHmac } from "node:crypto";

const BASE_URL = "https://open-api.bingx.com";
const REQUEST_TIMEOUT_MS = 10_000;

export type BingXCredentials = {
  apiKey: string;
  secretKey: string;
};

export class BingXApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "BingXApiError";
  }
}

type BingXEnvelope<T> = {
  code: number;
  msg: string;
  data: T;
};

/**
 * Подпись BingX: HMAC-SHA256 по канонической строке параметров (сортировка ключей
 * по алфавиту, "key=value" через "&", включая timestamp в мс). Один и тот же
 * porядок используется и для подписи, и для самого запроса.
 */
function buildSignedQuery(params: Record<string, string | number>, secretKey: string): string {
  const withTimestamp: Record<string, string | number> = { ...params, timestamp: Date.now() };
  const canonical = Object.keys(withTimestamp)
    .sort()
    .map((key) => `${key}=${withTimestamp[key]}`)
    .join("&");
  const signature = createHmac("sha256", secretKey).update(canonical).digest("hex");
  return `${canonical}&signature=${signature}`;
}

async function bingxRequest<T>(
  credentials: BingXCredentials,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const signedQuery = buildSignedQuery(params, credentials.secretKey);
  const bodyMethod = method === "POST" || method === "PUT";
  const url = bodyMethod ? `${BASE_URL}${path}` : `${BASE_URL}${path}?${signedQuery}`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-BX-APIKEY": credentials.apiKey,
      ...(bodyMethod ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: bodyMethod ? signedQuery : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const json = (await response.json()) as BingXEnvelope<T>;

  if (json.code !== 0) {
    throw new BingXApiError(json.code, json.msg || "BingX API error");
  }

  return json.data;
}

export type BingXBalance = {
  asset: string;
  balance: string;
  equity: string;
  availableMargin: string;
  unrealizedProfit: string;
};

/** v2 оборачивает в `{ balance }`, v3 отдаёт массив записей по активам. */
type BingXBalanceResponseV2 = {
  balance: BingXBalance;
};

type BingXBalanceRow = BingXBalance & { userId?: string };

function pickUsdtBalance(rows: BingXBalanceRow[]): BingXBalance {
  const usdt = rows.find((row) => row.asset === "USDT") ?? rows[0];
  if (!usdt) {
    throw new BingXApiError(-1, "BingX не вернул баланс фьючерсного счёта");
  }
  return {
    asset: usdt.asset,
    balance: usdt.balance,
    equity: usdt.equity,
    availableMargin: usdt.availableMargin,
    unrealizedProfit: usdt.unrealizedProfit,
  };
}

/** Нормализует ответ swap balance (v2/v3) в одну USDT-запись. */
export function normalizeSwapBalanceResponse(data: BingXBalanceResponseV2 | BingXBalanceRow[]): BingXBalance {
  if (Array.isArray(data)) {
    return pickUsdtBalance(data);
  }
  if (data.balance) {
    return data.balance;
  }
  throw new BingXApiError(-1, "BingX вернул неожиданный формат баланса");
}

/** Баланс USDT-M Perpetual аккаунта. Используется для проверки ключей и на дашборде. */
export async function getBalance(credentials: BingXCredentials): Promise<BingXBalance> {
  const data = await bingxRequest<BingXBalanceResponseV2 | BingXBalanceRow[]>(
    credentials,
    "GET",
    "/openApi/swap/v3/user/balance",
  );
  return normalizeSwapBalanceResponse(data);
}

// --- Публичные рыночные данные (без подписи) ---

type BingXPriceResponse = {
  symbol: string;
  price: string;
};

/** Последняя цена символа. Публичный эндпоинт, ключи BingX не требуются. */
export async function getLatestPrice(symbol: string): Promise<number> {
  const url = `${BASE_URL}/openApi/swap/v2/quote/price?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const json = (await response.json()) as BingXEnvelope<BingXPriceResponse>;
  if (json.code !== 0) {
    throw new BingXApiError(json.code, json.msg || "BingX API error");
  }
  return Number(json.data.price);
}

export type BingXContractLimits = {
  symbol: string;
  quantityPrecision: number;
  pricePrecision: number;
  /** Минимальный объём ордера в монетах. */
  tradeMinQuantity: number;
  /** Минимальный номинал ордера в USDT. */
  tradeMinUSDT: number;
};

type BingXContractRaw = {
  symbol: string;
  quantityPrecision: number;
  pricePrecision: number;
  tradeMinQuantity: number | string;
  tradeMinUSDT: number | string;
};

const CONTRACTS_CACHE_TTL_MS = 10 * 60 * 1000;
let contractsCache: { at: number; bySymbol: Map<string, BingXContractLimits> } | null = null;

async function fetchContracts(): Promise<Map<string, BingXContractLimits>> {
  const url = `${BASE_URL}/openApi/swap/v2/quote/contracts`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const json = (await response.json()) as BingXEnvelope<BingXContractRaw[]>;
  if (json.code !== 0) {
    throw new BingXApiError(json.code, json.msg || "BingX API error");
  }
  const map = new Map<string, BingXContractLimits>();
  for (const c of json.data) {
    map.set(c.symbol, {
      symbol: c.symbol,
      quantityPrecision: c.quantityPrecision,
      pricePrecision: c.pricePrecision,
      tradeMinQuantity: Number(c.tradeMinQuantity),
      tradeMinUSDT: Number(c.tradeMinUSDT),
    });
  }
  return map;
}

/**
 * Лимиты контракта (мин. объём/номинал ордера, точность) — публичные и почти неизменные
 * данные, поэтому кешируются на 10 минут вместо запроса на каждый рендер формы. Это ленивое
 * обновление по TTL при обращении, а не циклический поллинг.
 */
export async function getContractLimits(symbol: string): Promise<BingXContractLimits | null> {
  if (!contractsCache || Date.now() - contractsCache.at > CONTRACTS_CACHE_TTL_MS) {
    contractsCache = { at: Date.now(), bySymbol: await fetchContracts() };
  }
  return contractsCache.bySymbol.get(symbol) ?? null;
}

// --- Настройка торговли по символу ---

type PositionModeResponse = { dualSidePosition: boolean };

/** Проверяет текущий режим позиции аккаунта (хедж/one-way). */
export async function getPositionMode(credentials: BingXCredentials): Promise<boolean> {
  const data = await bingxRequest<PositionModeResponse>(
    credentials,
    "GET",
    "/openApi/swap/v1/positionSide/dual",
  );
  return data.dualSidePosition;
}

/**
 * Переводит аккаунт в one-way режим, если он ещё не в нём. Это глобальная настройка
 * аккаунта (не per-symbol), поэтому сначала читаем текущее значение и меняем только
 * при необходимости — избегаем лишних вызовов и риска ошибки при открытых позициях.
 */
export async function ensureOneWayMode(credentials: BingXCredentials): Promise<void> {
  const isHedgeMode = await getPositionMode(credentials);
  if (isHedgeMode) {
    await bingxRequest(credentials, "POST", "/openApi/swap/v1/positionSide/dual", {
      dualSidePosition: "false",
    });
  }
}

/** Устанавливает изолированную маржу для символа. */
export async function setMarginType(credentials: BingXCredentials, symbol: string): Promise<void> {
  await bingxRequest(credentials, "POST", "/openApi/swap/v2/trade/marginType", {
    symbol,
    marginType: "ISOLATED",
  });
}

/** Устанавливает плечо для символа. В one-way режиме side всегда "BOTH". */
export async function setLeverage(
  credentials: BingXCredentials,
  symbol: string,
  leverage: number,
): Promise<void> {
  await bingxRequest(credentials, "POST", "/openApi/swap/v2/trade/leverage", {
    symbol,
    side: "BOTH",
    leverage,
  });
}

// --- Ордера ---

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";

export type PlaceOrderInput = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  /** Обязателен для STOP_MARKET / TAKE_PROFIT_MARKET. */
  stopPrice?: number;
  /** true для SL/TP-ордеров, закрывающих существующую позицию. */
  reduceOnly?: boolean;
};

type BingXOrderResult = {
  orderId: number | string;
  symbol: string;
  status?: string;
  /** Средняя цена исполнения — присутствует у уже исполненных (market) ордеров. */
  avgPrice?: string;
};

type BingXOrderResponse = {
  order: BingXOrderResult;
};

/** Размещает ордер. one-way режим — positionSide всегда "BOTH". */
export async function placeOrder(
  credentials: BingXCredentials,
  input: PlaceOrderInput,
): Promise<BingXOrderResult> {
  const params: Record<string, string | number> = {
    symbol: input.symbol,
    side: input.side,
    positionSide: "BOTH",
    type: input.type,
    quantity: input.quantity,
  };
  if (input.stopPrice !== undefined) {
    params.stopPrice = input.stopPrice;
    params.workingType = "MARK_PRICE";
  }
  if (input.reduceOnly) {
    params.reduceOnly = "true";
  }

  const { order } = await bingxRequest<BingXOrderResponse>(
    credentials,
    "POST",
    "/openApi/swap/v2/trade/order",
    params,
  );
  return order;
}

/**
 * Отменяет ордер (например, оставшийся SL или TP после ручного закрытия позиции).
 * Ошибки "ордер не найден / уже исполнен / уже отменён" — ожидаемы и не критичны,
 * вызывающая сторона должна их проглатывать.
 */
export async function cancelOrder(
  credentials: BingXCredentials,
  symbol: string,
  orderId: string | number,
): Promise<void> {
  await bingxRequest(credentials, "DELETE", "/openApi/swap/v2/trade/order", {
    symbol,
    orderId,
  });
}

// --- Позиции ---

export type BingXPosition = {
  symbol: string;
  positionSide: string;
  positionAmt: string;
  avgPrice: string;
  liquidationPrice: string;
  leverage: string;
  unrealizedProfit: string;
};

/** Текущие открытые позиции (опционально по одному символу). */
export async function getPositions(
  credentials: BingXCredentials,
  symbol?: string,
): Promise<BingXPosition[]> {
  return bingxRequest<BingXPosition[]>(
    credentials,
    "GET",
    "/openApi/swap/v2/user/positions",
    symbol ? { symbol } : {},
  );
}

export type BingXOrderStatus = {
  orderId: number | string;
  symbol: string;
  status: string;
  avgPrice: string;
  profit?: string;
};

/** Детали конкретного ордера — используется для сверки, какой из SL/TP сработал (Этап 4). */
export async function getOrderStatus(
  credentials: BingXCredentials,
  symbol: string,
  orderId: string | number,
): Promise<BingXOrderStatus> {
  return bingxRequest<BingXOrderStatus>(credentials, "GET", "/openApi/swap/v2/trade/order", {
    symbol,
    orderId,
  });
}

// --- Listen Key (для приватного WS account stream) ---

/**
 * Ответ на управление listenKey у BingX непоследователен в разных версиях API:
 * иногда `{ listenKey }` напрямую, иногда обёрнуто в стандартный `{ code, msg, data }`.
 * Поэтому здесь — свой минимальный запрос без строгого парсинга envelope, а не bingxRequest.
 */
async function listenKeyRequest(
  credentials: BingXCredentials,
  method: "POST" | "PUT" | "DELETE",
  listenKey?: string,
): Promise<{ listenKey?: string }> {
  const params: Record<string, string | number> = listenKey ? { listenKey } : {};
  const signedQuery = buildSignedQuery(params, credentials.secretKey);
  const bodyMethod = method === "POST" || method === "PUT";
  const url = bodyMethod
    ? `${BASE_URL}/openApi/user/auth/userDataStream`
    : `${BASE_URL}/openApi/user/auth/userDataStream?${signedQuery}`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-BX-APIKEY": credentials.apiKey,
      ...(bodyMethod ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: bodyMethod ? signedQuery : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const json = (await response.json()) as {
    listenKey?: string;
    code?: number;
    msg?: string;
    data?: { listenKey?: string };
  };

  if (typeof json.code === "number" && json.code !== 0) {
    throw new BingXApiError(json.code, json.msg || "BingX API error");
  }

  return { listenKey: json.listenKey ?? json.data?.listenKey };
}

/** Создаёт listenKey для account WS (валиден 1 час). */
export async function generateListenKey(credentials: BingXCredentials): Promise<string> {
  const { listenKey } = await listenKeyRequest(credentials, "POST");
  if (!listenKey) {
    throw new BingXApiError(-1, "BingX не вернул listenKey");
  }
  return listenKey;
}

/** Продлевает listenKey до 60 минут от текущего момента. Рекомендуется каждые 30 минут. */
export async function extendListenKey(credentials: BingXCredentials, listenKey: string): Promise<void> {
  await listenKeyRequest(credentials, "PUT", listenKey);
}

/** Явно закрывает listenKey (например, при остановке сервиса). */
export async function deleteListenKey(credentials: BingXCredentials, listenKey: string): Promise<void> {
  await listenKeyRequest(credentials, "DELETE", listenKey);
}
