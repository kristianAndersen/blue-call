import { afterEach, describe, expect, test } from 'bun:test';
import type { SignalingMessage } from '@blue-call/shared';

import { createServer } from './index';

// Contract under test (U14): server entrypoint (`server/src/index.ts`).
//
//   createServer(options?: {
//     port?: number;          // default: Number(process.env.PORT ?? 8787); 0 = ephemeral
//     allowedOrigin?: string; // default: process.env.ALLOWED_ORIGIN; when set, a WS
//                             // upgrade whose Origin header differs is refused
//     verifyAuth?: (token: string) => Promise<{ did: string }>;
//                             // injection point for tests; default wraps ./auth
//   }): BlueCallServer
//
//   interface BlueCallServer {
//     port: number;           // actual bound port (option/env 0 -> assigned port)
//     getState(): { openPresence: string[]; connectionCount: number };
//     stop(): Promise<void>;  // graceful shutdown: closes every live WS connection,
//                             // stops listening, clears ALL in-memory state
//   }
//
// Wiring: Bun.serve with `GET /health` -> 200 and WebSocket upgrade at `/ws`,
// routing socket open/message/close into createSignalingRouter (./signaling)
// backed by createPresenceStore (./presence); auth via verifyAuth (defaults to
// verifyClientAuth from ./auth). Per-connection frames must be processed in
// arrival order even though auth verification is async (the handler serializes
// per connection).
//
// Structural memorylessness (the product principle this suite proves): after
// clients disconnect -- or after stop() -- the presence store and every
// connection map are EMPTY. Nothing about who was present, who joined whom, or
// what SDP flowed survives in server state.

interface BlueCallServer {
  port: number;
  getState(): { openPresence: string[]; connectionCount: number };
  stop(): Promise<void>;
}

interface CreateServerOptions {
  port?: number;
  allowedOrigin?: string;
  verifyAuth?: (token: string) => Promise<{ did: string }>;
}

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob0000000000000000000000';

/** Token convention for the injected verifier: `ok:<did>` proves <did>. */
function fakeVerifyAuth(token: string): Promise<{ did: string }> {
  if (token.startsWith('ok:')) return Promise.resolve({ did: token.slice(3) });
  return Promise.reject(new Error('invalid token'));
}

async function until(pred: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(10);
  }
}

class TestClient {
  readonly received: SignalingMessage[] = [];
  everOpened = false;
  closed = false;
  closeCode: number | undefined;
  readonly ws: WebSocket;

  constructor(port: number, headers?: Record<string, string>) {
    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      headers ? ({ headers } as never) : undefined,
    );
    this.ws.addEventListener('open', () => {
      this.everOpened = true;
    });
    this.ws.addEventListener('message', (ev) => {
      this.received.push(JSON.parse(String(ev.data)) as SignalingMessage);
    });
    this.ws.addEventListener('close', (ev) => {
      this.closed = true;
      this.closeCode = ev.code;
    });
    this.ws.addEventListener('error', () => {
      // A refused upgrade surfaces as error+close; `closed` is the signal.
    });
  }

  async opened(): Promise<this> {
    await until(() => this.everOpened || this.closed, 'socket to open');
    if (!this.everOpened) throw new Error('socket closed before opening');
    return this;
  }

  send(msg: SignalingMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  frames<T extends SignalingMessage['type']>(type: T): Extract<SignalingMessage, { type: T }>[] {
    return this.received.filter(
      (m): m is Extract<SignalingMessage, { type: T }> => m.type === type,
    );
  }

  async waitFor<T extends SignalingMessage['type']>(
    type: T,
    what = type as string,
  ): Promise<Extract<SignalingMessage, { type: T }>> {
    await until(() => this.frames(type).length > 0, what);
    return this.frames(type)[0]!;
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

let server: BlueCallServer | undefined;
const clients: TestClient[] = [];

function boot(options: CreateServerOptions = {}): BlueCallServer {
  server = (createServer as (o: CreateServerOptions) => BlueCallServer)({
    port: 0,
    verifyAuth: fakeVerifyAuth,
    ...options,
  });
  return server;
}

async function connectAndAuth(srv: BlueCallServer, did: string): Promise<TestClient> {
  const before = srv.getState().connectionCount;
  const client = new TestClient(srv.port);
  clients.push(client);
  await client.opened();
  client.send({ type: 'auth-handshake', did, token: `ok:${did}` });
  await until(
    () => srv.getState().connectionCount === before + 1,
    `authenticated connection count ${before + 1}`,
  );
  return client;
}

/** Two clients run the whole product flow: presence-open -> join -> offer/answer/ICE. */
async function runFullCallFlow(srv: BlueCallServer): Promise<{ alice: TestClient; bob: TestClient }> {
  const alice = await connectAndAuth(srv, ALICE);
  const bob = await connectAndAuth(srv, BOB);

  alice.send({ type: 'presence-open', durationMs: 60_000 });
  await bob.waitFor('presence-broadcast', "bob to see alice's presence");
  bob.send({ type: 'presence-open', durationMs: 60_000 });
  await until(() => srv.getState().openPresence.length === 2, 'both DIDs open');

  bob.send({ type: 'join-request', to: ALICE });
  await alice.waitFor('join-request', 'alice to receive the join request');

  alice.send({ type: 'sdp-offer', to: BOB, sdp: 'v=0 offer-from-alice' });
  await bob.waitFor('sdp-offer', 'bob to receive the offer');
  bob.send({ type: 'sdp-answer', to: ALICE, sdp: 'v=0 answer-from-bob' });
  await alice.waitFor('sdp-answer', 'alice to receive the answer');
  alice.send({
    type: 'ice-candidate',
    to: BOB,
    candidate: { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host' },
  });
  await bob.waitFor('ice-candidate', 'bob to receive the ICE candidate');

  return { alice, bob };
}

afterEach(async () => {
  for (const client of clients) client.close();
  clients.length = 0;
  if (server) {
    await server.stop().catch(() => {});
    server = undefined;
  }
});

describe('server entrypoint: boot + config', () => {
  test('boots on an ephemeral port and answers GET /health with 200', async () => {
    const srv = boot();
    expect(srv.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(res.status).toBe(200);
  });

  test('a fresh server is empty: no presence, no connections', () => {
    const srv = boot();
    expect(srv.getState().openPresence).toEqual([]);
    expect(srv.getState().connectionCount).toBe(0);
  });

  test('PORT env is honored when no port option is given', async () => {
    const prev = process.env.PORT;
    process.env.PORT = '0';
    try {
      server = (createServer as (o: CreateServerOptions) => BlueCallServer)({
        verifyAuth: fakeVerifyAuth,
      });
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.PORT;
      else process.env.PORT = prev;
    }
  });
});

describe('server entrypoint: WS upgrade + auth', () => {
  test('upgrade with a matching Origin succeeds when ALLOWED_ORIGIN is configured', async () => {
    const srv = boot({ allowedOrigin: 'http://localhost:5173' });
    const client = new TestClient(srv.port, { Origin: 'http://localhost:5173' });
    clients.push(client);
    await client.opened();
    expect(client.everOpened).toBe(true);
  });

  test('upgrade from a disallowed Origin is refused', async () => {
    const srv = boot({ allowedOrigin: 'http://localhost:5173' });
    const evil = new TestClient(srv.port, { Origin: 'https://evil.example' });
    clients.push(evil);
    await until(() => evil.closed, 'refused socket to close');
    expect(evil.everOpened).toBe(false);
    expect(srv.getState().connectionCount).toBe(0);
  });

  test('authenticated handshake registers the connection', async () => {
    const srv = boot();
    const alice = await connectAndAuth(srv, ALICE);
    expect(alice.closed).toBe(false);
    expect(alice.frames('error')).toHaveLength(0);
    expect(srv.getState().connectionCount).toBe(1);
  });

  test('a first frame that is not auth-handshake gets the connection rejected', async () => {
    const srv = boot();
    const client = new TestClient(srv.port);
    clients.push(client);
    await client.opened();
    client.send({ type: 'presence-open', durationMs: 60_000 });
    await until(() => client.closed, 'unauthenticated socket to be closed');
    expect(client.closeCode).toBe(4401);
    expect(srv.getState().connectionCount).toBe(0);
    expect(srv.getState().openPresence).toEqual([]);
  });
});

describe('server entrypoint: full 2-client signaling round-trip', () => {
  test('presence-open -> join -> offer/answer/ICE all relay end to end', async () => {
    const srv = boot();
    const { alice, bob } = await runFullCallFlow(srv);

    const broadcast = bob.frames('presence-broadcast')[0]!;
    expect(broadcast.open.map((o) => o.did)).toContain(ALICE);

    const offer = bob.frames('sdp-offer')[0]!;
    expect(offer.sdp).toBe('v=0 offer-from-alice');
    expect(offer.from).toBe(ALICE); // stamped by the server, never client-supplied

    const answer = alice.frames('sdp-answer')[0]!;
    expect(answer.sdp).toBe('v=0 answer-from-bob');

    const ice = bob.frames('ice-candidate')[0]!;
    expect(ice.candidate.candidate).toContain('candidate:1');

    const state = srv.getState();
    expect(state.connectionCount).toBe(2);
    expect([...state.openPresence].sort()).toEqual([ALICE, BOB].sort());
  });
});

describe('structural memorylessness', () => {
  test('after both clients disconnect, presence store and connection maps are EMPTY', async () => {
    const srv = boot();
    const { alice, bob } = await runFullCallFlow(srv);

    alice.close();
    bob.close();
    await until(
      () =>
        srv.getState().connectionCount === 0 && srv.getState().openPresence.length === 0,
      'server state to drain after disconnects',
    );

    expect(srv.getState().openPresence).toEqual([]);
    expect(srv.getState().connectionCount).toBe(0);
  });

  test('stop() closes live connections, clears all state, and stops listening', async () => {
    const srv = boot();
    const { alice, bob } = await runFullCallFlow(srv);

    await srv.stop();

    expect(srv.getState().openPresence).toEqual([]);
    expect(srv.getState().connectionCount).toBe(0);
    await until(() => alice.closed && bob.closed, 'clients to be closed by shutdown');
    expect(fetch(`http://127.0.0.1:${srv.port}/health`)).rejects.toThrow();
  });
});
