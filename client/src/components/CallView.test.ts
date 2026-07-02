// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import type { CallState, FailureReason } from '../webrtc-call';
import CallView from './CallView.svelte';

// Contract (pinned by webrtc-call.test.ts / U30, updated for the Svelte 5
// reactivity fix): the component receives plain reactive props —
// `callState`, `failureReason`, `localStream`, `remoteStream`, `onHangUp` —
// and renders purely from those props so a parent's `$state` reassignment of
// a stream re-runs the `$effect` bindings. State transitions are driven by
// re-rendering with the next prop snapshot.

// jsdom has no MediaStream; a minimal stand-in is enough because the component
// only assigns streams to <video>.srcObject and never inspects tracks itself.
class FakeMediaStream {
  readonly id = `fake-stream-${Math.random().toString(36).slice(2)}`;
  getTracks(): MediaStreamTrack[] {
    return [];
  }
}

interface MockCallViewProps {
  callState: CallState;
  failureReason: FailureReason;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onHangUp: () => void;
}

function createMockProps(overrides: Partial<MockCallViewProps> = {}): MockCallViewProps {
  return {
    callState: 'connected',
    failureReason: null,
    localStream: new FakeMediaStream() as unknown as MediaStream,
    remoteStream: new FakeMediaStream() as unknown as MediaStream,
    onHangUp: vi.fn(),
    ...overrides,
  };
}

function renderCallView(overrides: Partial<MockCallViewProps> = {}) {
  const props = createMockProps(overrides);
  const rendered = render(CallView, { props });
  return { props, ...rendered };
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
    const { props, container } = renderCallView({ callState: 'connected' });
    const srcObjects = videoSrcObjects(container);
    expect(srcObjects.length).toBeGreaterThanOrEqual(2);
    expect(srcObjects).toContain(props.localStream);
    expect(srcObjects).toContain(props.remoteStream);
  });

  test('local and remote streams land on distinct video elements', () => {
    const { props, container } = renderCallView({ callState: 'connected' });
    const srcObjects = videoSrcObjects(container);
    const localIndex = srcObjects.indexOf(props.localStream);
    const remoteIndex = srcObjects.indexOf(props.remoteStream);
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).not.toBe(remoteIndex);
  });
});

describe('connecting state', () => {
  test('shows a connecting indicator', () => {
    const { container } = renderCallView({ callState: 'connecting', remoteStream: null });
    expect(container.textContent ?? '').toMatch(CONNECTING_TEXT);
  });

  test('offers a control to abort the call attempt', () => {
    renderCallView({ callState: 'connecting', remoteStream: null });
    expect(getHangupControl()).toBeTruthy();
  });

  test('does not show the failure message or call onHangUp on mere render', () => {
    const { props, container } = renderCallView({ callState: 'connecting', remoteStream: null });
    expect(container.textContent ?? '').not.toMatch(FAILED_TEXT);
    expect(props.onHangUp).not.toHaveBeenCalled();
  });
});

describe('connected state', () => {
  test('no longer shows the connecting indicator', () => {
    const { container } = renderCallView({ callState: 'connected' });
    expect(container.textContent ?? '').not.toMatch(CONNECTING_TEXT);
  });

  test('shows a hangup control and does not call onHangUp on mere render', () => {
    const { props } = renderCallView({ callState: 'connected' });
    expect(getHangupControl()).toBeTruthy();
    expect(props.onHangUp).not.toHaveBeenCalled();
  });
});

describe('hangup control', () => {
  test('clicking hangup calls onHangUp exactly once', async () => {
    const { props } = renderCallView({ callState: 'connected' });
    await fireEvent.click(getHangupControl());
    expect(props.onHangUp).toHaveBeenCalledTimes(1);
  });
});

describe('failed state', () => {
  test('renders a could-not-connect message', () => {
    const { container } = renderCallView({
      callState: 'failed',
      failureReason: 'could-not-connect',
      localStream: null,
      remoteStream: null,
    });
    expect(container.textContent ?? '').toMatch(FAILED_TEXT);
  });

  test('offers no TURN retry control', () => {
    renderCallView({
      callState: 'failed',
      failureReason: 'could-not-connect',
      localStream: null,
      remoteStream: null,
    });
    expect(queryRetryControl()).toBeNull();
  });

  test('does not show the connecting indicator', () => {
    const { container } = renderCallView({
      callState: 'failed',
      failureReason: 'could-not-connect',
      localStream: null,
      remoteStream: null,
    });
    expect(container.textContent ?? '').not.toMatch(CONNECTING_TEXT);
  });
});

describe('no missed-call badge in any state', () => {
  const states: Array<Partial<MockCallViewProps>> = [
    { callState: 'connecting', remoteStream: null },
    { callState: 'connected' },
    { callState: 'failed', failureReason: 'could-not-connect', localStream: null, remoteStream: null },
    { callState: 'ended', localStream: null, remoteStream: null },
  ];

  for (const overrides of states) {
    test(`state "${overrides.callState}" renders no missed-call badge`, () => {
      const { container } = renderCallView(overrides);
      expectNoMissedCallBadge(container);
    });
  }
});

describe('full lifecycle integration', () => {
  test('connecting -> connected -> hangup, with no missed indicator at any point', async () => {
    const onHangUp = vi.fn();
    const localStream = new FakeMediaStream() as unknown as MediaStream;
    const props = createMockProps({ callState: 'connecting', remoteStream: null, localStream, onHangUp });
    const { container, rerender } = render(CallView, { props });

    // connecting
    expect(container.textContent ?? '').toMatch(CONNECTING_TEXT);
    expectNoMissedCallBadge(container);

    // connected (new prop snapshot after ICE succeeds)
    const remoteStream = new FakeMediaStream() as unknown as MediaStream;
    await rerender({ callState: 'connected', failureReason: null, localStream, remoteStream, onHangUp });
    expect(container.textContent ?? '').not.toMatch(CONNECTING_TEXT);
    const srcObjects = videoSrcObjects(container);
    expect(srcObjects).toContain(localStream);
    expect(srcObjects).toContain(remoteStream);
    expectNoMissedCallBadge(container);

    // hangup tears down the call
    await fireEvent.click(getHangupControl());
    expect(onHangUp).toHaveBeenCalledTimes(1);
  });
});
