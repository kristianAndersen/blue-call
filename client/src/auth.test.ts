// @vitest-environment jsdom
/**
 * U15 (red phase): failing tests for the client OAuth wrapper (client/src/auth.ts).
 *
 * Contract under test:
 *   login(handle)    - initiates the atproto OAuth flow for the given handle
 *   handleCallback() - processes the OAuth redirect callback and restores the session
 *   getSession()     - resolves { did, mintServiceAuth(aud) }, or a falsy value when logged out
 *   logout()         - revokes/clears the current session
 *
 * `@atproto/oauth-client-browser` is fully mocked via a vi.mock factory: no
 * network, no IndexedDB, no real OAuth server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ALICE_DID = 'did:plc:alice1234abcdefgh';
const ALICE_HANDLE = 'alice.bsky.social';
const SERVICE_TOKEN = 'mock-service-auth-jwt';
const SIGNALING_LXM = 'com.bluecall.signaling.connect';

const { mockClient, mockSession } = vi.hoisted(() => {
  const mockSession = {
    sub: 'did:plc:alice1234abcdefgh',
    did: 'did:plc:alice1234abcdefgh',
    fetchHandler: vi.fn(),
    signOut: vi.fn(),
    getTokenInfo: vi.fn(),
  };
  const mockClient = {
    init: vi.fn(),
    initCallback: vi.fn(),
    initRestore: vi.fn(),
    restore: vi.fn(),
    signIn: vi.fn(),
    signInRedirect: vi.fn(),
    signInPopup: vi.fn(),
    revoke: vi.fn(),
    readCallbackParams: vi.fn(),
    dispose: vi.fn(),
  };
  return { mockClient, mockSession };
});

vi.mock('@atproto/oauth-client-browser', () => {
  class MockBrowserOAuthClient {
    static load = vi.fn(async () => mockClient);
    constructor() {
      // Whether auth.ts uses `new BrowserOAuthClient(...)` or the static
      // `BrowserOAuthClient.load(...)`, it gets the same shared mock instance.
      return mockClient as unknown as MockBrowserOAuthClient;
    }
  }
  return {
    BrowserOAuthClient: MockBrowserOAuthClient,
    buildLoopbackClientId: vi.fn(() => 'http://localhost'),
  };
});

type Session = { did: string; mintServiceAuth: (aud: string) => Promise<string> };
type AuthModule = {
  login: (handle: string) => Promise<unknown>;
  handleCallback: () => Promise<unknown>;
  getSession: () => Promise<Session | null | undefined>;
  logout: () => Promise<unknown>;
};

/** Fresh module state per test so one test's login/logout can't leak into another. */
async function loadAuth(): Promise<AuthModule> {
  vi.resetModules();
  return (await import('./auth')) as AuthModule;
}

/** No stored session, no OAuth params in the callback URL. */
function primeLoggedOut() {
  mockClient.init.mockResolvedValue(undefined);
  mockClient.initRestore.mockResolvedValue(undefined);
  mockClient.initCallback.mockRejectedValue(new Error('no OAuth callback params in URL'));
  mockClient.readCallbackParams.mockReturnValue(null);
}

/** Callback URL carries OAuth params; the client restores mockSession. */
function primeLoggedIn() {
  mockClient.init.mockResolvedValue({ session: mockSession, state: null });
  mockClient.initRestore.mockResolvedValue({ session: mockSession });
  mockClient.initCallback.mockResolvedValue({ session: mockSession, state: null });
  mockClient.readCallbackParams.mockReturnValue(
    new URLSearchParams('code=abc123&state=xyz789&iss=https%3A%2F%2Fpds.example'),
  );
}

/** All sign-in style calls (redirect, popup, or plain), flattened. */
function signInCalls(): unknown[][] {
  return [
    ...mockClient.signIn.mock.calls,
    ...mockClient.signInRedirect.mock.calls,
    ...mockClient.signInPopup.mock.calls,
  ];
}

/** fetchHandler calls that target com.atproto.server.getServiceAuth, decoded. */
function serviceAuthRequests(): string[] {
  return mockSession.fetchHandler.mock.calls
    .map((call) => decodeURIComponent(String(call[0])))
    .filter((path) => path.includes('com.atproto.server.getServiceAuth'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.fetchHandler.mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ token: SERVICE_TOKEN }),
      }) as unknown as Response,
  );
  mockSession.signOut.mockResolvedValue(undefined);
  mockSession.getTokenInfo.mockResolvedValue({
    sub: ALICE_DID,
    aud: 'https://pds.example',
    iss: 'https://pds.example',
    scope: 'atproto',
  });
  mockClient.signIn.mockResolvedValue(mockSession);
  mockClient.signInRedirect.mockResolvedValue(undefined);
  mockClient.signInPopup.mockResolvedValue(mockSession);
  mockClient.restore.mockResolvedValue(mockSession);
  mockClient.revoke.mockResolvedValue(undefined);
  mockClient.dispose.mockResolvedValue(undefined);
  primeLoggedOut();
});

describe('login(handle)', () => {
  it('initiates the OAuth flow with the given handle', async () => {
    const auth = await loadAuth();
    await auth.login(ALICE_HANDLE);

    const calls = signInCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(ALICE_HANDLE);
  });

  it('rejects an empty handle without contacting the OAuth client', async () => {
    const auth = await loadAuth();
    await expect((async () => auth.login(''))()).rejects.toThrow();
    expect(signInCalls()).toHaveLength(0);
  });

  it('strips a leading @ from a user-typed handle before signing in', async () => {
    const auth = await loadAuth();
    await auth.login('@krille.bsky.social');

    const calls = signInCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('krille.bsky.social');
  });

  it('trims surrounding whitespace from a user-typed handle before signing in', async () => {
    const auth = await loadAuth();
    await auth.login('  krille.bsky.social ');

    const calls = signInCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('krille.bsky.social');
  });

  it('strips a leading @ and trims whitespace together', async () => {
    const auth = await loadAuth();
    await auth.login('@krille.bsky.social ');

    const calls = signInCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('krille.bsky.social');
  });
});

describe('handleCallback()', () => {
  it('restores the session from the OAuth callback', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();

    const session = await auth.getSession();
    expect(session).toBeTruthy();
    expect(session!.did).toBe(ALICE_DID);
  });

  it('resolves without a session when the URL has no OAuth params', async () => {
    const auth = await loadAuth();
    await auth.handleCallback(); // must not reject

    expect(await auth.getSession()).toBeFalsy();
  });
});

describe('getSession()', () => {
  it('returns a falsy value when nobody is logged in', async () => {
    const auth = await loadAuth();
    expect(await auth.getSession()).toBeFalsy();
  });

  it('exposes the DID of the restored session', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();

    const session = await auth.getSession();
    expect(session!.did).toBe(ALICE_DID);
    expect(typeof session!.mintServiceAuth).toBe('function');
  });

  it('mintServiceAuth requests an audience-scoped service token and returns it', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();
    const session = await auth.getSession();

    const aud = 'did:web:signaling.example.com';
    const token = await session!.mintServiceAuth(aud);

    expect(token).toBe(SERVICE_TOKEN);
    const requests = serviceAuthRequests();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]).toContain(aud);
  });

  it('mintServiceAuth scopes each token to the audience it was asked for', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();
    const session = await auth.getSession();

    await session!.mintServiceAuth('did:web:first.example.com');
    await session!.mintServiceAuth('did:web:second.example.com');

    const requests = serviceAuthRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('did:web:first.example.com');
    expect(requests[0]).not.toContain('did:web:second.example.com');
    expect(requests[1]).toContain('did:web:second.example.com');
  });

  it('mintServiceAuth requests the lxm-bound rpc scope so the PDS does not 403', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();
    const session = await auth.getSession();

    await session!.mintServiceAuth('did:web:signaling.example.com');

    const requests = serviceAuthRequests();
    expect(requests[0]).toContain(`lxm=${SIGNALING_LXM}`);
  });

  it('mintServiceAuth rejects when the PDS request fails', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();
    const session = await auth.getSession();

    mockSession.fetchHandler.mockRejectedValue(new Error('network down'));
    await expect((async () => session!.mintServiceAuth('did:web:signaling.example.com'))()).rejects.toThrow();
  });
});

describe('mintServiceAuth dev fallback (env-gated bypass while getServiceAuth 403 is root-caused)', () => {
  it('returns the literal dev-unverified token instead of throwing on a non-ok PDS response when import.meta.env.DEV is true', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();
    const session = await auth.getSession();

    mockSession.fetchHandler.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    } as unknown as Response);

    const token = await session!.mintServiceAuth('did:web:signaling.example.com');
    expect(token).toBe('dev-unverified');
  });

  it('still throws on a non-ok PDS response when import.meta.env.DEV is false', async () => {
    vi.stubEnv('DEV', false);
    try {
      primeLoggedIn();
      const auth = await loadAuth();
      await auth.handleCallback();
      const session = await auth.getSession();

      mockSession.fetchHandler.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({}),
      } as unknown as Response);

      await expect(
        (async () => session!.mintServiceAuth('did:web:signaling.example.com'))(),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('logout()', () => {
  it('revokes or signs out the current session', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();

    await auth.logout();

    const revocations = mockSession.signOut.mock.calls.length + mockClient.revoke.mock.calls.length;
    expect(revocations).toBeGreaterThanOrEqual(1);
    if (mockClient.revoke.mock.calls.length > 0) {
      expect(mockClient.revoke).toHaveBeenCalledWith(ALICE_DID);
    }
  });

  it('clears the session so getSession returns a falsy value', async () => {
    primeLoggedIn();
    const auth = await loadAuth();
    await auth.handleCallback();
    expect(await auth.getSession()).toBeTruthy();

    await auth.logout();
    primeLoggedOut(); // a revoked session can no longer be restored by the client

    expect(await auth.getSession()).toBeFalsy();
  });

  it('resolves without throwing when nobody is logged in', async () => {
    const auth = await loadAuth();
    await expect((async () => auth.logout())()).resolves.not.toThrow();
    expect(await auth.getSession()).toBeFalsy();
  });
});

describe('integration: full auth lifecycle', () => {
  it('callback -> session -> mint token -> logout -> no session', async () => {
    primeLoggedIn();
    const auth = await loadAuth();

    await auth.handleCallback();
    const session = await auth.getSession();
    expect(session!.did).toBe(ALICE_DID);

    const token = await session!.mintServiceAuth('did:web:signaling.example.com');
    expect(token).toBe(SERVICE_TOKEN);

    await auth.logout();
    primeLoggedOut();
    expect(await auth.getSession()).toBeFalsy();
  });
});
