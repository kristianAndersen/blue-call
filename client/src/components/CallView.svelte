<script lang="ts">
  import type { CallState, FailureReason } from '../webrtc-call';

  interface CallLike {
    state: CallState;
    failureReason: FailureReason;
    localStream: MediaStream | null;
    remoteStream: MediaStream | null;
    hangUp(): void;
  }

  let { call }: { call: CallLike } = $props();

  let localVideo: HTMLVideoElement | undefined = $state();
  let remoteVideo: HTMLVideoElement | undefined = $state();

  $effect(() => {
    if (localVideo) localVideo.srcObject = call.localStream;
  });

  $effect(() => {
    if (remoteVideo) remoteVideo.srcObject = call.remoteStream;
  });
</script>

<div>
  {#if call.state === 'connecting'}
    <p>Connecting…</p>
  {/if}

  {#if call.state === 'failed'}
    <p>Could not connect</p>
  {/if}

  <video bind:this={localVideo} autoplay muted playsinline>
    <track kind="captions" />
  </video>
  <video bind:this={remoteVideo} autoplay playsinline>
    <track kind="captions" />
  </video>

  {#if call.state === 'connecting' || call.state === 'connected'}
    <button type="button" onclick={() => call.hangUp()}>Hang up</button>
  {/if}
</div>
