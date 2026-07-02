import type { AuthHandshake, SignalingMessage } from '@blue-call/shared';

export type { SignalingMessage } from '@blue-call/shared';
export type SignalingMessageType = SignalingMessage['type'];

type HandlerFor<T extends SignalingMessageType> = (msg: Extract<SignalingMessage, { type: T }>) => void;

export interface SignalingClientOptions {
  url: string;
  did: string;
  getToken: () => Promise<string>;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
}

export class SignalingClient {
  private readonly options: SignalingClientOptions;
  private ws: WebSocket | null = null;
  private handlers: Partial<Record<SignalingMessageType, Set<HandlerFor<SignalingMessageType>>>> = {};
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnected = false;
  private sendQueue: SignalingMessage[] = [];

  constructor(options: SignalingClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.disconnected = false;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.onopen = () => {
      void this.handshake(ws);
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.disconnected) return;
      if (ev.wasClean === false) {
        this.scheduleReconnect();
      }
    };
  }

  private async handshake(ws: WebSocket): Promise<void> {
    const token = await this.options.getToken();
    this.reconnectAttempt = 0;
    const frame: AuthHandshake = { type: 'auth-handshake', did: this.options.did, token };
    ws.send(JSON.stringify(frame));
    this.flushQueue(ws);
  }

  private flushQueue(ws: WebSocket): void {
    const pending = this.sendQueue;
    this.sendQueue = [];
    for (const message of pending) {
      ws.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.options.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.options.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const type = (parsed as Record<string, unknown>).type;
    if (typeof type !== 'string') return;
    const set = this.handlers[type as SignalingMessageType];
    if (!set) return;
    for (const handler of set) handler(parsed as SignalingMessage);
  }

  on<T extends SignalingMessageType>(type: T, handler: HandlerFor<T>): void {
    let set = this.handlers[type];
    if (!set) {
      set = new Set();
      this.handlers[type] = set;
    }
    set.add(handler as unknown as HandlerFor<SignalingMessageType>);
  }

  off<T extends SignalingMessageType>(type: T, handler: HandlerFor<T>): void {
    this.handlers[type]?.delete(handler as unknown as HandlerFor<SignalingMessageType>);
  }

  send(message: SignalingMessage): void {
    if (this.disconnected) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.sendQueue.push(message);
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  disconnect(): void {
    this.disconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
