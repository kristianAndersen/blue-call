import { describe, test, expect } from 'bun:test';
import {
  PresenceOpen,
  PresenceClose,
  PresenceBroadcast,
  JoinRequest,
  SdpOffer,
  SdpAnswer,
  IceCandidate,
  AuthHandshake,
  ErrorMessage,
  SignalingMessage,
} from './protocol';

const DID_A = 'did:plc:alice1234abcdef';
const DID_B = 'did:plc:bob5678ghijkl';

// One canonical valid fixture per message type. These pin the wire contract:
// discriminant field `type` uses the kebab-case name of the schema.
const valid = {
  authHandshake: {
    type: 'auth-handshake',
    did: DID_A,
    token: 'eyJhbGciOiJFUzI1NksifQ.payload.sig',
  },
  presenceOpen: { type: 'presence-open', durationMs: 15 * 60 * 1000 },
  presenceClose: { type: 'presence-close' },
  presenceBroadcast: {
    type: 'presence-broadcast',
    open: [
      { did: DID_A, expiresAt: 1_800_000_000_000 },
      { did: DID_B, expiresAt: 1_800_000_060_000 },
    ],
  },
  joinRequest: { type: 'join-request', to: DID_B },
  sdpOffer: { type: 'sdp-offer', to: DID_B, sdp: 'v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\n' },
  sdpAnswer: { type: 'sdp-answer', to: DID_A, sdp: 'v=0\r\no=- 98882 2 IN IP4 127.0.0.1\r\n' },
  iceCandidate: {
    type: 'ice-candidate',
    to: DID_B,
    candidate: {
      candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  },
  error: { type: 'error', code: 'auth-failed', message: 'DID verification failed' },
} as const;

describe('AuthHandshake', () => {
  test('parses a valid handshake', () => {
    const r = AuthHandshake.safeParse(valid.authHandshake);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.did).toBe(DID_A);
      expect(r.data.token).toBe(valid.authHandshake.token);
    }
  });
  test('rejects a did without the did: prefix', () => {
    expect(
      AuthHandshake.safeParse({ ...valid.authHandshake, did: 'plc:alice1234abcdef' }).success,
    ).toBe(false);
  });
  test('rejects a missing token', () => {
    const { token: _token, ...rest } = valid.authHandshake;
    expect(AuthHandshake.safeParse(rest).success).toBe(false);
  });
  test('rejects an empty token', () => {
    expect(AuthHandshake.safeParse({ ...valid.authHandshake, token: '' }).success).toBe(false);
  });
});

describe('PresenceOpen', () => {
  test('parses a valid presence-open with durationMs', () => {
    const r = PresenceOpen.safeParse(valid.presenceOpen);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.durationMs).toBe(900000);
  });
  test('rejects a missing durationMs', () => {
    expect(PresenceOpen.safeParse({ type: 'presence-open' }).success).toBe(false);
  });
  test('rejects a zero or negative durationMs', () => {
    expect(PresenceOpen.safeParse({ type: 'presence-open', durationMs: 0 }).success).toBe(false);
    expect(PresenceOpen.safeParse({ type: 'presence-open', durationMs: -1 }).success).toBe(false);
  });
  test('rejects a fractional durationMs', () => {
    expect(PresenceOpen.safeParse({ type: 'presence-open', durationMs: 1000.5 }).success).toBe(
      false,
    );
  });
  test('rejects a string durationMs (no coercion on the wire)', () => {
    expect(PresenceOpen.safeParse({ type: 'presence-open', durationMs: '900000' }).success).toBe(
      false,
    );
  });
});

describe('PresenceClose', () => {
  test('parses a valid presence-close', () => {
    expect(PresenceClose.safeParse(valid.presenceClose).success).toBe(true);
  });
  test('rejects a wrong type literal', () => {
    expect(PresenceClose.safeParse({ type: 'presence-open' }).success).toBe(false);
  });
});

describe('PresenceBroadcast', () => {
  test('parses a broadcast with multiple open mutuals', () => {
    const r = PresenceBroadcast.safeParse(valid.presenceBroadcast);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.open).toHaveLength(2);
      expect(r.data.open[0]!.did).toBe(DID_A);
      expect(r.data.open[0]!.expiresAt).toBe(1_800_000_000_000);
    }
  });
  test('parses an empty open list (nobody present)', () => {
    expect(PresenceBroadcast.safeParse({ type: 'presence-broadcast', open: [] }).success).toBe(
      true,
    );
  });
  test('rejects open that is not an array', () => {
    expect(
      PresenceBroadcast.safeParse({ type: 'presence-broadcast', open: { did: DID_A } }).success,
    ).toBe(false);
  });
  test('rejects an entry missing expiresAt', () => {
    expect(
      PresenceBroadcast.safeParse({ type: 'presence-broadcast', open: [{ did: DID_A }] }).success,
    ).toBe(false);
  });
  test('rejects an entry with a non-did identifier', () => {
    expect(
      PresenceBroadcast.safeParse({
        type: 'presence-broadcast',
        open: [{ did: 'alice.example.com', expiresAt: 1_800_000_000_000 }],
      }).success,
    ).toBe(false);
  });
});

describe('JoinRequest', () => {
  test('parses a valid join-request', () => {
    const r = JoinRequest.safeParse(valid.joinRequest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.to).toBe(DID_B);
  });
  test('rejects a missing target', () => {
    expect(JoinRequest.safeParse({ type: 'join-request' }).success).toBe(false);
  });
  test('rejects a non-did target', () => {
    expect(JoinRequest.safeParse({ type: 'join-request', to: 'bob' }).success).toBe(false);
  });
});

describe('SdpOffer / SdpAnswer', () => {
  test('parses a valid offer', () => {
    const r = SdpOffer.safeParse(valid.sdpOffer);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sdp).toContain('v=0');
  });
  test('parses a valid answer', () => {
    expect(SdpAnswer.safeParse(valid.sdpAnswer).success).toBe(true);
  });
  test('offer accepts an optional relay-stamped from did', () => {
    expect(SdpOffer.safeParse({ ...valid.sdpOffer, from: DID_A }).success).toBe(true);
  });
  test('rejects an offer missing sdp', () => {
    const { sdp: _sdp, ...rest } = valid.sdpOffer;
    expect(SdpOffer.safeParse(rest).success).toBe(false);
  });
  test('rejects an offer with empty sdp', () => {
    expect(SdpOffer.safeParse({ ...valid.sdpOffer, sdp: '' }).success).toBe(false);
  });
  test('rejects an answer missing to', () => {
    const { to: _to, ...rest } = valid.sdpAnswer;
    expect(SdpAnswer.safeParse(rest).success).toBe(false);
  });
  test('answer schema rejects an offer message (literal discriminants are distinct)', () => {
    expect(SdpAnswer.safeParse(valid.sdpOffer).success).toBe(false);
  });
});

describe('IceCandidate', () => {
  test('parses a valid candidate', () => {
    const r = IceCandidate.safeParse(valid.iceCandidate);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.candidate.candidate).toContain('typ host');
  });
  test('accepts null sdpMid / sdpMLineIndex (RTCIceCandidateInit allows null)', () => {
    expect(
      IceCandidate.safeParse({
        type: 'ice-candidate',
        to: DID_B,
        candidate: { candidate: 'candidate:2 1 UDP 1 198.51.100.7 3478 typ srflx', sdpMid: null, sdpMLineIndex: null },
      }).success,
    ).toBe(true);
  });
  test('accepts a candidate with sdpMid/sdpMLineIndex omitted', () => {
    expect(
      IceCandidate.safeParse({
        type: 'ice-candidate',
        to: DID_B,
        candidate: { candidate: 'candidate:3 1 UDP 1 203.0.113.9 3478 typ srflx' },
      }).success,
    ).toBe(true);
  });
  test('rejects a missing candidate payload', () => {
    expect(IceCandidate.safeParse({ type: 'ice-candidate', to: DID_B }).success).toBe(false);
  });
  test('rejects a non-string inner candidate', () => {
    expect(
      IceCandidate.safeParse({
        type: 'ice-candidate',
        to: DID_B,
        candidate: { candidate: 42 },
      }).success,
    ).toBe(false);
  });
  test('rejects a numeric sdpMid', () => {
    expect(
      IceCandidate.safeParse({
        ...valid.iceCandidate,
        candidate: { ...valid.iceCandidate.candidate, sdpMid: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('ErrorMessage', () => {
  test('parses a valid error', () => {
    const r = ErrorMessage.safeParse(valid.error);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe('auth-failed');
  });
  test('rejects a missing code', () => {
    expect(ErrorMessage.safeParse({ type: 'error', message: 'boom' }).success).toBe(false);
  });
  test('rejects an empty code', () => {
    expect(ErrorMessage.safeParse({ ...valid.error, code: '' }).success).toBe(false);
  });
});

describe('SignalingMessage discriminated union', () => {
  test('parses every valid message type and preserves its discriminant', () => {
    for (const msg of Object.values(valid)) {
      const r = SignalingMessage.safeParse(msg);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.type).toBe(msg.type);
    }
  });
  test('rejects an unknown type', () => {
    expect(SignalingMessage.safeParse({ type: 'call-start', to: DID_B }).success).toBe(false);
  });
  test('rejects a message with no type field', () => {
    expect(SignalingMessage.safeParse({ to: DID_B, sdp: 'v=0' }).success).toBe(false);
  });
  test('rejects non-object payloads', () => {
    expect(SignalingMessage.safeParse(null).success).toBe(false);
    expect(SignalingMessage.safeParse(undefined).success).toBe(false);
    expect(SignalingMessage.safeParse('presence-open').success).toBe(false);
    expect(SignalingMessage.safeParse(42).success).toBe(false);
    expect(SignalingMessage.safeParse([valid.presenceOpen]).success).toBe(false);
  });
  test('discrimination routes by type: a well-formed body under the wrong type fails', () => {
    // sdp-offer discriminant with join-request body: must fail on missing sdp,
    // proving the union validates against the schema selected by `type`.
    expect(SignalingMessage.safeParse({ type: 'sdp-offer', to: DID_B }).success).toBe(false);
  });
  test('round-trips every message type through JSON (wire format)', () => {
    for (const msg of Object.values(valid)) {
      const r = SignalingMessage.safeParse(JSON.parse(JSON.stringify(msg)));
      expect(r.success).toBe(true);
    }
  });
});
