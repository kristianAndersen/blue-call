export interface PresenceClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: PresenceClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PresenceEntry {
  expiresAt: number;
  timer: unknown;
}

export interface PresenceStore {
  open(did: string, durationMs: number): void;
  close(did: string): void;
  isOpen(did: string): boolean;
  list(): string[];
}

export function createPresenceStore(clock: PresenceClock = realClock): PresenceStore {
  const entries = new Map<string, PresenceEntry>();

  function open(did: string, durationMs: number): void {
    const existing = entries.get(did);
    if (existing) {
      clock.clearTimeout(existing.timer);
    }
    const expiresAt = clock.now() + durationMs;
    const timer = clock.setTimeout(() => {
      entries.delete(did);
    }, durationMs);
    entries.set(did, { expiresAt, timer });
  }

  function close(did: string): void {
    const existing = entries.get(did);
    if (existing) {
      clock.clearTimeout(existing.timer);
      entries.delete(did);
    }
  }

  function isOpen(did: string): boolean {
    return entries.has(did);
  }

  function list(): string[] {
    return [...entries.keys()];
  }

  return { open, close, isOpen, list };
}
