/**
 * U7 (red phase) — failing tests for server DID verification (`server/src/auth.ts`).
 *
 * Contract under test (per plan U8 + Architecture Decision 3, Option A):
 *
 *   export async function verifyClientAuth(
 *     jwtStr: string,
 *     serverDid: string,
 *   ): Promise<{ did: string }>
 *
 * The module verifies a client-presented `com.atproto.server.getServiceAuth`-minted
 * JWT locally: it must call `verifyJwt` from `@atproto/xrpc-server` with
 * `ownDid = serverDid` (audience check), resolve the claimed issuer's signing key
 * via `IdResolver` from `@atproto/identity` (`idResolver.did.resolveAtprotoKey`),
 * and resolve to the verified account DID (issuer, stripped of any `#fragment`).
 * Any verification failure (audience, expiry, signature, malformed token,
 * unresolvable issuer) must reject.
 *
 * Both atproto modules are mocked below (no network). The fake `verifyJwt`
 * mirrors the real one's contract — 3-part token parse, exp check, aud check
 * against `ownDid`, then signature check via the `getSigningKey` callback — so
 * these tests exercise auth.ts's wiring, error propagation, and result shape
 * against structurally realistic tokens without real key material.
 *
 * auth.ts may import: { verifyJwt, AuthRequiredError } from '@atproto/xrpc-server'
 *                     { IdResolver } from '@atproto/identity'
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const SERVER_DID = 'did:web:signal.blue-call.example';
const CLIENT_DID = 'did:plc:aliceclientdid1234567890';
const OTHER_AUD = 'did:web:some-other-service.example';
const CLIENT_SIGNING_KEY = 'did:key:zClientSigningKeyFake';

const SIGNING_KEYS: Record<string, string> = {
  [CLIENT_DID]: CLIENT_SIGNING_KEY,
};

class FakeAuthRequiredError extends Error {}

const b64u = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Mint a structurally realistic (but fake-signed) service JWT. */
function mintToken(opts: {
  iss?: string;
  aud?: string;
  exp?: number;
  sig?: string;
}): string {
  const {
    iss = CLIENT_DID,
    aud = SERVER_DID,
    exp = Math.floor(Date.now() / 1000) + 300,
    sig = `sig:${CLIENT_SIGNING_KEY}`,
  } = opts;
  const header = b64u({ typ: 'JWT', alg: 'ES256K' });
  const payload = b64u({ iss, aud, exp, lxm: null });
  return `${header}.${payload}.${sig}`;
}

// Fake verifyJwt mirroring @atproto/xrpc-server's verification order and
// signature: (jwtStr, ownDid, lxm, getSigningKey) => Promise<payload>.
const verifyJwtMock = mock(
  async (
    jwtStr: string,
    ownDid: string | null,
    _lxm: string | null,
    getSigningKey: (iss: string, forceRefresh: boolean) => Promise<string>,
  ) => {
    const parts = jwtStr.split('.');
    if (parts.length !== 3) {
      throw new FakeAuthRequiredError('poorly formatted jwt');
    }
    let payload: { iss: string; aud: string; exp: number };
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new FakeAuthRequiredError('poorly formatted jwt');
    }
    if (
      typeof payload?.iss !== 'string' ||
      typeof payload?.aud !== 'string' ||
      typeof payload?.exp !== 'number'
    ) {
      throw new FakeAuthRequiredError('poorly formatted jwt');
    }
    if (payload.exp * 1000 <= Date.now()) {
      throw new FakeAuthRequiredError('jwt expired');
    }
    if (ownDid !== null && payload.aud !== ownDid) {
      throw new FakeAuthRequiredError('jwt audience does not match service did');
    }
    const signingKey = await getSigningKey(payload.iss, false);
    if (parts[2] !== `sig:${signingKey}`) {
      throw new FakeAuthRequiredError('jwt signature does not match jwt issuer');
    }
    return payload;
  },
);

const resolveAtprotoKeyMock = mock(
  async (did: string, _forceRefresh?: boolean) => {
    const key = SIGNING_KEYS[did.split('#')[0]!];
    if (!key) throw new Error(`could not resolve signing key for ${did}`);
    return key;
  },
);

class FakeIdResolver {
  did = { resolveAtprotoKey: resolveAtprotoKeyMock };
  handle = {};
  constructor(_opts?: unknown) {}
}

mock.module('@atproto/xrpc-server', () => ({
  verifyJwt: verifyJwtMock,
  AuthRequiredError: FakeAuthRequiredError,
}));
mock.module('@atproto/identity', () => ({
  IdResolver: FakeIdResolver,
}));

// Imported after mock.module so auth.ts binds to the fakes. Red phase: this
// import itself fails (module does not exist yet) and the whole file errors.
const { verifyClientAuth } = await import('./auth');

beforeEach(() => {
  verifyJwtMock.mockClear();
  resolveAtprotoKeyMock.mockClear();
});

describe('verifyClientAuth — valid token', () => {
  test('resolves { did } for a valid token audience-scoped to our server DID', async () => {
    const result = await verifyClientAuth(mintToken({}), SERVER_DID);
    expect(result.did).toBe(CLIENT_DID);
  });

  test('performs verification via verifyJwt with ownDid = our server DID', async () => {
    await verifyClientAuth(mintToken({}), SERVER_DID);
    expect(verifyJwtMock).toHaveBeenCalledTimes(1);
    const [jwtArg, ownDidArg] = verifyJwtMock.mock.calls[0]!;
    expect(typeof jwtArg).toBe('string');
    expect(ownDidArg).toBe(SERVER_DID);
  });

  test('resolves the signing key of the claimed issuer via IdResolver', async () => {
    await verifyClientAuth(mintToken({}), SERVER_DID);
    expect(resolveAtprotoKeyMock).toHaveBeenCalled();
    const resolvedDids = resolveAtprotoKeyMock.mock.calls.map(
      (c) => (c[0] as string).split('#')[0],
    );
    expect(resolvedDids).toContain(CLIENT_DID);
  });

  test('strips a #fragment from the issuer when returning the account DID', async () => {
    const token = mintToken({ iss: `${CLIENT_DID}#atproto` });
    const result = await verifyClientAuth(token, SERVER_DID);
    expect(result.did).toBe(CLIENT_DID);
  });
});

describe('verifyClientAuth — rejections', () => {
  test('rejects a token whose aud is another service (wrong audience)', async () => {
    const token = mintToken({ aud: OTHER_AUD });
    await expect(verifyClientAuth(token, SERVER_DID)).rejects.toThrow();
  });

  test('rejects an expired token', async () => {
    const token = mintToken({ exp: Math.floor(Date.now() / 1000) - 300 });
    await expect(verifyClientAuth(token, SERVER_DID)).rejects.toThrow();
  });

  test('rejects a token whose signature does not match the issuer signing key', async () => {
    const token = mintToken({ sig: 'sig:did:key:zSomeOtherKeyEntirely' });
    await expect(verifyClientAuth(token, SERVER_DID)).rejects.toThrow();
  });

  test('rejects a malformed token (not three dot-separated parts)', async () => {
    await expect(verifyClientAuth('not-a-jwt', SERVER_DID)).rejects.toThrow();
    await expect(verifyClientAuth('only.two', SERVER_DID)).rejects.toThrow();
    await expect(verifyClientAuth('', SERVER_DID)).rejects.toThrow();
  });

  test('rejects a token whose payload segment is not base64url JSON', async () => {
    const header = b64u({ typ: 'JWT', alg: 'ES256K' });
    const token = `${header}.!!!not-base64-json!!!.sig:${CLIENT_SIGNING_KEY}`;
    await expect(verifyClientAuth(token, SERVER_DID)).rejects.toThrow();
  });

  test('rejects when the claimed issuer DID has no resolvable signing key', async () => {
    const unknownDid = 'did:plc:unknownissuer0000000000';
    const token = mintToken({ iss: unknownDid, sig: 'sig:whatever' });
    await expect(verifyClientAuth(token, SERVER_DID)).rejects.toThrow();
  });
});
