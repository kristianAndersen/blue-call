import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPresenceStore } from './presence-store';
import type { PresenceOpen, PresenceClose } from '@blue-call/shared';

// Wire discriminants for PresenceOpen/PresenceClose are owned by
// shared/src/protocol.ts (U6, implemented in a parallel wave). These matchers
// accept any casing/separator convention ("presence_open", "presenceOpen",
// "PresenceOpen", ...) so this suite pins behavior, not discriminant spelling.
type SentMessage = Record<string, unknown>;

function discriminant(msg: SentMessage): string {
  return String(msg.type ?? msg.kind ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}
const isPresenceOpen = (m: SentMessage) => ['presenceopen', 'open'].includes(discriminant(m));
const isPresenceClose = (m: SentMessage) => ['presenceclose', 'close'].includes(discriminant(m));
const opens = (sent: SentMessage[]) => sent.filter(isPresenceOpen);
const closes = (sent: SentMessage[]) => sent.filter(isPresenceClose);

interface PresenceState {
  open: boolean;
  remainingMs: number;
}

function setup() {
  const sent: SentMessage[] = [];
  const signaling = {
    send: vi.fn((msg: PresenceOpen | PresenceClose) => {
      sent.push(msg as unknown as SentMessage);
    }),
  };
  const store = createPresenceStore(signaling);
  return { store, signaling, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('initial state', () => {
  test('starts closed with no outbound messages', () => {
    const { store, sent } = setup();
    expect(store.isOpen).toBe(false);
    expect(store.remainingMs).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('subscribe follows the svelte store contract: immediate emission and unsubscribe', () => {
    const { store } = setup();
    const states: PresenceState[] = [];
    const unsubscribe = store.subscribe((s: PresenceState) => states.push(s));
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ open: false, remainingMs: 0 });
    unsubscribe();
    store.declareOpen(10_000);
    expect(states).toHaveLength(1);
  });
});

describe('declareOpen', () => {
  test('marks the store open and sends PresenceOpen exactly once', () => {
    const { store, sent } = setup();
    store.declareOpen(60_000);
    expect(store.isOpen).toBe(true);
    expect(store.remainingMs).toBe(60_000);
    expect(opens(sent)).toHaveLength(1);
    expect(closes(sent)).toHaveLength(0);
  });

  test('countdown ticks remainingMs down while open', () => {
    const { store } = setup();
    store.declareOpen(10_000);
    vi.advanceTimersByTime(1_000);
    expect(store.remainingMs).toBe(9_000);
    vi.advanceTimersByTime(2_000);
    expect(store.remainingMs).toBe(7_000);
    expect(store.isOpen).toBe(true);
  });

  test('subscribers observe a decreasing countdown', () => {
    const { store } = setup();
    const states: PresenceState[] = [];
    store.subscribe((s: PresenceState) => states.push(s));
    store.declareOpen(10_000);
    vi.advanceTimersByTime(3_000);

    const last = states[states.length - 1];
    expect(last).toMatchObject({ open: true, remainingMs: 7_000 });
    const openPhase = states.filter((s) => s.open);
    for (let i = 1; i < openPhase.length; i++) {
      expect(openPhase[i].remainingMs).toBeLessThanOrEqual(openPhase[i - 1].remainingMs);
    }
  });
});

describe('expiry', () => {
  test('flips isOpen to false and sends PresenceClose exactly once', () => {
    const { store, sent } = setup();
    store.declareOpen(30_000);
    vi.advanceTimersByTime(30_000);
    expect(store.isOpen).toBe(false);
    expect(store.remainingMs).toBe(0);
    expect(closes(sent)).toHaveLength(1);
  });

  test('does not send PresenceClose before the deadline', () => {
    const { store, sent } = setup();
    store.declareOpen(30_000);
    vi.advanceTimersByTime(29_999);
    expect(store.isOpen).toBe(true);
    expect(closes(sent)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(store.isOpen).toBe(false);
    expect(closes(sent)).toHaveLength(1);
  });

  test('expiry is silent: no alert, no missed-call signal anywhere', () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { store, sent } = setup();
    const states: PresenceState[] = [];
    store.subscribe((s: PresenceState) => states.push(s));

    store.declareOpen(30_000);
    vi.advanceTimersByTime(30_000);

    expect(alertSpy).not.toHaveBeenCalled();
    for (const s of states) {
      const serialized = JSON.stringify(s).toLowerCase();
      expect(serialized).not.toContain('missed');
      expect(serialized).not.toContain('alert');
    }
    for (const m of sent) {
      expect(isPresenceOpen(m) || isPresenceClose(m)).toBe(true);
    }
    expect(opens(sent)).toHaveLength(1);
    expect(closes(sent)).toHaveLength(1);
  });

  test('all timers stop after expiry: no further messages or state churn', () => {
    const { store, sent } = setup();
    store.declareOpen(5_000);
    vi.advanceTimersByTime(5_000);
    const sentCountAtExpiry = sent.length;
    vi.advanceTimersByTime(120_000);
    expect(sent).toHaveLength(sentCountAtExpiry);
    expect(closes(sent)).toHaveLength(1);
    expect(store.isOpen).toBe(false);
  });
});

describe('manual close', () => {
  test('close() sends PresenceClose once and marks the store closed', () => {
    const { store, sent } = setup();
    store.declareOpen(60_000);
    store.close();
    expect(store.isOpen).toBe(false);
    expect(store.remainingMs).toBe(0);
    expect(closes(sent)).toHaveLength(1);
  });

  test('close() cancels the expiry timer: no duplicate PresenceClose at the original deadline', () => {
    const { store, sent } = setup();
    store.declareOpen(60_000);
    vi.advanceTimersByTime(10_000);
    store.close();
    vi.advanceTimersByTime(120_000);
    expect(closes(sent)).toHaveLength(1);
  });

  test('close() is a no-op when the store is not open', () => {
    const { store, sent } = setup();
    store.close();
    expect(store.isOpen).toBe(false);
    expect(sent).toHaveLength(0);
    store.declareOpen(10_000);
    store.close();
    store.close();
    expect(closes(sent)).toHaveLength(1);
  });
});

describe('re-declare', () => {
  test('re-declaring resets the countdown to the new full duration', () => {
    const { store, sent } = setup();
    store.declareOpen(60_000);
    vi.advanceTimersByTime(30_000);
    store.declareOpen(60_000);
    expect(store.remainingMs).toBe(60_000);
    vi.advanceTimersByTime(59_999);
    expect(store.isOpen).toBe(true);
    expect(closes(sent)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(store.isOpen).toBe(false);
    expect(closes(sent)).toHaveLength(1);
  });

  test('re-declaring does not fire a close at the original expiry time', () => {
    const { store, sent } = setup();
    store.declareOpen(30_000);
    vi.advanceTimersByTime(20_000);
    store.declareOpen(30_000);
    vi.advanceTimersByTime(10_000);
    expect(store.isOpen).toBe(true);
    expect(closes(sent)).toHaveLength(0);
    expect(store.remainingMs).toBe(20_000);
  });

  test('each declareOpen sends a fresh PresenceOpen', () => {
    const { store, sent } = setup();
    store.declareOpen(30_000);
    vi.advanceTimersByTime(5_000);
    store.declareOpen(30_000);
    expect(opens(sent)).toHaveLength(2);
  });
});

describe('full lifecycle integration', () => {
  test('declare -> silent expiry -> re-declare -> manual close produces exactly open,close,open,close', () => {
    const { store, sent } = setup();
    store.declareOpen(5_000);
    vi.advanceTimersByTime(5_000);
    store.declareOpen(10_000);
    vi.advanceTimersByTime(4_000);
    store.close();
    vi.advanceTimersByTime(60_000);

    const seq = sent.map((m) =>
      isPresenceOpen(m) ? 'open' : isPresenceClose(m) ? 'close' : 'other',
    );
    expect(seq).toEqual(['open', 'close', 'open', 'close']);
    expect(store.isOpen).toBe(false);
  });
});
