import zlib from "node:zlib";

const DEFAULT_RECONNECT_DELAY_MS = 3_000;

function decodeMessage(data: unknown): string {
  const buffer = Buffer.from(data as ArrayBuffer);
  try {
    return zlib.gunzipSync(buffer).toString("utf-8");
  } catch {
    return buffer.toString("utf-8");
  }
}

export type ManagedWsOptions = {
  /** Возвращает URL подключения. Вызывается перед каждой попыткой (пере)подключения —
   *  позволяет, например, сгенерировать свежий listenKey для account-стрима. */
  url: () => string | Promise<string>;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (text: string) => void;
  onClose?: (event: { code: number; reason: string }) => void;
  reconnectDelayMs?: number;
  /** Для логов — какой это коннектор ("market" | "account"). */
  label: string;
};

/**
 * Универсальный самовосстанавливающийся WS-клиент для BingX: GZIP-декомпрессия,
 * ответ на текстовый heartbeat "Ping" → "Pong", переподключение при разрыве.
 * Общая обёртка для market- и account-стримов (Этап 4), чтобы не дублировать протокол.
 */
export class ManagedWsConnection {
  private ws: WebSocket | null = null;
  private closed = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ManagedWsOptions) {}

  get socket(): WebSocket | null {
    return this.ws;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;

    let url: string;
    try {
      url = await this.options.url();
    } catch (error) {
      console.error(`[ws:${this.options.label}] не удалось подготовить подключение:`, error);
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.options.onOpen?.(ws);
    };

    ws.onmessage = (event) => {
      const text = decodeMessage(event.data);
      if (text === "Ping") {
        ws.send("Pong");
        return;
      }
      this.options.onMessage(text);
    };

    ws.onerror = () => {
      // Ошибка всегда сопровождается закрытием соединения — реконнект обрабатывается в onclose.
    };

    ws.onclose = (event) => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.options.onClose?.({ code: event.code, reason: event.reason });
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
