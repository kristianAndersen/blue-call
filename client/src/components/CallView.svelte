<script lang="ts">
  import type { CallState, FailureReason } from '../webrtc-call';

  interface CallViewProps {
    callState: CallState;
    failureReason: FailureReason;
    localStream: MediaStream | null;
    remoteStream: MediaStream | null;
    onHangUp(): void;
  }

  let { callState, failureReason, localStream, remoteStream, onHangUp }: CallViewProps = $props();

  let localVideo: HTMLVideoElement | undefined = $state();
  let remoteVideo: HTMLVideoElement | undefined = $state();

  $effect(() => {
    if (localVideo) localVideo.srcObject = localStream;
  });

  $effect(() => {
    if (remoteVideo) remoteVideo.srcObject = remoteStream;
  });
</script>

<div>
  {#if callState === 'connecting'}
    <p>Connecting…</p>
  {/if}

  {#if callState === 'failed'}
    <p>Could not connect{#if failureReason} ({failureReason}){/if}</p>
  {/if}

  <video bind:this={localVideo} autoplay muted playsinline>
    <track kind="captions" />
  </video>
  <video bind:this={remoteVideo} autoplay playsinline>
    <track kind="captions" />
  </video>

  {#if callState === 'connecting' || callState === 'connected'}
    <button type="button" onclick={() => onHangUp()}>Hang up</button>
  {/if}
</div>
