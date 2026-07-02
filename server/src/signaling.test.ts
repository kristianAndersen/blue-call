import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ErrorMessage,
  IceCandidate,
  PresenceBroadcast,
  SdpAnswer,
  SdpOffer,
  type SignalingMessage,
} from '@blue-call/shared';

import { createPresenceStore } from './presence';
import { createSignalingRouter, type SignalingConnection } from './signaling';

// Contract under test (U12): server signaling relay/router.
//
//   createSignalingRouter(options: {
//     presence: PresenceStore;                            // from ./presence
//     verifyAuth(token: string): Promise<{ did: string }>; // wraps ./auth verifyClientAuth
//   }): SignalingRouter
//
//   interface SignalingConnection {
//     send(data: string): void;
//     close(code?: number, reason?: string): void;
//   }
//
//   interface SignalingRouter {
//     handleOpen(conn: SignalingConnection): void;
//     handleMessage(conn: SignalingConnection, raw: string): Promise<void>;
//     handleClose(conn: SignalingConnection): void;
//     connectionCount(): number;
//   }
//
// Semantics:
// - The first frame on every connection MUST be a valid `auth-handshake`.
//   verifyAuth(token) resolves the proven DID; it must equal the handshake's
//   claimed `did`, else the connection is rejected (error frame and/or close)
//   and nothing is ever routed for it.
// - `presence-open` / `presence-close` from an authenticated DID update the
//   injected presence store, then a server-built `presence-broadcast` (full
//   open list) is fanned out to every authenticated connection.
// - `sdp-offer` / `sdp-answer` / `ice-candidate` are relayed verbatim to the
//   target DID's connection only. Relayed offers carry `from` = the sender's
//   verified DID (never client-supplied). Unknown target -> `error` frame to
//   the sender, no crash.
// - Client-sent `presence-broadcast` is server-only vocabulary: never fanned
//   out on a client's behalf.
// - Frames failing SignalingMessage schema parse -> `error` frame, not routed.
// - handleClose clears ALL per-connection state: presence entry closed,
//   connection deregistered, DID no longer routable.
// - Structural memorylessness: routing must not log message contents or call
//   metadata (SDP bodies, DIDs, who-called-whom) via console.

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob0000000000000000000000';
const CAROL = 'did:plc:carol00000000000000000000';

class MockConn implements SignalingConnection {
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Parsed frames of one discriminant received by this connection. */
  frames<T extends SignalingMessage['type']>(
    type: T,
  ): Extract<SignalingMessage, { type: T }>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as SignalingMessage)
      .filter((m): m is Extract<SignalingMessage, { type: T }> => m.type === type);
  }
}

/** Token convention for the injected verifier: `ok:<did>` proves <did>. */
function fakeVerifyAuth(token: string): Promise<{ did: string }> {
  if (token.startsWith('ok:')) return Promise.resolve({ did: token.slice(3) });
  return Promise.reject(new Error('invalid token'));
}

function makeRouter() {
  const presence = createPresenceStore();
  const router = createSignalingRouter({ presence, verifyAuth: fakeVerifyAuth });
  return { presence, router };
}

type Router = ReturnType<typeof makeRouter>['router'];

async function connectAs(router: Router, did: string): Promise<MockConn> {
  const conn = new MockConn();
  router.handleOpen(conn);
  await router.handleMessage(
    conn,
    JSON.stringify({ type: 'auth-handshake', did, token: `ok:${did}` }),
  );
  return conn;
}

describe('signaling router: auth handshake', () => {
  test('valid handshake registers the connection without closing it', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    expect(alice.closed).toBe(false);
    expect(alice.frames('error')).toHaveLength(0);
    expect(router.connectionCount()).toBe(1);
  });

  test('handshake with a bad token is rejected', async () => {
    const { router } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'auth-handshake', did: ALICE, token: 'garbage' }),
    );
    expect(conn.closed || conn.frames('error').length > 0).toBe(true);
    expect(router.connectionCount()).toBe(0);
  });

  test('handshake claiming a DID the token does not prove is rejected', async () => {
    const { router } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    // Token proves BOB, handshake claims ALICE — identity spoof attempt.
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'auth-handshake', did: ALICE, token: `ok:${BOB}` }),
    );
    expect(conn.closed || conn.frames('error').length > 0).toBe(true);
    expect(router.connectionCount()).toBe(0);
  });

  test('handshake with a malformed DID fails the shared schema and is rejected', async () => {
    const { router } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'auth-handshake', did: 'not-a-did', token: 'ok:not-a-did' }),
    );
    expect(conn.closed || conn.frames('error').length > 0).toBe(true);
    expect(router.connectionCount()).toBe(0);
  });

  test('frames from a rejected connection are never routed afterwards', async () => {
    const { router } = makeRouter();
    const bob = await connectAs(router, BOB);
    const intruder = new MockConn();
    router.handleOpen(intruder);
    await router.handleMessage(
      intruder,
      JSON.stringify({ type: 'auth-handshake', did: ALICE, token: 'garbage' }),
    );
    await router.handleMessage(
      intruder,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: 'v=0 intruder' }),
    );
    expect(bob.frames('sdp-offer')).toHaveLength(0);
  });
});

describe('signaling router: unauthenticated rejection before any routing', () => {
  test('a signaling frame as the first frame is rejected, not routed', async () => {
    const { router } = makeRouter();
    const bob = await connectAs(router, BOB);
    const conn = new MockConn();
    router.handleOpen(conn);
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: 'v=0 sneaky' }),
    );
    expect(conn.closed || conn.frames('error').length > 0).toBe(true);
    expect(bob.frames('sdp-offer')).toHaveLength(0);
  });

  test('presence-open before auth does not touch the presence store', async () => {
    const { router, presence } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'presence-open', durationMs: 60_000 }),
    );
    expect(presence.list()).toEqual([]);
  });
});

describe('signaling router: presence flow', () => {
  test('presence-open marks the sender open in the injected store', async () => {
    const { router, presence } = makeRouter();
    const alice = await connectAs(router, ALICE);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'presence-open', durationMs: 60_000 }),
    );
    expect(presence.isOpen(ALICE)).toBe(true);
  });

  test('presence-open fans a schema-valid broadcast out to other authenticated clients', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'presence-open', durationMs: 60_000 }),
    );
    const broadcasts = bob.frames('presence-broadcast');
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const last = broadcasts[broadcasts.length - 1]!;
    expect(() => PresenceBroadcast.parse(last)).not.toThrow();
    const entry = last.open.find((o) => o.did === ALICE);
    expect(entry).toBeDefined();
    expect(typeof entry!.expiresAt).toBe('number');
  });

  test('presence-close removes the sender from the store and from the next broadcast', async () => {
    const { router, presence } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'presence-open', durationMs: 60_000 }),
    );
    await router.handleMessage(alice, JSON.stringify({ type: 'presence-close' }));
    expect(presence.isOpen(ALICE)).toBe(false);
    const broadcasts = bob.frames('presence-broadcast');
    expect(broadcasts.length).toBeGreaterThanOrEqual(2);
    const last = broadcasts[broadcasts.length - 1]!;
    expect(last.open.map((o) => o.did)).not.toContain(ALICE);
  });

  test('a client-sent presence-broadcast is never fanned out (server-only vocabulary)', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    await router.handleMessage(
      alice,
      JSON.stringify({
        type: 'presence-broadcast',
        open: [{ did: CAROL, expiresAt: Date.now() + 60_000 }],
      }),
    );
    const spoofed = bob
      .frames('presence-broadcast')
      .filter((b) => b.open.some((o) => o.did === CAROL));
    expect(spoofed).toHaveLength(0);
  });
});

describe('signaling router: offer/answer/ICE relay to the correct peer only', () => {
  test('sdp-offer reaches the target DID with the sdp intact', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: 'v=0 alice-offer' }),
    );
    const offers = bob.frames('sdp-offer');
    expect(offers).toHaveLength(1);
    expect(() => SdpOffer.parse(offers[0])).not.toThrow();
    expect(offers[0]!.sdp).toBe('v=0 alice-offer');
  });

  test('relayed offer carries from = the sender verified DID, not client-supplied', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    // Sender lies about `from`; the router must stamp the verified DID.
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-offer', to: BOB, from: CAROL, sdp: 'v=0 x' }),
    );
    expect(bob.frames('sdp-offer')[0]!.from).toBe(ALICE);
  });

  test('sdp-offer is not delivered to third parties or echoed to the sender', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    const carol = await connectAs(router, CAROL);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: 'v=0 private' }),
    );
    expect(bob.frames('sdp-offer')).toHaveLength(1);
    expect(carol.frames('sdp-offer')).toHaveLength(0);
    expect(alice.frames('sdp-offer')).toHaveLength(0);
  });

  test('sdp-answer relays back to the offerer only', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    const carol = await connectAs(router, CAROL);
    await router.handleMessage(
      bob,
      JSON.stringify({ type: 'sdp-answer', to: ALICE, sdp: 'v=0 bob-answer' }),
    );
    const answers = alice.frames('sdp-answer');
    expect(answers).toHaveLength(1);
    expect(() => SdpAnswer.parse(answers[0])).not.toThrow();
    expect(answers[0]!.sdp).toBe('v=0 bob-answer');
    expect(carol.frames('sdp-answer')).toHaveLength(0);
  });

  test('ice-candidate relays to the target with candidate fields intact', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    const candidate = {
      candidate: 'candidate:1 1 UDP 2130706431 192.0.2.1 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'ice-candidate', to: BOB, candidate }),
    );
    const relayed = bob.frames('ice-candidate');
    expect(relayed).toHaveLength(1);
    expect(() => IceCandidate.parse(relayed[0])).not.toThrow();
    expect(relayed[0]!.candidate).toEqual(candidate);
    expect(alice.frames('ice-candidate')).toHaveLength(0);
  });

  test('relay to a DID that is not connected sends the sender an error, no crash', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: 'v=0 nobody-home' }),
    );
    const errors = alice.frames('error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(() => ErrorMessage.parse(errors[0])).not.toThrow();
  });
});

describe('signaling router: malformed frame rejection via shared schema', () => {
  test('non-JSON frame gets an error frame and does not throw', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    await router.handleMessage(alice, 'this is not json {{{');
    const errors = alice.frames('error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(() => ErrorMessage.parse(errors[0])).not.toThrow();
  });

  test('unknown discriminant is rejected', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'call-history-request', to: BOB }),
    );
    expect(alice.frames('error').length).toBeGreaterThanOrEqual(1);
  });

  test('schema-invalid fields on a known discriminant are rejected, not routed', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    // sdp must be a non-empty string per shared schema.
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: '' }),
    );
    expect(bob.frames('sdp-offer')).toHaveLength(0);
    expect(alice.frames('error').length).toBeGreaterThanOrEqual(1);
  });

  test('malformed frame from one client does not disturb routing for others', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    await router.handleMessage(alice, '%%%garbage%%%');
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-offer', to: BOB, sdp: 'v=0 still-works' }),
    );
    expect(bob.frames('sdp-offer')).toHaveLength(1);
  });
});

describe('signaling router: full cleanup on disconnect', () => {
  test('close clears the presence entry for the connection DID', async () => {
    const { router, presence } = makeRouter();
    const alice = await connectAs(router, ALICE);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'presence-open', durationMs: 60_000 }),
    );
    router.handleClose(alice);
    expect(presence.isOpen(ALICE)).toBe(false);
    expect(presence.list()).toEqual([]);
  });

  test('close deregisters the connection', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    expect(router.connectionCount()).toBe(2);
    router.handleClose(alice);
    expect(router.connectionCount()).toBe(1);
    router.handleClose(bob);
    expect(router.connectionCount()).toBe(0);
  });

  test('a closed DID is no longer routable', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);
    router.handleClose(alice);
    const sentBefore = alice.sent.length;
    await router.handleMessage(
      bob,
      JSON.stringify({ type: 'sdp-offer', to: ALICE, sdp: 'v=0 too-late' }),
    );
    expect(alice.sent.length).toBe(sentBefore);
    expect(bob.frames('error').length).toBeGreaterThanOrEqual(1);
  });

  test('close of a never-authenticated connection is safe', () => {
    const { router } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    expect(() => router.handleClose(conn)).not.toThrow();
    expect(router.connectionCount()).toBe(0);
  });

  test('close is idempotent', async () => {
    const { router } = makeRouter();
    const alice = await connectAs(router, ALICE);
    router.handleClose(alice);
    expect(() => router.handleClose(alice)).not.toThrow();
    expect(router.connectionCount()).toBe(0);
  });
});

describe('signaling router: structural memorylessness (no content/metadata logging)', () => {
  test('a full call flow logs no SDP bodies, DIDs, or frame contents to console', async () => {
    const captured: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((m) => console[m]);
    for (const m of methods) {
      console[m] = (...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(' '));
      };
    }
    try {
      const { router, presence } = makeRouter();
      const alice = await connectAs(router, ALICE);
      const bob = await connectAs(router, BOB);
      await router.handleMessage(
        alice,
        JSON.stringify({ type: 'presence-open', durationMs: 60_000 }),
      );
      await router.handleMessage(bob, JSON.stringify({ type: 'join-request', to: ALICE }));
      await router.handleMessage(
        bob,
        JSON.stringify({ type: 'sdp-offer', to: ALICE, sdp: 'v=0 SECRET-SDP-MARKER' }),
      );
      await router.handleMessage(
        alice,
        JSON.stringify({ type: 'sdp-answer', to: BOB, sdp: 'v=0 SECRET-ANSWER-MARKER' }),
      );
      router.handleClose(alice);
      router.handleClose(bob);

      const blob = captured.join('\n');
      expect(blob).not.toContain('SECRET-SDP-MARKER');
      expect(blob).not.toContain('SECRET-ANSWER-MARKER');
      expect(blob).not.toContain(ALICE);
      expect(blob).not.toContain(BOB);

      // And the memorylessness half: nothing survives the disconnects.
      expect(presence.list()).toEqual([]);
      expect(router.connectionCount()).toBe(0);
    } finally {
      methods.forEach((m, i) => {
        console[m] = originals[i]!;
      });
    }
  });
});

describe('signaling router: DEV_ALLOW_UNVERIFIED_AUTH bypass', () => {
  const ENV_KEY = 'DEV_ALLOW_UNVERIFIED_AUTH';
  const NODE_ENV_KEY = 'NODE_ENV';
  let originalEnv: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    originalNodeEnv = process.env[NODE_ENV_KEY];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    if (originalNodeEnv === undefined) delete process.env[NODE_ENV_KEY];
    else process.env[NODE_ENV_KEY] = originalNodeEnv;
  });

  test('with the flag set and NODE_ENV=development, a handshake whose token verification fails trusts the claimed DID', async () => {
    process.env[ENV_KEY] = '1';
    process.env[NODE_ENV_KEY] = 'development';
    const { router } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'auth-handshake', did: ALICE, token: 'dev-unverified' }),
    );
    expect(conn.closed).toBe(false);
    expect(conn.frames('error')).toHaveLength(0);
    expect(router.connectionCount()).toBe(1);
  });

  test('with the flag set and NODE_ENV=development, exactly one console.warn fires at router creation, never per-connection', async () => {
    process.env[ENV_KEY] = '1';
    process.env[NODE_ENV_KEY] = 'development';
    const warnCalls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnCalls.push(args);
    try {
      const { router } = makeRouter();
      await connectAs(router, ALICE);
      await connectAs(router, BOB);
    } finally {
      console.warn = original;
    }
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0]![0])).toContain('DEV MODE: signaling auth disabled');
  });

  test('with the flag set but NODE_ENV unset, router creation throws and refuses to boot', () => {
    process.env[ENV_KEY] = '1';
    delete process.env[NODE_ENV_KEY];
    expect(() => makeRouter()).toThrow(
      'refusing to start: DEV_ALLOW_UNVERIFIED_AUTH is set outside NODE_ENV=development',
    );
  });

  test('with the flag set but NODE_ENV=production, router creation throws and refuses to boot', () => {
    process.env[ENV_KEY] = '1';
    process.env[NODE_ENV_KEY] = 'production';
    expect(() => makeRouter()).toThrow(
      'refusing to start: DEV_ALLOW_UNVERIFIED_AUTH is set outside NODE_ENV=development',
    );
  });

  test('without the env flag, a handshake with a failing token is rejected exactly as before, regardless of NODE_ENV', async () => {
    delete process.env[ENV_KEY];
    delete process.env[NODE_ENV_KEY];
    const { router } = makeRouter();
    const conn = new MockConn();
    router.handleOpen(conn);
    await router.handleMessage(
      conn,
      JSON.stringify({ type: 'auth-handshake', did: ALICE, token: 'dev-unverified' }),
    );
    expect(conn.closed || conn.frames('error').length > 0).toBe(true);
    expect(router.connectionCount()).toBe(0);
  });
});

describe('signaling router: end-to-end integration', () => {
  test('two clients: auth -> presence -> offer/answer/ICE -> disconnect leaves zero state', async () => {
    const { router, presence } = makeRouter();
    const alice = await connectAs(router, ALICE);
    const bob = await connectAs(router, BOB);

    // Alice declares herself open; Bob sees the broadcast.
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'presence-open', durationMs: 300_000 }),
    );
    const seen = bob.frames('presence-broadcast');
    expect(seen.some((b) => b.open.some((o) => o.did === ALICE))).toBe(true);

    // Bob calls Alice: offer -> answer -> ICE both ways.
    await router.handleMessage(
      bob,
      JSON.stringify({ type: 'sdp-offer', to: ALICE, sdp: 'v=0 e2e-offer' }),
    );
    expect(alice.frames('sdp-offer')).toHaveLength(1);
    await router.handleMessage(
      alice,
      JSON.stringify({ type: 'sdp-answer', to: BOB, sdp: 'v=0 e2e-answer' }),
    );
    expect(bob.frames('sdp-answer')).toHaveLength(1);
    await router.handleMessage(
      alice,
      JSON.stringify({
        type: 'ice-candidate',
        to: BOB,
        candidate: { candidate: 'candidate:a', sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );
    await router.handleMessage(
      bob,
      JSON.stringify({
        type: 'ice-candidate',
        to: ALICE,
        candidate: { candidate: 'candidate:b', sdpMid: '0', sdpMLineIndex: 0 },
      }),
    );
    expect(bob.frames('ice-candidate')).toHaveLength(1);
    expect(alice.frames('ice-candidate')).toHaveLength(1);

    // Both hang up and disconnect: every state map drains to empty.
    router.handleClose(alice);
    router.handleClose(bob);
    expect(router.connectionCount()).toBe(0);
    expect(presence.list()).toEqual([]);
    expect(presence.isOpen(ALICE)).toBe(false);
    expect(presence.isOpen(BOB)).toBe(false);
  });
});
