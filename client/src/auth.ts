import { BrowserOAuthClient, buildLoopbackClientId, type OAuthSession } from '@atproto/oauth-client-browser';

const HANDLE_RESOLVER = 'https://bsky.social';

export type Session = {
  did: string;
  mintServiceAuth: (aud: string) => Promise<string>;
};

let clientPromise: Promise<BrowserOAuthClient> | undefined;
let currentSession: OAuthSession | undefined;
let initialized = false;

function isLoopback(): boolean {
  const { hostname } = window.location;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function getClientId(): string {
  return isLoopback()
    ? buildLoopbackClientId(window.location)
    : `${window.location.origin}/client-metadata.json`;
}

function getClient(): Promise<BrowserOAuthClient> {
  if (!clientPromise) {
    clientPromise = BrowserOAuthClient.load({
      clientId: getClientId(),
      handleResolver: HANDLE_RESOLVER,
    });
  }
  return clientPromise;
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const client = await getClient();
  const result = await client.init();
  if (result?.session) {
    currentSession = result.session;
  }
}

export async function login(handle: string): Promise<void> {
  if (!handle) {
    throw new Error('login requires a non-empty handle');
  }
  const normalizedHandle = handle.trim().replace(/^@/, '');
  const client = await getClient();
  await client.signIn(normalizedHandle);
}

export async function handleCallback(): Promise<void> {
  await ensureInitialized();
}

export async function getSession(): Promise<Session | null> {
  await ensureInitialized();
  if (!currentSession) return null;

  const session = currentSession;
  return {
    did: session.did,
    mintServiceAuth: async (aud: string): Promise<string> => {
      const res = await session.fetchHandler(
        `/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}`,
      );
      if (!res.ok) {
        throw new Error(`failed to mint service auth token: ${res.status}`);
      }
      const body = (await res.json()) as { token: string };
      return body.token;
    },
  };
}

export async function logout(): Promise<void> {
  if (!currentSession) return;
  const session = currentSession;
  currentSession = undefined;
  await session.signOut();
}
