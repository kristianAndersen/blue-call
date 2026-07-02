<script lang="ts">
  interface PresenceState {
    open: boolean;
    remainingMs: number;
  }

  interface PresenceStoreLike {
    subscribe(fn: (state: PresenceState) => void): () => void;
    declareOpen(durationMs: number): void;
    close(): void;
  }

  let { store }: { store: PresenceStoreLike } = $props();

  const DEFAULT_DURATION_MS = 15 * 60 * 1000;

  function formatCountdown(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
</script>

{#if $store.open}
  <span>{formatCountdown($store.remainingMs)}</span>
  <button type="button" onclick={() => store.close()}>Cancel</button>
{:else}
  <button type="button" onclick={() => store.declareOpen(DEFAULT_DURATION_MS)}>
    Declare open
  </button>
{/if}
