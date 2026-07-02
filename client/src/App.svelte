<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { login, handleCallback, getSession, type Session } from './auth';
  import { fetchMutuals } from './mutuals';
  import { SignalingClient } from './signaling-client';
  import { WebRTCCall, type CallState } from './webrtc-call';
  import { createPresenceStore } from './presence-store';
  import { createMutualsPresence } from './mutuals-presence';
  import PresenceToggle from './components/PresenceToggle.svelte';
  import MutualsPresencePanel from './components/MutualsPresencePanel.svelte';
  import CallView from './components/CallView.svelte';

  const RECONNECT_BASE_DELAY_MS = 1_000;
  const RECONNECT_MAX_DELAY_MS = 30_000;
  const CONNECTION_TIMEOUT_MS = 15_000;

  let checkedSession = $state(false);
  let session: Session | null = $state(null);
  let handle = $state('');

  let presenceStore: ReturnType<typeof createPresenceStore> | undefined = $state(undefined);
  let mutualsPresence: ReturnType<typeof createMutualsPresence> | undefined = $state(undefined);
  let activeCall: WebRTCCall | undefined = $state(undefined);

  let signaling: SignalingClient | undefined;

  function signalingUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws`;
  }

  function serviceAud(): string {
    return `did:web:${window.location.host}`;
  }

  async function setupDashboard(active: Session): Promise<void> {
    const mutuals = await fetchMutuals(active.did);
    mutualsPresence = createMutualsPresence(mutuals);

    signaling = new SignalingClient({
      url: signalingUrl(),
      did: active.did,
      getToken: () => active.mintServiceAuth(serviceAud()),
      reconnectBaseDelayMs: RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: RECONNECT_MAX_DELAY_MS,
    });
    presenceStore = createPresenceStore(signaling);
    signaling.on('presence-broadcast', (msg) => mutualsPresence?.handleBroadcast(msg));
    signaling.connect();
  }

  function handleJoin(peerDid: string): void {
    if (!session || !signaling) return;
    const call = new WebRTCCall({
      signaling,
      selfDid: session.did,
      peerDid,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      onStateChange: (state: CallState) => {
        if (state === 'ended' || state === 'failed') {
          activeCall = undefined;
        }
      },
    });
    activeCall = call;
    void call.placeCall();
  }

  function submitLogin(event: SubmitEvent): void {
    event.preventDefault();
    if (!handle) return;
    void login(handle);
  }

  onMount(() => {
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code') && params.has('state')) {
        await handleCallback();
      }
      const active = await getSession();
      session = active;
      checkedSession = true;
      if (active) {
        await setupDashboard(active);
      }
    })();
  });

  onDestroy(() => {
    signaling?.disconnect();
  });
</script>

<main>
  {#if !checkedSession}
    <p>Loading…</p>
  {:else if !session}
    <form onsubmit={submitLogin}>
      <input type="text" bind:value={handle} placeholder="you.bsky.social" />
      <button type="submit">Log in</button>
    </form>
  {:else if activeCall}
    <CallView call={activeCall} />
  {:else}
    {#if presenceStore}
      <PresenceToggle store={presenceStore} />
    {/if}
    {#if mutualsPresence}
      <MutualsPresencePanel store={mutualsPresence} onjoin={handleJoin} />
    {/if}
  {/if}
</main>
