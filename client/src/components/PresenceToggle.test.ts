// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/svelte';
import PresenceToggle from './PresenceToggle.svelte';

// Contract (pinned by presence-store.test.ts / U21): the component receives the
// presence store as a `store` prop and renders purely from its state. The store
// is mocked here so these tests exercise only PresenceToggle's rendering and
// its calls into `declareOpen(durationMs)` / `close()`.
interface PresenceState {
  open: boolean;
  remainingMs: number;
}

function createMockPresenceStore(initial: PresenceState = { open: false, remainingMs: 0 }) {
  let state: PresenceState = { ...initial };
  const subscribers = new Set<(s: PresenceState) => void>();
  const notify = () => {
    for (const fn of subscribers) fn(state);
  };
  return {
    subscribe(fn: (s: PresenceState) => void) {
      subscribers.add(fn);
      fn(state);
      return () => {
        subscribers.delete(fn);
      };
    },
    declareOpen: vi.fn((durationMs: number) => {
      state = { open: true, remainingMs: durationMs };
      notify();
    }),
    close: vi.fn(() => {
      state = { open: false, remainingMs: 0 };
      notify();
    }),
    // Test-only: simulate store-driven updates (countdown ticks, silent expiry).
    simulate(next: PresenceState) {
      state = { ...next };
      notify();
    },
    get isOpen() {
      return state.open;
    },
    get remainingMs() {
      return state.remainingMs;
    },
  };
}

function renderToggle(initial?: PresenceState) {
  const store = createMockPresenceStore(initial);
  const rendered = render(PresenceToggle, { props: { store } });
  return { store, ...rendered };
}

// Accessible-name matchers pin behavior, not copy: any reasonable label works.
const OPEN_NAME = /open|available|declare/i;
const CANCEL_NAME = /cancel|close|end/i;
const getOpenControl = () => screen.getByRole('button', { name: OPEN_NAME });
const queryOpenControl = () => screen.queryByRole('button', { name: OPEN_NAME });
const getCancelControl = () => screen.getByRole('button', { name: CANCEL_NAME });
const queryCancelControl = () => screen.queryByRole('button', { name: CANCEL_NAME });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('closed state', () => {
  test('renders an open-toggle control and no cancel control', () => {
    renderToggle();
    expect(getOpenControl()).toBeTruthy();
    expect(queryCancelControl()).toBeNull();
  });

  test('does not call declareOpen or close on mere render', () => {
    const { store } = renderToggle();
    expect(store.declareOpen).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
  });
});

describe('declaring open', () => {
  test('clicking the open control calls declareOpen exactly once with a positive duration', async () => {
    const { store } = renderToggle();
    await fireEvent.click(getOpenControl());
    expect(store.declareOpen).toHaveBeenCalledTimes(1);
    const durationMs = store.declareOpen.mock.calls[0][0];
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThan(0);
  });

  test('after declaring, a countdown for the remaining time is visible', async () => {
    const { store, container } = renderToggle();
    await fireEvent.click(getOpenControl());
    await act(() => store.simulate({ open: true, remainingMs: 60_000 }));
    // 60s remaining must surface as "1:00" or "60" (m:ss or seconds format).
    expect(container.textContent).toMatch(/\b(1:00|60)\b/);
  });
});

describe('live countdown', () => {
  test('renders the remaining time when open', () => {
    const { container } = renderToggle({ open: true, remainingMs: 60_000 });
    expect(container.textContent).toMatch(/\b(1:00|60)\b/);
  });

  test('countdown updates live as the store ticks down', async () => {
    const { store, container } = renderToggle({ open: true, remainingMs: 60_000 });
    const before = container.textContent;
    await act(() => store.simulate({ open: true, remainingMs: 59_000 }));
    expect(container.textContent).toMatch(/\b(0?:?59)\b/);
    expect(container.textContent).not.toBe(before);
    await act(() => store.simulate({ open: true, remainingMs: 58_000 }));
    expect(container.textContent).toMatch(/\b(0?:?58)\b/);
  });
});

describe('cancel control', () => {
  test('is visible while open and calls close() exactly once when clicked', async () => {
    const { store } = renderToggle({ open: true, remainingMs: 30_000 });
    const cancel = getCancelControl();
    await fireEvent.click(cancel);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(store.declareOpen).not.toHaveBeenCalled();
  });

  test('after close() flips the store, the closed state is rendered again', async () => {
    const { store } = renderToggle({ open: true, remainingMs: 30_000 });
    await fireEvent.click(getCancelControl());
    // mock close() already flipped state to closed and notified subscribers
    await act(() => {});
    expect(getOpenControl()).toBeTruthy();
    expect(queryCancelControl()).toBeNull();
  });
});

describe('silent expiry', () => {
  test('expiry renders the closed state with no alert or missed indicator in the DOM', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { store, container } = renderToggle({ open: true, remainingMs: 1_000 });

    await act(() => store.simulate({ open: false, remainingMs: 0 }));

    expect(getOpenControl()).toBeTruthy();
    expect(queryCancelControl()).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(container.textContent ?? '').not.toMatch(/missed/i);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('expiry does not trigger any store calls from the component', async () => {
    const { store } = renderToggle({ open: true, remainingMs: 1_000 });
    await act(() => store.simulate({ open: false, remainingMs: 0 }));
    expect(store.declareOpen).not.toHaveBeenCalled();
    expect(store.close).not.toHaveBeenCalled();
  });
});

describe('full lifecycle integration', () => {
  test('closed -> declare -> countdown -> cancel -> closed, with no missed indicator at any point', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { store, container } = renderToggle();

    // closed
    expect(getOpenControl()).toBeTruthy();

    // declare (mock store flips to open with the requested duration)
    await fireEvent.click(getOpenControl());
    expect(store.declareOpen).toHaveBeenCalledTimes(1);
    await act(() => store.simulate({ open: true, remainingMs: 30_000 }));
    expect(container.textContent).toMatch(/\b(0?:?30)\b/);

    // tick
    await act(() => store.simulate({ open: true, remainingMs: 29_000 }));
    expect(container.textContent).toMatch(/\b(0?:?29)\b/);

    // cancel
    await fireEvent.click(getCancelControl());
    expect(store.close).toHaveBeenCalledTimes(1);
    await act(() => {});
    expect(getOpenControl()).toBeTruthy();
    expect(queryCancelControl()).toBeNull();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(container.textContent ?? '').not.toMatch(/missed/i);
  });
});
