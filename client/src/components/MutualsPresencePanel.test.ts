// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/svelte';
import MutualsPresencePanel from './MutualsPresencePanel.svelte';
import type { MutualPresenceEntry } from '../mutuals-presence';
import type { Profile } from '../mutuals';

// Contract (pinned by mutuals-presence.test.ts / U26): the component receives
// the mutuals-presence store as a `store` prop and renders purely from the
// MutualPresenceEntry[] it publishes. The store is mocked here so these tests
// exercise only MutualsPresencePanel's rendering and its join-intent callback.
//
// Join intent (Svelte 5 idiom): the panel receives an `onjoin` callback prop
// and invokes it with a value identifying the mutual (its did) when the
// glanceable join affordance of an open mutual is activated.
function createMockPresenceStore(initial: MutualPresenceEntry[] = []) {
  let entries: MutualPresenceEntry[] = initial.map((e) => ({ ...e }));
  const subscribers = new Set<(entries: MutualPresenceEntry[]) => void>();
  const notify = () => {
    for (const fn of subscribers) fn(entries);
  };
  return {
    subscribe(fn: (entries: MutualPresenceEntry[]) => void) {
      subscribers.add(fn);
      fn(entries);
      return () => {
        subscribers.delete(fn);
      };
    },
    // Test-only: simulate store-driven updates (broadcasts, ticks, expiry).
    simulate(next: MutualPresenceEntry[]) {
      entries = next.map((e) => ({ ...e }));
      notify();
    },
    get entries() {
      return entries;
    },
  };
}

const alice: Profile = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice' };
const bob: Profile = { did: 'did:plc:bob', handle: 'bob.test' };
const carol: Profile = { did: 'did:plc:carol', handle: 'carol.test', displayName: 'Carol' };

const openEntry = (profile: Profile, remainingMs = 60_000): MutualPresenceEntry => ({
  profile,
  open: true,
  remainingMs,
});
const closedEntry = (profile: Profile): MutualPresenceEntry => ({
  profile,
  open: false,
  remainingMs: 0,
});

function renderPanel(initial: MutualPresenceEntry[] = []) {
  const store = createMockPresenceStore(initial);
  const onjoin = vi.fn();
  const rendered = render(MutualsPresencePanel, { props: { store, onjoin } });
  return { store, onjoin, ...rendered };
}

// Accessible-name matchers pin behavior, not copy. With several mutuals on
// screen the join affordance must be distinguishable per person, so its
// accessible name must both read as a join/call action and name the mutual.
const JOIN_NAME = /join|call/i;
const namesMutual = (name: string, p: Profile) =>
  name.includes(p.handle) || (p.displayName !== undefined && name.includes(p.displayName));
const getJoinControlFor = (p: Profile) =>
  screen.getByRole('button', { name: (name) => JOIN_NAME.test(name) && namesMutual(name, p) });
const queryJoinControlsFor = (p: Profile) =>
  screen.queryAllByRole('button', { name: (name) => JOIN_NAME.test(name) && namesMutual(name, p) });
const queryAnyJoinControls = () =>
  screen.queryAllByRole('button', { name: JOIN_NAME });

// The no-missed-call invariant, asserted at every lifecycle step: nothing in
// the DOM may ever read as a missed call, and nothing may interrupt (alert /
// alertdialog / dialog roles, window.alert).
function expectNoMissedCallIndicator(container: HTMLElement) {
  expect(container.textContent ?? '').not.toMatch(/miss(ed)?/i);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(container.querySelector('[class*="missed" i], [data-missed]')).toBeNull();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rows', () => {
  test('renders one row per mutual, open or closed, identified by name', () => {
    const { container } = renderPanel([openEntry(alice), closedEntry(bob), closedEntry(carol)]);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Alice|alice\.test/);
    expect(text).toContain('bob.test');
    expect(text).toMatch(/Carol|carol\.test/);
  });

  test('renders an empty panel without join affordances when there are no mutuals', () => {
    const { container } = renderPanel([]);
    expect(queryAnyJoinControls()).toHaveLength(0);
    expectNoMissedCallIndicator(container);
  });

  test('a mutual with no displayName still renders a row (handle fallback)', () => {
    const { container } = renderPanel([openEntry(bob)]);
    expect(container.textContent ?? '').toContain('bob.test');
    expect(getJoinControlFor(bob)).toBeTruthy();
  });
});

describe('open mutual halo', () => {
  test('an open mutual shows a glanceable join affordance named for that mutual', () => {
    renderPanel([openEntry(alice), closedEntry(bob)]);
    expect(getJoinControlFor(alice)).toBeTruthy();
  });

  test('the halo is non-modal: no dialog, alertdialog, or alert role appears', () => {
    renderPanel([openEntry(alice)]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an open mutual shows the live-join countdown for its remaining time', () => {
    const { container } = renderPanel([openEntry(alice, 60_000)]);
    // 60s remaining must surface as "1:00" or "60" (m:ss or seconds format).
    expect(container.textContent).toMatch(/\b(1:00|60)\b/);
  });

  test('the countdown updates live as the store ticks down', async () => {
    const { store, container } = renderPanel([openEntry(alice, 60_000)]);
    const before = container.textContent;
    await act(() => store.simulate([openEntry(alice, 59_000)]));
    expect(container.textContent).toMatch(/\b(0?:?59)\b/);
    expect(container.textContent).not.toBe(before);
    await act(() => store.simulate([openEntry(alice, 58_000)]));
    expect(container.textContent).toMatch(/\b(0?:?58)\b/);
  });
});

describe('closed mutuals', () => {
  test('closed mutuals render without a halo or join affordance', () => {
    renderPanel([closedEntry(bob), closedEntry(carol)]);
    expect(queryAnyJoinControls()).toHaveLength(0);
    expect(queryJoinControlsFor(bob)).toHaveLength(0);
    expect(queryJoinControlsFor(carol)).toHaveLength(0);
  });

  test('with a mix, only open mutuals get a join affordance', () => {
    renderPanel([openEntry(alice), closedEntry(bob), openEntry(carol)]);
    expect(getJoinControlFor(alice)).toBeTruthy();
    expect(getJoinControlFor(carol)).toBeTruthy();
    expect(queryJoinControlsFor(bob)).toHaveLength(0);
  });
});

describe('join intent', () => {
  test('clicking a halo join affordance emits the join intent exactly once', async () => {
    const { onjoin } = renderPanel([openEntry(alice)]);
    await fireEvent.click(getJoinControlFor(alice));
    expect(onjoin).toHaveBeenCalledTimes(1);
  });

  test('the join intent identifies the clicked mutual by did', async () => {
    const { onjoin } = renderPanel([openEntry(alice), openEntry(carol)]);
    await fireEvent.click(getJoinControlFor(carol));
    expect(onjoin).toHaveBeenCalledTimes(1);
    // The payload may be the did, the profile, or the entry — but it must
    // identify carol and not alice.
    const payload = JSON.stringify(onjoin.mock.calls[0]);
    expect(payload).toContain(carol.did);
    expect(payload).not.toContain(alice.did);
  });

  test('rendering alone never emits a join intent', () => {
    const { onjoin } = renderPanel([openEntry(alice), closedEntry(bob)]);
    expect(onjoin).not.toHaveBeenCalled();
  });
});

describe('silent expiry', () => {
  test('expiry removes the halo but keeps the row', async () => {
    const { store, container } = renderPanel([openEntry(alice, 1_000), closedEntry(bob)]);
    expect(getJoinControlFor(alice)).toBeTruthy();

    await act(() => store.simulate([closedEntry(alice), closedEntry(bob)]));

    expect(queryJoinControlsFor(alice)).toHaveLength(0);
    expect(container.textContent ?? '').toMatch(/Alice|alice\.test/);
  });

  test('expiry is silent: no alert, no missed-call indicator, no join intent', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { store, onjoin, container } = renderPanel([openEntry(alice, 1_000)]);

    await act(() => store.simulate([closedEntry(alice)]));

    expect(alertSpy).not.toHaveBeenCalled();
    expect(onjoin).not.toHaveBeenCalled();
    expectNoMissedCallIndicator(container);
  });
});

describe('full lifecycle integration', () => {
  test('closed -> open -> tick -> join -> expiry, with no missed-call indicator at any step', async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const { store, onjoin, container } = renderPanel([closedEntry(alice), closedEntry(bob)]);

    // all closed: no halos
    expect(queryAnyJoinControls()).toHaveLength(0);
    expectNoMissedCallIndicator(container);

    // alice opens for 30s
    await act(() => store.simulate([openEntry(alice, 30_000), closedEntry(bob)]));
    expect(getJoinControlFor(alice)).toBeTruthy();
    expect(container.textContent).toMatch(/\b(0?:?30)\b/);
    expectNoMissedCallIndicator(container);

    // countdown ticks
    await act(() => store.simulate([openEntry(alice, 29_000), closedEntry(bob)]));
    expect(container.textContent).toMatch(/\b(0?:?29)\b/);
    expectNoMissedCallIndicator(container);

    // join intent fires for alice
    await fireEvent.click(getJoinControlFor(alice));
    expect(onjoin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onjoin.mock.calls[0])).toContain(alice.did);

    // expiry: halo gone, row remains, silence throughout
    await act(() => store.simulate([closedEntry(alice), closedEntry(bob)]));
    expect(queryAnyJoinControls()).toHaveLength(0);
    expect(container.textContent ?? '').toMatch(/Alice|alice\.test/);
    expect(alertSpy).not.toHaveBeenCalled();
    expectNoMissedCallIndicator(container);
  });
});
