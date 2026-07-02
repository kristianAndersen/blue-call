import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMutualsPresence } from './mutuals-presence';
import type { MutualPresenceEntry } from './mutuals-presence';
import type { PresenceBroadcast } from '@blue-call/shared';
import type { Profile } from './mutuals';

// Contract under test (plan U25/U26): createMutualsPresence(mutuals) merges the
// mutuals list (Map<did, Profile>, as returned by fetchMutuals) with incoming
// PresenceBroadcast messages into per-mutual open/closed state with a live-join
// countdown.
//
// - Each PresenceBroadcast is a full snapshot of currently-open users: a mutual
//   listed in `open` is open until its `expiresAt` (epoch ms); a previously-open
//   mutual absent from a later broadcast is closed immediately.
// - DIDs in a broadcast that are not in the mutuals list are ignored entirely.
// - The store follows the svelte store contract (subscribe -> immediate
//   emission, returned unsubscribe stops notifications) and exposes an
//   `entries` snapshot getter with one MutualPresenceEntry per mutual:
//   { profile: Profile, open: boolean, remainingMs: number }.
// - While a mutual is open, remainingMs counts down live (expiresAt - now) and
//   the entry flips to closed (open: false, remainingMs: 0) when the window
//   ends. Expiry is silent — no missed-call signal of any kind.

const T0 = 1_750_000_000_000;

const alice: Profile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice' };
const bob: Profile = { did: 'did:plc:bob', handle: 'bob.test' };
const STRANGER_DID = 'did:plc:stranger';

function mutualsOf(...profiles: Profile[]): Map<string, Profile> {
  return new Map(profiles.map((p) => [p.did, p]));
}

function broadcast(open: { did: string; expiresAt: number }[]): PresenceBroadcast {
  return { type: 'presence-broadcast', open };
}

function entryFor(entries: MutualPresenceEntry[], did: string): MutualPresenceEntry {
  const entry = entries.find((e) => e.profile.did === did);
  if (entry === undefined) throw new Error(`no entry for ${did}`);
  return entry;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('initial state', () => {
  test('every mutual starts closed with remainingMs 0 and its profile attached', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    expect(store.entries).toHaveLength(2);
    for (const profile of [alice, bob]) {
      const entry = entryFor(store.entries, profile.did);
      expect(entry.open).toBe(false);
      expect(entry.remainingMs).toBe(0);
      expect(entry.profile).toEqual(profile);
    }
  });

  test('subscribe follows the svelte store contract: immediate emission and unsubscribe', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    const emissions: MutualPresenceEntry[][] = [];
    const unsubscribe = store.subscribe((entries) => emissions.push(entries));
    expect(emissions).toHaveLength(1);
    expect(entryFor(emissions[0], alice.did)).toMatchObject({ open: false, remainingMs: 0 });
    unsubscribe();
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 60_000 }]));
    expect(emissions).toHaveLength(1);
  });
});

describe('broadcast for a mutual', () => {
  test('opens that mutual with remainingMs equal to the remaining window', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 60_000 }]));
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 60_000 });
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: false, remainingMs: 0 });
  });

  test('subscribers are notified with the opened entry', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    const emissions: MutualPresenceEntry[][] = [];
    store.subscribe((entries) => emissions.push(entries));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 30_000 }]));
    const last = emissions[emissions.length - 1];
    expect(entryFor(last, alice.did)).toMatchObject({ open: true, remainingMs: 30_000 });
  });

  test('a later broadcast with a new expiresAt extends the countdown', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 30_000 }]));
    vi.advanceTimersByTime(10_000);
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 10_000 + 60_000 }]));
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 60_000 });
    vi.advanceTimersByTime(59_999);
    expect(entryFor(store.entries, alice.did).open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
  });

  test('a broadcast whose window is already in the past does not open the mutual', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 - 1 }]));
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
  });
});

describe('broadcast for a non-mutual', () => {
  test('a stranger-only broadcast is ignored: no entry appears, everyone stays closed', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    store.handleBroadcast(broadcast([{ did: STRANGER_DID, expiresAt: T0 + 60_000 }]));
    expect(store.entries).toHaveLength(2);
    expect(store.entries.some((e) => e.profile.did === STRANGER_DID)).toBe(false);
    for (const entry of store.entries) {
      expect(entry.open).toBe(false);
    }
  });

  test('a mixed broadcast opens the mutual and drops the stranger', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    store.handleBroadcast(
      broadcast([
        { did: STRANGER_DID, expiresAt: T0 + 60_000 },
        { did: alice.did, expiresAt: T0 + 45_000 },
      ]),
    );
    expect(store.entries).toHaveLength(1);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 45_000 });
  });
});

describe('live-join countdown', () => {
  test('remainingMs counts down as time advances', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 60_000 }]));
    vi.advanceTimersByTime(1_000);
    expect(entryFor(store.entries, alice.did).remainingMs).toBe(59_000);
    vi.advanceTimersByTime(2_000);
    expect(entryFor(store.entries, alice.did).remainingMs).toBe(57_000);
    expect(entryFor(store.entries, alice.did).open).toBe(true);
  });

  test('subscribers observe a decreasing countdown while open', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    const emissions: MutualPresenceEntry[][] = [];
    store.subscribe((entries) => emissions.push(entries));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 10_000 }]));
    vi.advanceTimersByTime(3_000);

    const last = entryFor(emissions[emissions.length - 1], alice.did);
    expect(last).toMatchObject({ open: true, remainingMs: 7_000 });
    const openPhase = emissions
      .map((entries) => entries.find((e) => e.profile.did === alice.did))
      .filter((e): e is MutualPresenceEntry => e !== undefined && e.open);
    for (let i = 1; i < openPhase.length; i++) {
      expect(openPhase[i].remainingMs).toBeLessThanOrEqual(openPhase[i - 1].remainingMs);
    }
  });

  test('the mutual stays open until the very end of the window', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 30_000 }]));
    vi.advanceTimersByTime(29_999);
    expect(entryFor(store.entries, alice.did).open).toBe(true);
  });
});

describe('expiry and close', () => {
  test('at expiresAt the entry flips to closed with remainingMs 0', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 30_000 }]));
    vi.advanceTimersByTime(30_000);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
  });

  test('a broadcast omitting a previously-open mutual closes them immediately', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    store.handleBroadcast(
      broadcast([
        { did: alice.did, expiresAt: T0 + 60_000 },
        { did: bob.did, expiresAt: T0 + 60_000 },
      ]),
    );
    vi.advanceTimersByTime(5_000);
    store.handleBroadcast(broadcast([{ did: bob.did, expiresAt: T0 + 60_000 }]));
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: true, remainingMs: 55_000 });
  });

  test('expiry is silent: no missed-call signal appears in any emitted state', () => {
    const store = createMutualsPresence(mutualsOf(alice));
    const emissions: MutualPresenceEntry[][] = [];
    store.subscribe((entries) => emissions.push(entries));
    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 10_000 }]));
    vi.advanceTimersByTime(10_000);
    for (const entries of emissions) {
      const serialized = JSON.stringify(entries).toLowerCase();
      expect(serialized).not.toContain('missed');
      expect(serialized).not.toContain('alert');
    }
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
  });
});

describe('multiple mutuals are independent', () => {
  test('different windows expire independently', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    store.handleBroadcast(
      broadcast([
        { did: alice.did, expiresAt: T0 + 10_000 },
        { did: bob.did, expiresAt: T0 + 60_000 },
      ]),
    );
    vi.advanceTimersByTime(10_000);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: true, remainingMs: 50_000 });
    vi.advanceTimersByTime(50_000);
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: false, remainingMs: 0 });
  });

  test('extending one mutual does not disturb the other countdown', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    store.handleBroadcast(
      broadcast([
        { did: alice.did, expiresAt: T0 + 30_000 },
        { did: bob.did, expiresAt: T0 + 30_000 },
      ]),
    );
    vi.advanceTimersByTime(10_000);
    store.handleBroadcast(
      broadcast([
        { did: alice.did, expiresAt: T0 + 10_000 + 60_000 },
        { did: bob.did, expiresAt: T0 + 30_000 },
      ]),
    );
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 60_000 });
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: true, remainingMs: 20_000 });
    vi.advanceTimersByTime(20_000);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 40_000 });
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: false, remainingMs: 0 });
  });
});

describe('full lifecycle integration', () => {
  test('open -> countdown -> extend -> omitted from broadcast -> closed', () => {
    const store = createMutualsPresence(mutualsOf(alice, bob));
    const emissions: MutualPresenceEntry[][] = [];
    store.subscribe((entries) => emissions.push(entries));

    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 30_000 }]));
    vi.advanceTimersByTime(10_000);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 20_000 });

    store.handleBroadcast(broadcast([{ did: alice.did, expiresAt: T0 + 10_000 + 30_000 }]));
    vi.advanceTimersByTime(10_000);
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: true, remainingMs: 20_000 });

    store.handleBroadcast(broadcast([]));
    expect(entryFor(store.entries, alice.did)).toMatchObject({ open: false, remainingMs: 0 });
    expect(entryFor(store.entries, bob.did)).toMatchObject({ open: false, remainingMs: 0 });

    const aliceTrace = emissions
      .map((entries) => entries.find((e) => e.profile.did === alice.did))
      .filter((e): e is MutualPresenceEntry => e !== undefined)
      .map((e) => e.open);
    expect(aliceTrace[0]).toBe(false);
    expect(aliceTrace).toContain(true);
    expect(aliceTrace[aliceTrace.length - 1]).toBe(false);
  });
});
