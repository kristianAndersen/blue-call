import type { PresenceOpen, PresenceClose } from '@blue-call/shared';

export interface PresenceState {
  open: boolean;
  remainingMs: number;
}

export interface PresenceSignalingClient {
  send(message: PresenceOpen | PresenceClose): void;
}

type Subscriber = (state: PresenceState) => void;

const TICK_MS = 100;

export function createPresenceStore(signaling: PresenceSignalingClient) {
  const subscribers = new Set<Subscriber>();
  let expiresAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function computeState(): PresenceState {
    if (expiresAt === undefined) return { open: false, remainingMs: 0 };
    const remainingMs = Math.max(0, expiresAt - Date.now());
    return { open: remainingMs > 0, remainingMs };
  }

  function notify(): void {
    const state = computeState();
    for (const run of subscribers) run(state);
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function expire(): void {
    expiresAt = undefined;
    stopTimer();
    signaling.send({ type: 'presence-close' });
    notify();
  }

  function tick(): void {
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      expire();
    } else {
      notify();
    }
  }

  function declareOpen(durationMs: number): void {
    stopTimer();
    expiresAt = Date.now() + durationMs;
    signaling.send({ type: 'presence-open', durationMs });
    timer = setInterval(tick, TICK_MS);
    notify();
  }

  function close(): void {
    if (expiresAt === undefined) return;
    expiresAt = undefined;
    stopTimer();
    signaling.send({ type: 'presence-close' });
    notify();
  }

  function subscribe(run: Subscriber): () => void {
    subscribers.add(run);
    run(computeState());
    return () => {
      subscribers.delete(run);
    };
  }

  return {
    get isOpen(): boolean {
      return computeState().open;
    },
    get remainingMs(): number {
      return computeState().remainingMs;
    },
    declareOpen,
    close,
    subscribe,
  };
}
