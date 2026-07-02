// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/svelte';
import App from './App.svelte';
import type { Profile } from './mutuals';

// Integration contract for the App shell (U33/U34). The four module
// boundaries — auth, mutuals, signaling-client, webrtc-call — are mocked;
// everything between them (presence stores, PresenceToggle,
// MutualsPresencePanel, CallView, App's own routing) runs for real.
//
// Pinned flows:
//   logged-out            -> login screen; submitting a handle calls auth.login
//   OAuth callback URL    -> auth.handleCallback runs on mount
//   logged-in             -> dashboard mounts PresenceToggle + MutualsPresencePanel,
//                            fetches mutuals for the session did, connects signaling
//   presence-broadcast    -> open mutual grows a halo; clicking it constructs a
//                            WebRTCCall against that mutual, calls placeCall,
//                            and mounts CallView
//   hang up               -> CallView unmounts, dashboard returns
const h = vi.hoisted(() => {
  type Handler = (msg: unknown) => void;

  class MockSignalingClient {
    options: Record<string, any>;
    handlers = new Map<string, Set<Handler>>();
    connect = vi.fn();
    disconnect = vi.fn();
    send = vi.fn();

    constructor(options: Record<string, any>) {
      this.options = options;
      signalingInstances.push(this);
    }

    on(type: string, fn: Handler): void {
      let set = this.handlers.get(type);
      if (!set) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(fn);
    }

    off(type: string, fn: Handler): void {
      this.handlers.get(type)?.delete(fn);
    }

    // Test-only: deliver a server frame to whatever App subscribed.
    emit(msg: { type: string; [k: string]: unknown }): void {
      for (const fn of this.handlers.get(msg.type) ?? []) fn(msg);
    }
  }

  class MockWebRTCCall {
    state = 'connecting';
    failureReason: string | null = null;
    localStream: MediaStream | null = null;
    remoteStream: MediaStream | null = null;
    options: Record<string, any>;
    placeCall = vi.fn(async () => {});
    acceptCall = vi.fn(async () => {});
    // Mirrors the real WebRTCCall: hangUp tears down, moves to 'ended', and
    // reports through the onStateChange option — App's cue to route back.
    hangUp = vi.fn(() => {
      this.state = 'ended';
      this.options?.onStateChange?.('ended');
    });

    constructor(options: Record<string, any>) {
      this.options = options;
      webrtcInstances.push(this);
    }
  }

  const signalingInstances: InstanceType<typeof MockSignalingClient>[] = [];
  const webrtcInstances: InstanceType<typeof MockWebRTCCall>[] = [];

  return {
    login: vi.fn(),
    handleCallback: vi.fn(),
    getSession: vi.fn(),
    logout: vi.fn(),
    fetchMutuals: vi.fn(),
    MockSignalingClient,
    MockWebRTCCall,
    signalingInstances,
    webrtcInstances,
  };
});

vi.mock('./auth', () => ({
  login: h.login,
  handleCallback: h.handleCallback,
  getSession: h.getSession,
  logout: h.logout,
}));
vi.mock('./mutuals', () => ({
  fetchMutuals: h.fetchMutuals,
}));
vi.mock('./signaling-client', () => ({
  SignalingClient: h.MockSignalingClient,
}));
vi.mock('./webrtc-call', () => ({
  WebRTCCall: h.MockWebRTCCall,
}));

const SELF_DID = 'did:plc:selfselfself';
const alice: Profile = { did: 'did:plc:alice1234', handle: 'alice.test', displayName: 'Alice' };
const bob: Profile = { did: 'did:plc:bob5678', handle: 'bob.test' };

function mockLoggedOut() {
  h.getSession.mockResolvedValue(null);
}

function mockLoggedIn() {
  const session = {
    did: SELF_DID,
    mintServiceAuth: vi.fn(async () => 'service-auth-token'),
  };
  h.getSession.mockResolvedValue(session);
  h.fetchMutuals.mockResolvedValue(
    new Map<string, Profile>([
      [alice.did, alice],
      [bob.did, bob],
    ]),
  );
  return session;
}

const declareOpenButton = () => screen.findByRole('button', { name: /declare open/i });
const queryJoinButtons = () => screen.queryAllByRole('button', { name: /join|call/i });

async function renderDashboard() {
  mockLoggedIn();
  const rendered = render(App);
  await declareOpenButton();
  const signaling = h.signalingInstances.at(-1);
  expect(signaling, 'App must construct a SignalingClient once logged in').toBeTruthy();
  return { ...rendered, signaling: signaling! };
}

async function openAliceAndJoin(signaling: InstanceType<typeof h.MockSignalingClient>) {
  await act(() =>
    signaling.emit({
      type: 'presence-broadcast',
      open: [{ did: alice.did, expiresAt: Date.now() + 60_000 }],
    }),
  );
  const joinButton = await screen.findByRole('button', { name: /join|call/i });
  await fireEvent.click(joinButton);
  await vi.waitFor(() => expect(h.webrtcInstances.length).toBe(1));
  return h.webrtcInstances[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.signalingInstances.length = 0;
  h.webrtcInstances.length = 0;
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
});

describe('logged out', () => {
  test('renders a login screen with a handle input, not the dashboard', async () => {
    mockLoggedOut();
    render(App);

    expect(await screen.findByRole('textbox')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /declare open/i })).toBeNull();
    expect(h.fetchMutuals).not.toHaveBeenCalled();
    expect(h.signalingInstances).toHaveLength(0);
  });

  test('submitting a handle calls auth.login with that handle', async () => {
    mockLoggedOut();
    render(App);

    const input = await screen.findByRole('textbox');
    await fireEvent.input(input, { target: { value: 'alice.test' } });
    await fireEvent.click(screen.getByRole('button', { name: /log ?in|sign ?in|connect/i }));

    expect(h.login).toHaveBeenCalledWith('alice.test');
  });
});

describe('OAuth callback', () => {
  test('a callback URL routes through auth.handleCallback on mount', async () => {
    window.history.replaceState(
      {},
      '',
      '/?code=abc123&state=xyz789&iss=https%3A%2F%2Fbsky.social',
    );
    mockLoggedOut();
    render(App);

    await vi.waitFor(() => expect(h.handleCallback).toHaveBeenCalled());
  });
});

describe('logged in dashboard', () => {
  test('mounts PresenceToggle and MutualsPresencePanel with the fetched mutuals', async () => {
    const { container } = await renderDashboard();

    expect(h.fetchMutuals).toHaveBeenCalledWith(SELF_DID);
    await vi.waitFor(() => {
      const text = container.textContent ?? '';
      expect(text).toContain('alice.test');
      expect(text).toContain('bob.test');
    });
    // Login screen is gone; nobody is open yet, so no halos.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(queryJoinButtons()).toHaveLength(0);
  });

  test('connects the signaling client for the session did', async () => {
    const { signaling } = await renderDashboard();

    expect(signaling.options.did).toBe(SELF_DID);
    expect(signaling.connect).toHaveBeenCalled();
  });

  test('declaring open sends presence-open through the signaling client', async () => {
    const { signaling } = await renderDashboard();

    await fireEvent.click(await declareOpenButton());

    expect(signaling.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'presence-open' }),
    );
  });
});

describe('call flow', () => {
  test("clicking an open mutual's halo starts a call against that mutual and mounts CallView", async () => {
    const { signaling } = await renderDashboard();
    expect(queryJoinButtons()).toHaveLength(0);

    const call = await openAliceAndJoin(signaling);

    expect(call.options.peerDid).toBe(alice.did);
    expect(call.options.selfDid).toBe(SELF_DID);
    expect(call.placeCall).toHaveBeenCalledTimes(1);

    // CallView is mounted: hang-up affordance and both video elements.
    expect(await screen.findByRole('button', { name: /hang ?up/i })).toBeTruthy();
    expect(document.querySelectorAll('video').length).toBeGreaterThanOrEqual(2);
  });

  test('hanging up ends the call and returns to the dashboard', async () => {
    const { signaling } = await renderDashboard();
    const call = await openAliceAndJoin(signaling);

    await fireEvent.click(await screen.findByRole('button', { name: /hang ?up/i }));

    expect(call.hangUp).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: /hang ?up/i })).toBeNull(),
    );
    expect(await declareOpenButton()).toBeTruthy();
  });
});
