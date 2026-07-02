import { describe, expect, test } from 'bun:test';

import { createPresenceStore, type PresenceClock } from './presence';

// Contract under test (U10): server-side in-memory TTL presence store.
//
//   createPresenceStore(clock?: PresenceClock): {
//     open(did: string, durationMs: number): void;
//     close(did: string): void;
//     isOpen(did: string): boolean;
//     list(): string[];
//   }
//
// Backed by a Map<did, { expiresAt }>. Decay is timer-driven via the
// injectable clock (defaults to real Date.now/setTimeout/clearTimeout);
// zero persistence — state lives and dies with the store instance.
//
//   interface PresenceClock {
//     now(): number;
//     setTimeout(fn: () => void, ms: number): unknown;
//     clearTimeout(handle: unknown): void;
//   }

interface FakeClockHarness {
  clock: PresenceClock;
  advance(ms: number): void;
}

function makeFakeClock(): FakeClockHarness {
  let currentTime = 0;
  let nextHandle = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  const clock: PresenceClock = {
    now: () => currentTime,
    setTimeout(fn: () => void, ms: number): unknown {
      const handle = nextHandle++;
      timers.set(handle, { fireAt: currentTime + ms, fn });
      return handle;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
  };

  function advance(ms: number): void {
    const target = currentTime + ms;
    for (;;) {
      let dueHandle: number | undefined;
      let due: { fireAt: number; fn: () => void } | undefined;
      for (const [handle, timer] of timers) {
        if (timer.fireAt <= target && (due === undefined || timer.fireAt < due.fireAt)) {
          dueHandle = handle;
          due = timer;
        }
      }
      if (dueHandle === undefined || due === undefined) break;
      timers.delete(dueHandle);
      currentTime = Math.max(currentTime, due.fireAt);
      due.fn();
    }
    currentTime = target;
  }

  return { clock, advance };
}

const ALICE = 'did:plc:alice000000000000000000';
const BOB = 'did:plc:bob0000000000000000000000';

describe('presence store: open/isOpen happy path', () => {
  test('open marks a DID as open', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    expect(store.isOpen(ALICE)).toBe(true);
  });

  test('an opened DID appears in list()', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    expect(store.list()).toContain(ALICE);
  });

  test('a DID that was never opened is not open', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    expect(store.isOpen(ALICE)).toBe(false);
  });

  test('list() is empty on a fresh store', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    expect(store.list()).toEqual([]);
  });

  test('store works with the default real clock when none is injected', () => {
    const store = createPresenceStore();
    store.open(ALICE, 60_000);
    expect(store.isOpen(ALICE)).toBe(true);
    store.close(ALICE);
    expect(store.isOpen(ALICE)).toBe(false);
  });
});

describe('presence store: TTL expiry', () => {
  test('DID stays open just before its TTL elapses', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    advance(59_999);
    expect(store.isOpen(ALICE)).toBe(true);
  });

  test('DID is closed after its TTL elapses', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    advance(60_001);
    expect(store.isOpen(ALICE)).toBe(false);
  });

  test('expired DID is absent from list()', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    advance(60_001);
    expect(store.list()).not.toContain(ALICE);
  });

  test('zero-duration open is expired immediately after time moves', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 0);
    advance(1);
    expect(store.isOpen(ALICE)).toBe(false);
    expect(store.list()).not.toContain(ALICE);
  });

  test('expiry is silent — it does not disturb other open DIDs', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 10_000);
    store.open(BOB, 60_000);
    advance(10_001);
    expect(store.isOpen(ALICE)).toBe(false);
    expect(store.isOpen(BOB)).toBe(true);
  });
});

describe('presence store: explicit close', () => {
  test('close before expiry marks the DID closed', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    advance(1_000);
    store.close(ALICE);
    expect(store.isOpen(ALICE)).toBe(false);
    expect(store.list()).not.toContain(ALICE);
  });

  test('close is idempotent and safe for unknown DIDs', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    expect(() => store.close(ALICE)).not.toThrow();
    store.open(ALICE, 60_000);
    store.close(ALICE);
    expect(() => store.close(ALICE)).not.toThrow();
    expect(store.isOpen(ALICE)).toBe(false);
  });

  test('close only affects the targeted DID', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    store.open(BOB, 60_000);
    store.close(ALICE);
    expect(store.isOpen(ALICE)).toBe(false);
    expect(store.isOpen(BOB)).toBe(true);
  });

  test('a DID can be re-opened after an explicit close', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    store.close(ALICE);
    store.open(ALICE, 60_000);
    expect(store.isOpen(ALICE)).toBe(true);
    advance(60_001);
    expect(store.isOpen(ALICE)).toBe(false);
  });
});

describe('presence store: re-open extends the window', () => {
  test('re-opening before expiry extends past the original deadline', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    advance(50_000);
    store.open(ALICE, 60_000); // new deadline: t=110_000
    advance(20_000); // t=70_000 — past original deadline of 60_000
    expect(store.isOpen(ALICE)).toBe(true);
    expect(store.list()).toContain(ALICE);
  });

  test('the extended window still expires at its new deadline', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    advance(50_000);
    store.open(ALICE, 60_000); // new deadline: t=110_000
    advance(60_001); // t=110_001
    expect(store.isOpen(ALICE)).toBe(false);
    expect(store.list()).not.toContain(ALICE);
  });

  test('re-opening does not duplicate the DID in list()', () => {
    const { clock } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 60_000);
    store.open(ALICE, 60_000);
    expect(store.list().filter((did) => did === ALICE)).toHaveLength(1);
  });
});

describe('presence store: list() returns only live DIDs', () => {
  test('mixed live, expired, and closed DIDs', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    const carol = 'did:plc:carol00000000000000000000';
    store.open(ALICE, 10_000);
    store.open(BOB, 60_000);
    store.open(carol, 60_000);
    store.close(carol);
    advance(10_001); // ALICE expired, carol closed, BOB live
    expect([...store.list()].sort()).toEqual([BOB]);
  });

  test('list() drains to empty as every window decays', () => {
    const { clock, advance } = makeFakeClock();
    const store = createPresenceStore(clock);
    store.open(ALICE, 10_000);
    store.open(BOB, 20_000);
    advance(20_001);
    expect(store.list()).toEqual([]);
  });
});

describe('presence store: zero persistence', () => {
  test('nothing survives store recreation', () => {
    const { clock } = makeFakeClock();
    const first = createPresenceStore(clock);
    first.open(ALICE, 60_000);
    first.open(BOB, 60_000);
    expect(first.list()).toHaveLength(2);

    const second = createPresenceStore(clock);
    expect(second.isOpen(ALICE)).toBe(false);
    expect(second.isOpen(BOB)).toBe(false);
    expect(second.list()).toEqual([]);
  });

  test('separate store instances do not share state', () => {
    const { clock } = makeFakeClock();
    const a = createPresenceStore(clock);
    const b = createPresenceStore(clock);
    a.open(ALICE, 60_000);
    expect(b.isOpen(ALICE)).toBe(false);
    b.close(ALICE);
    expect(a.isOpen(ALICE)).toBe(true);
  });
});
