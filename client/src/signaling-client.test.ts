import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalingClient } from './signaling-client';
import {
  AuthHandshake,
  PresenceBroadcast,
  JoinRequest,
  SdpOffer,
  SdpAnswer,
  IceCandidate,
  ErrorMessage,
} from '@blue-call/shared';

/**
 * Contract under test (U19 → implemented in U20, client/src/signaling-client.ts):
 *
 *   new SignalingClient({
 *     url: string,                     // ws:// endpoint of the signaling server
 *     did: string,                     // authenticated user's DID
 *     getToken: () => Promise<string>, // mints a fresh getServiceAuth JWT per connection
 *     reconnectBaseDelayMs: number,    // first retry delay after an unclean close
 *     reconnectMaxDelayMs: number,     // backoff ceiling
 *   })
 *
 *   .connect(): void        — synchronously constructs the global WebSocket
 *   .on(type, handler)      — subscribe to inbound frames by protocol discriminant
 *   .off(type, handler)     — unsubscribe
 *   .send(message): void    — JSON-serialize an outbound protocol frame
 *   .disconnect(): void     — close intentionally; must NOT trigger reconnects
 *
 * Wire protocol: JSON frames discriminated by a `type` field using the pinned
 * kebab-case discriminants from @blue-call/shared (shared/src/protocol.ts):
 * auth-handshake, presence-broadcast, join-request, sdp-offer, sdp-answer,
 * ice-candidate, error. Fixtures below are parsed through the shared zod
 * schemas so drift between this test and the protocol fails loudly.
 *
 * Handshake: the FIRST frame sent after the socket opens is
 *   { type: 'auth-handshake', did, token }
 * with a token freshly obtained from getToken() for every (re)connection —
 * service-auth JWTs are short-lived, so a cached token must not be reused.
 *
 * Reconnect: after an unclean close, retry after reconnectBaseDelayMs,
 * doubling per consecutive failed attempt, capped at reconnectMaxDelayMs,
 * resetting to the base delay after a connection that successfully opens.
 */

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalled = false;

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(String(data));
  }

  close(code = 1000, reason = ''): void {
    this.closeCalled = true;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', { type: 'close', code, reason, wasClean: true });
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  // --- test drivers (not part of the WebSocket API) ---

  /** Simulate the server accepting the connection. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open', { type: 'open' });
  }

  /** Simulate an inbound frame. Objects are JSON-stringified; strings pass raw. */
  message(data: unknown): void {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    this.dispatch('message', { type: 'message', data: raw });
  }

  /** Simulate an unclean close (network drop / server crash). */
  fail(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', { type: 'close', code, reason: '', wasClean: false });
  }

  private dispatch(type: string, ev: unknown): void {
    const prop = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof prop === 'function') prop.call(this, ev);
    this.listeners.get(type)?.forEach((fn) => fn.call(this, ev));
  }
}

const instances = () => MockWebSocket.instances;
const lastSocket = () => {
  const all = MockWebSocket.instances;
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};

/** Flush pending microtasks + a macrotask tick (real timers only). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface MakeClientOverrides {
  getToken?: () => Promise<string>;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

function makeClient(overrides: MakeClientOverrides = {}) {
  const getToken = overrides.getToken ?? vi.fn(async () => 'service-auth-jwt');
  const client = new SignalingClient({
    url: 'ws://localhost:8787/signaling',
    did: 'did:plc:alice',
    getToken,
    reconnectBaseDelayMs: 100,
    reconnectMaxDelayMs: 300,
    ...overrides,
  });
  return { client, getToken };
}

/** connect + server-accept + settle the async handshake (real timers). */
async function connectAndOpen(client: InstanceType<typeof SignalingClient>) {
  client.connect();
  const ws = lastSocket();
  ws.open();
  await flush();
  return ws;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connection and auth-handshake', () => {
  it('opens a WebSocket to the configured URL on connect()', () => {
    const { client } = makeClient();
    client.connect();
    expect(instances()).toHaveLength(1);
    expect(instances()[0].url).toBe('ws://localhost:8787/signaling');
  });

  it('sends auth-handshake with did and token as the first frame after open', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const frame = AuthHandshake.parse(JSON.parse(ws.sent[0]));
    expect(frame).toMatchObject({
      type: 'auth-handshake',
      did: 'did:plc:alice',
      token: 'service-auth-jwt',
    });
  });

  it('sends nothing before the socket has opened', async () => {
    const { client } = makeClient();
    client.connect();
    await flush();
    expect(lastSocket().sent).toHaveLength(0);
  });
});

describe('typed receive', () => {
  it('dispatches an inbound presence-broadcast to its registered listener', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const onPresence = vi.fn();
    client.on('presence-broadcast', onPresence);
    const fixture = PresenceBroadcast.parse({
      type: 'presence-broadcast',
      open: [{ did: 'did:plc:bob', expiresAt: 1782999999 }],
    });
    ws.message(fixture);
    await flush();
    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onPresence).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'presence-broadcast',
        open: expect.arrayContaining([expect.objectContaining({ did: 'did:plc:bob' })]),
      }),
    );
  });

  it('routes by type — a listener only sees its own message type', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const onPresence = vi.fn();
    const onOffer = vi.fn();
    client.on('presence-broadcast', onPresence);
    client.on('sdp-offer', onOffer);
    ws.message(PresenceBroadcast.parse({ type: 'presence-broadcast', open: [] }));
    await flush();
    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onOffer).not.toHaveBeenCalled();
    ws.message(SdpOffer.parse({ type: 'sdp-offer', to: 'did:plc:alice', from: 'did:plc:bob', sdp: 'v=0...' }));
    await flush();
    expect(onOffer).toHaveBeenCalledTimes(1);
    expect(onPresence).toHaveBeenCalledTimes(1);
  });

  it('off() unregisters a listener', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const onPresence = vi.fn();
    client.on('presence-broadcast', onPresence);
    client.off('presence-broadcast', onPresence);
    ws.message(
      PresenceBroadcast.parse({ type: 'presence-broadcast', open: [{ did: 'did:plc:bob', expiresAt: 1782999999 }] }),
    );
    await flush();
    expect(onPresence).not.toHaveBeenCalled();
  });

  it('dispatches inbound error frames to the error listener', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const onError = vi.fn();
    client.on('error', onError);
    ws.message(ErrorMessage.parse({ type: 'error', code: 'unauthorized', message: 'bad service-auth token' }));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: 'unauthorized' }));
  });
});

describe('typed send', () => {
  it('send() serializes a join-request to the socket as JSON', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    client.send(JoinRequest.parse({ type: 'join-request', to: 'did:plc:bob' }));
    const frames = ws.sent.map((raw) => JSON.parse(raw));
    expect(frames[frames.length - 1]).toMatchObject({
      type: 'join-request',
      to: 'did:plc:bob',
    });
  });

  it('send() serializes sdp-offer, sdp-answer, and ice-candidate frames', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const outbound = [
      SdpOffer.parse({ type: 'sdp-offer', to: 'did:plc:bob', sdp: 'v=0 offer' }),
      SdpAnswer.parse({ type: 'sdp-answer', to: 'did:plc:bob', sdp: 'v=0 answer' }),
      IceCandidate.parse({
        type: 'ice-candidate',
        to: 'did:plc:bob',
        candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0' },
      }),
    ];
    for (const msg of outbound) client.send(msg);
    const frames = ws.sent.map((raw) => JSON.parse(raw));
    for (const msg of outbound) {
      expect(frames).toContainEqual(expect.objectContaining({ type: msg.type, to: 'did:plc:bob' }));
    }
  });
});

describe('malformed inbound frames', () => {
  it('ignores frames that are not valid JSON and keeps dispatching afterwards', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const onPresence = vi.fn();
    client.on('presence-broadcast', onPresence);
    expect(() => ws.message('this is not json {{{')).not.toThrow();
    await flush();
    expect(onPresence).not.toHaveBeenCalled();
    // the client must survive the bad frame — later valid frames still dispatch
    ws.message(
      PresenceBroadcast.parse({ type: 'presence-broadcast', open: [{ did: 'did:plc:bob', expiresAt: 1782999999 }] }),
    );
    await flush();
    expect(onPresence).toHaveBeenCalledTimes(1);
  });

  it('ignores JSON frames without a known protocol type', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);
    const onPresence = vi.fn();
    const onError = vi.fn();
    client.on('presence-broadcast', onPresence);
    client.on('error', onError);
    expect(() => ws.message({ type: 'TotallyBogusType', payload: 1 })).not.toThrow();
    expect(() => ws.message({ hello: 'world' })).not.toThrow();
    expect(() => ws.message('42')).not.toThrow();
    await flush();
    expect(onPresence).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('reconnect with backoff', () => {
  it('reconnects after an unclean close once the base delay elapses, with a fresh token', async () => {
    vi.useFakeTimers();
    let mintCount = 0;
    const getToken = vi.fn(async () => `token-${++mintCount}`);
    const { client } = makeClient({ getToken });
    client.connect();
    const first = lastSocket();
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(first.sent[0]).token).toBe('token-1');

    first.fail();
    await vi.advanceTimersByTimeAsync(99);
    expect(instances()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances()).toHaveLength(2);

    const second = lastSocket();
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(second.sent[0])).toMatchObject({ type: 'auth-handshake', token: 'token-2' });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('doubles the delay after consecutive failed attempts', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.connect();
    lastSocket().open();
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(instances()).toHaveLength(2);

    // second attempt never opens — backoff doubles to 200ms
    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(199);
    expect(instances()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances()).toHaveLength(3);
  });

  it('caps the delay at reconnectMaxDelayMs', async () => {
    vi.useFakeTimers();
    const { client } = makeClient(); // base 100, max 300
    client.connect();
    lastSocket().open();
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(100); // attempt 2
    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(200); // attempt 3
    expect(instances()).toHaveLength(3);

    // uncapped this would be 400ms; the 300ms ceiling applies
    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(299);
    expect(instances()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances()).toHaveLength(4);
  });

  it('resets the backoff after a connection that successfully opens', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.connect();
    lastSocket().open();
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(100);
    expect(instances()).toHaveLength(2);

    // this attempt opens successfully — the next failure starts back at 100ms
    lastSocket().open();
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(99);
    expect(instances()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(instances()).toHaveLength(3);
  });
});

describe('clean disconnect', () => {
  it('disconnect() closes the socket and never reconnects', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.connect();
    lastSocket().open();
    await vi.advanceTimersByTimeAsync(0);

    client.disconnect();
    const ws = instances()[0];
    expect(ws.closeCalled || ws.readyState === MockWebSocket.CLOSED).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances()).toHaveLength(1);
  });
});

describe('send queueing before handshake', () => {
  it('queues a send() made before the socket opens, flushing it after the auth-handshake', async () => {
    const { client } = makeClient();
    client.connect();
    const ws = lastSocket();
    client.send(JoinRequest.parse({ type: 'join-request', to: 'did:plc:bob' }));
    expect(ws.sent).toHaveLength(0);
    ws.open();
    await flush();
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'auth-handshake' });
    expect(JSON.parse(ws.sent[1])).toMatchObject({ type: 'join-request', to: 'did:plc:bob' });
  });

  it('preserves order across multiple messages queued before open', async () => {
    const { client } = makeClient();
    client.connect();
    const ws = lastSocket();
    client.send(JoinRequest.parse({ type: 'join-request', to: 'did:plc:bob' }));
    client.send(SdpOffer.parse({ type: 'sdp-offer', to: 'did:plc:bob', sdp: 'v=0 offer' }));
    client.send(
      IceCandidate.parse({
        type: 'ice-candidate',
        to: 'did:plc:bob',
        candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0' },
      }),
    );
    expect(ws.sent).toHaveLength(0);
    ws.open();
    await flush();
    const frames = ws.sent.map((raw) => JSON.parse(raw));
    expect(frames[0]).toMatchObject({ type: 'auth-handshake' });
    expect(frames.slice(1).map((f) => f.type)).toEqual(['join-request', 'sdp-offer', 'ice-candidate']);
  });

  it('flushes messages queued while reconnecting after the new handshake, in order', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    client.connect();
    lastSocket().open();
    await vi.advanceTimersByTimeAsync(0);

    lastSocket().fail();
    client.send(JoinRequest.parse({ type: 'join-request', to: 'did:plc:bob' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(instances()).toHaveLength(2);

    const second = lastSocket();
    expect(second.sent).toHaveLength(0);
    second.open();
    await vi.advanceTimersByTimeAsync(0);
    const frames = second.sent.map((raw) => JSON.parse(raw));
    expect(frames[0]).toMatchObject({ type: 'auth-handshake' });
    expect(frames[1]).toMatchObject({ type: 'join-request', to: 'did:plc:bob' });
  });
});

describe('integration: full signaling lifecycle', () => {
  it('handshakes, exchanges presence and call-setup frames, then disconnects cleanly', async () => {
    const { client } = makeClient();
    const ws = await connectAndOpen(client);

    // 1. handshake was the first frame
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'auth-handshake', did: 'did:plc:alice' });

    // 2. presence arrives for a mutual
    const onPresence = vi.fn();
    const onAnswer = vi.fn();
    const onIce = vi.fn();
    client.on('presence-broadcast', onPresence);
    client.on('sdp-answer', onAnswer);
    client.on('ice-candidate', onIce);
    ws.message(
      PresenceBroadcast.parse({ type: 'presence-broadcast', open: [{ did: 'did:plc:bob', expiresAt: 1783000000 }] }),
    );
    await flush();
    expect(onPresence).toHaveBeenCalledTimes(1);

    // 3. caller initiates: join-request then sdp-offer go out
    client.send(JoinRequest.parse({ type: 'join-request', to: 'did:plc:bob' }));
    client.send(SdpOffer.parse({ type: 'sdp-offer', to: 'did:plc:bob', sdp: 'v=0 offer' }));
    const outbound = ws.sent.map((raw) => JSON.parse(raw));
    expect(outbound).toContainEqual(expect.objectContaining({ type: 'join-request' }));
    expect(outbound).toContainEqual(expect.objectContaining({ type: 'sdp-offer' }));

    // 4. answer + ICE flow back in
    ws.message(SdpAnswer.parse({ type: 'sdp-answer', to: 'did:plc:alice', sdp: 'v=0 answer' }));
    ws.message(
      IceCandidate.parse({
        type: 'ice-candidate',
        to: 'did:plc:alice',
        candidate: { candidate: 'candidate:2 1 udp 1686052607 203.0.113.5 61000 typ srflx', sdpMid: '0' },
      }),
    );
    await flush();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onIce).toHaveBeenCalledTimes(1);

    // 5. clean teardown
    client.disconnect();
    expect(ws.closeCalled || ws.readyState === MockWebSocket.CLOSED).toBe(true);
  });
});
