<script lang="ts">
  import type { MutualPresenceEntry } from '../mutuals-presence';

  interface PresenceStoreLike {
    subscribe(fn: (entries: MutualPresenceEntry[]) => void): () => void;
  }

  let { store, onjoin }: { store: PresenceStoreLike; onjoin: (did: string) => void } = $props();

  function formatCountdown(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
</script>

<ul>
  {#each $store as entry (entry.profile.did)}
    <li>
      <span>{entry.profile.displayName ?? entry.profile.handle}</span>
      <span>{entry.profile.handle}</span>
      {#if entry.open}
        <span>{formatCountdown(entry.remainingMs)}</span>
        <button type="button" onclick={() => onjoin(entry.profile.did)}>
          Join {entry.profile.displayName ?? entry.profile.handle}
        </button>
      {/if}
    </li>
  {/each}
</ul>
