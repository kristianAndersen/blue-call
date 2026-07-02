import type { PresenceBroadcast } from '@blue-call/shared';
import type { Profile } from './mutuals';

export interface MutualPresenceEntry {
  profile: Profile;
  open: boolean;
  remainingMs: number;
}

type Subscriber = (entries: MutualPresenceEntry[]) => void;

const TICK_MS = 100;

export function createMutualsPresence(mutuals: Map<string, Profile>) {
  const expiresAtByDid = new Map<string, number>();
  const subscribers = new Set<Subscriber>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function computeEntries(): MutualPresenceEntry[] {
    const now = Date.now();
    const entries: MutualPresenceEntry[] = [];
    for (const [did, profile] of mutuals) {
      const expiresAt = expiresAtByDid.get(did);
      const remainingMs = expiresAt !== undefined ? expiresAt - now : 0;
      if (remainingMs > 0) {
        entries.push({ profile, open: true, remainingMs });
      } else {
        expiresAtByDid.delete(did);
        entries.push({ profile, open: false, remainingMs: 0 });
      }
    }
    return entries;
  }

  function notify(): void {
    const entries = computeEntries();
    for (const run of subscribers) run(entries);
  }

  function stopTimerIfIdle(): void {
    if (timer !== undefined && expiresAtByDid.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function ensureTimer(): void {
    if (timer !== undefined || expiresAtByDid.size === 0) return;
    timer = setInterval(() => {
      notify();
      stopTimerIfIdle();
    }, TICK_MS);
  }

  function handleBroadcast(message: PresenceBroadcast): void {
    const now = Date.now();
    expiresAtByDid.clear();
    for (const { did, expiresAt } of message.open) {
      if (!mutuals.has(did)) continue;
      if (expiresAt <= now) continue;
      expiresAtByDid.set(did, expiresAt);
    }
    ensureTimer();
    notify();
    stopTimerIfIdle();
  }

  function subscribe(run: Subscriber): () => void {
    subscribers.add(run);
    run(computeEntries());
    return () => {
      subscribers.delete(run);
    };
  }

  return {
    get entries(): MutualPresenceEntry[] {
      return computeEntries();
    },
    subscribe,
    handleBroadcast,
  };
}
