interface AuthHandshakeMessage {
  type: 'AuthHandshake';
  did: string;
  token: string;
}

interface PresenceBroadcastMessage {
  type: 'PresenceBroadcast';
  did: string;
  open: boolean;
  expiresAt?: number;
}

interface JoinRequestMessage {
  type: 'JoinRequest';
  from: string;
  to: string;
}

interface SdpOfferMessage {
  type: 'SdpOffer';
  from: string;
  to: string;
  sdp: string;
}

interface SdpAnswerMessage {
  type: 'SdpAnswer';
  from: string;
  to: string;
  sdp: string;
}

interface IceCandidateMessage {
  type: 'IceCandidate';
  from: string;
  to: string;
  candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  };
}

interface ErrorMessageMessage {
  type: 'ErrorMessage';
  code: string;
  message: string;
}

export type SignalingMessage =
  | AuthHandshakeMessage
  | PresenceBroadcastMessage
  | JoinRequestMessage
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | ErrorMessageMessage;

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
    const frame: AuthHandshakeMessage = { type: 'AuthHandshake', did: this.options.did, token };
    ws.send(JSON.stringify(frame));
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
    set.add(handler as HandlerFor<SignalingMessageType>);
  }

  off<T extends SignalingMessageType>(type: T, handler: HandlerFor<T>): void {
    this.handlers[type]?.delete(handler as HandlerFor<SignalingMessageType>);
  }

  send(message: SignalingMessage): void {
    this.ws?.send(JSON.stringify(message));
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
