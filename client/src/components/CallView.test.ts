// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import type { CallState, FailureReason } from '../webrtc-call';
import CallView from './CallView.svelte';

// Contract (pinned by webrtc-call.test.ts / U30): the component receives a
// WebRTCCall-shaped object as a `call` prop and renders purely from its public
// surface: `state`, `failureReason`, `localStream`, `remoteStream`, `hangUp()`.
// The call is mocked here so these tests exercise only CallView's rendering
// and its calls into `hangUp()`. State transitions are driven by re-rendering
// with a call snapshot in the next state.

// jsdom has no MediaStream; a minimal stand-in is enough because the component
// only assigns streams to <video>.srcObject and never inspects tracks itself.
class FakeMediaStream {
  readonly id = `fake-stream-${Math.random().toString(36).slice(2)}`;
  getTracks(): MediaStreamTrack[] {
    return [];
  }
}

interface MockCall {
  state: CallState;
  failureReason: FailureReason;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  hangUp: ReturnType<typeof vi.fn>;
}

function createMockCall(overrides: Partial<MockCall> = {}): MockCall {
  return {
    state: 'connected',
    failureReason: null,
    localStream: new FakeMediaStream() as unknown as MediaStream,
    remoteStream: new FakeMediaStream() as unknown as MediaStream,
    hangUp: vi.fn(),
    ...overrides,
  };
}

function renderCallView(overrides: Partial<MockCall> = {}) {
  const call = createMockCall(overrides);
  const rendered = render(CallView, { props: { call } });
  return { call, ...rendered };
}

// Accessible-name matchers pin behavior, not copy: any reasonable label works.
const HANGUP_NAME = /hang\s*up|end|leave|cancel/i;
const RETRY_NAME = /retry|try again|reconnect/i;
const CONNECTING_TEXT = /connecting|calling|ringing/i;
const FAILED_TEXT = /could\s*n[o']?t\s+connect|unable to connect|connection failed/i;

const getHangupControl = () => screen.getByRole('button', { name: HANGUP_NAME });
const queryRetryControl = () => screen.queryByRole('button', { name: RETRY_NAME });

function videoSrcObjects(container: HTMLElement): unknown[] {
  return Array.from(container.querySelectorAll('video')).map(
    (v) => (v as HTMLVideoElement & { srcObject: unknown }).srcObject,
  );
}

function expectNoMissedCallBadge(container: HTMLElement) {
  expect(container.textContent ?? '').not.toMatch(/missed/i);
  expect(screen.queryByText(/missed/i)).toBeNull();
  expect(container.querySelector('[data-testid*="missed" i]')).toBeNull();
  expect(container.querySelector('[class*="missed" i]')).toBeNull();
  expect(container.querySelector('[aria-label*="missed" i]')).toBeNull();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('video wiring', () => {
  test('connected call renders local and remote video elements bound to the MediaStreams', () => {
    const { call, container } = renderCallView({ state: 'connected' });
    const srcObjects = videoSrcObjects(container);
    expect(srcObjects.length).toBeGreaterThanOrEqual(2);
    expect(srcObjects).toContain(call.localStream);
    expect(srcObjects).toContain(call.remoteStream);
  });

  test('local and remote streams land on distinct video elements', () => {
    const { call, container } = renderCallView({ state: 'connected' });
    const srcObjects = videoSrcObjects(container);
    const localIndex = srcObjects.indexOf(call.localStream);
    const remoteIndex = srcObjects.indexOf(call.remoteStream);
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).not.toBe(remoteIndex);
  });
});

describe('connecting state', () => {
  test('shows a connecting indicator', () => {
    const { container } = renderCallView({ state: 'connecting', remoteStream: null });
    expect(container.textContent ?? '').toMatch(CONNECTING_TEXT);
  });

  test('offers a control to abort the call attempt', () => {
    renderCallView({ state: 'connecting', remoteStream: null });
    expect(getHangupControl()).toBeTruthy();
  });

  test('does not show the failure message or call hangUp on mere render', () => {
    const { call, container } = renderCallView({ state: 'connecting', remoteStream: null });
    expect(container.textContent ?? '').not.toMatch(FAILED_TEXT);
    expect(call.hangUp).not.toHaveBeenCalled();
  });
});

describe('connected state', () => {
  test('no longer shows the connecting indicator', () => {
    const { container } = renderCallView({ state: 'connected' });
    expect(container.textContent ?? '').not.toMatch(CONNECTING_TEXT);
  });

  test('shows a hangup control and does not call hangUp on mere render', () => {
    const { call } = renderCallView({ state: 'connected' });
    expect(getHangupControl()).toBeTruthy();
    expect(call.hangUp).not.toHaveBeenCalled();
  });
});

describe('hangup control', () => {
  test('clicking hangup calls call.hangUp() exactly once', async () => {
    const { call } = renderCallView({ state: 'connected' });
    await fireEvent.click(getHangupControl());
    expect(call.hangUp).toHaveBeenCalledTimes(1);
  });
});

describe('failed state', () => {
  test('renders a could-not-connect message', () => {
    const { container } = renderCallView({
      state: 'failed',
      failureReason: 'could-not-connect',
      localStream: null,
      remoteStream: null,
    });
    expect(container.textContent ?? '').toMatch(FAILED_TEXT);
  });

  test('offers no TURN retry control', () => {
    renderCallView({
      state: 'failed',
      failureReason: 'could-not-connect',
      localStream: null,
      remoteStream: null,
    });
    expect(queryRetryControl()).toBeNull();
  });

  test('does not show the connecting indicator', () => {
    const { container } = renderCallView({
      state: 'failed',
      failureReason: 'could-not-connect',
      localStream: null,
      remoteStream: null,
    });
    expect(container.textContent ?? '').not.toMatch(CONNECTING_TEXT);
  });
});

describe('no missed-call badge in any state', () => {
  const states: Array<Partial<MockCall>> = [
    { state: 'connecting', remoteStream: null },
    { state: 'connected' },
    { state: 'failed', failureReason: 'could-not-connect', localStream: null, remoteStream: null },
    { state: 'ended', localStream: null, remoteStream: null },
  ];

  for (const overrides of states) {
    test(`state "${overrides.state}" renders no missed-call badge`, () => {
      const { container } = renderCallView(overrides);
      expectNoMissedCallBadge(container);
    });
  }
});

describe('full lifecycle integration', () => {
  test('connecting -> connected -> hangup, with no missed indicator at any point', async () => {
    const call = createMockCall({ state: 'connecting', remoteStream: null });
    const { container, rerender } = render(CallView, { props: { call } });

    // connecting
    expect(container.textContent ?? '').toMatch(CONNECTING_TEXT);
    expectNoMissedCallBadge(container);

    // connected (new snapshot of the same call after ICE succeeds)
    const connected = createMockCall({
      state: 'connected',
      localStream: call.localStream,
      remoteStream: new FakeMediaStream() as unknown as MediaStream,
      hangUp: call.hangUp,
    });
    await rerender({ call: connected });
    expect(container.textContent ?? '').not.toMatch(CONNECTING_TEXT);
    const srcObjects = videoSrcObjects(container);
    expect(srcObjects).toContain(connected.localStream);
    expect(srcObjects).toContain(connected.remoteStream);
    expectNoMissedCallBadge(container);

    // hangup tears down the call
    await fireEvent.click(getHangupControl());
    expect(connected.hangUp).toHaveBeenCalledTimes(1);
  });
});
