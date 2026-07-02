import type { IceCandidate, SdpAnswer, SdpOffer } from '@blue-call/shared';

export type CallState = 'connecting' | 'connected' | 'ended' | 'failed';
export type FailureReason = 'could-not-connect' | null;

export interface SignalingChannel {
  send(msg: Record<string, unknown>): void;
  on(type: string, fn: (msg: unknown) => void): void;
  off(type: string, fn: (msg: unknown) => void): void;
}

export type SdpOfferFrame = SdpOffer;
export type SdpAnswerFrame = SdpAnswer;
export type IceCandidateFrame = IceCandidate;
export type IceCandidateInit = IceCandidateFrame['candidate'];

export interface WebRTCCallOptions {
  signaling: SignalingChannel;
  selfDid: string;
  peerDid: string;
  connectionTimeoutMs: number;
  onStateChange?: (state: CallState) => void;
  onLocalStream?: (stream: MediaStream) => void;
  onRemoteStream?: (stream: MediaStream) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export class WebRTCCall {
  state: CallState = 'connecting';
  failureReason: FailureReason = null;
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;

  private readonly options: WebRTCCallOptions;
  private pc: RTCPeerConnection | null = null;
  private remoteDescriptionSet = false;
  private pendingCandidates: IceCandidateInit[] = [];
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private signalingHandlers: Array<[string, (msg: unknown) => void]> = [];

  constructor(options: WebRTCCallOptions) {
    this.options = options;
  }

  async placeCall(): Promise<void> {
    await this.setupLocalMedia();
    this.setupPeerConnection();
    this.listenForIceCandidates();
    this.listenForAnswer();

    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.options.signaling.send({
      type: 'sdp-offer',
      from: this.options.selfDid,
      to: this.options.peerDid,
      sdp: offer.sdp,
    });

    this.startConnecting();
  }

  async acceptCall(offer: SdpOfferFrame): Promise<void> {
    await this.setupLocalMedia();
    this.setupPeerConnection();
    this.listenForIceCandidates();

    await this.pc!.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.sdp }));
    this.remoteDescriptionSet = true;
    await this.drainPendingCandidates();

    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.options.signaling.send({
      type: 'sdp-answer',
      from: this.options.selfDid,
      to: this.options.peerDid,
      sdp: answer.sdp,
    });

    this.startConnecting();
  }

  hangUp(): void {
    this.teardown();
    this.setState('ended');
  }

  private startConnecting(): void {
    this.setState('connecting');
    this.timeoutHandle = setTimeout(() => this.fail(), this.options.connectionTimeoutMs);
  }

  private async setupLocalMedia(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    this.options.onLocalStream?.(this.localStream);
  }

  private setupPeerConnection(): void {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    for (const track of this.localStream!.getTracks()) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const candidate = ev.candidate.toJSON();
      this.options.signaling.send({
        type: 'ice-candidate',
        from: this.options.selfDid,
        to: this.options.peerDid,
        candidate,
      });
    };

    pc.ontrack = (ev) => {
      this.remoteStream = ev.streams[0] ?? null;
      if (this.remoteStream) this.options.onRemoteStream?.(this.remoteStream);
    };

    pc.oniceconnectionstatechange = () => {
      if (this.state === 'ended' || this.state === 'failed') return;
      if (pc.iceConnectionState === 'connected') {
        if (this.timeoutHandle) {
          clearTimeout(this.timeoutHandle);
          this.timeoutHandle = null;
        }
        this.setState('connected');
      } else if (pc.iceConnectionState === 'failed') {
        this.fail();
      }
    };
  }

  private listenForIceCandidates(): void {
    const handler = (msg: unknown) => {
      const frame = msg as IceCandidateFrame;
      if (!this.remoteDescriptionSet) {
        this.pendingCandidates.push(frame.candidate);
        return;
      }
      void this.pc!.addIceCandidate(new RTCIceCandidate(frame.candidate));
    };
    this.options.signaling.on('ice-candidate', handler);
    this.signalingHandlers.push(['ice-candidate', handler]);
  }

  private listenForAnswer(): void {
    const handler = (msg: unknown) => {
      void this.applyAnswer(msg as SdpAnswerFrame);
    };
    this.options.signaling.on('sdp-answer', handler);
    this.signalingHandlers.push(['sdp-answer', handler]);
  }

  private async applyAnswer(frame: SdpAnswerFrame): Promise<void> {
    await this.pc!.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: frame.sdp }));
    this.remoteDescriptionSet = true;
    await this.drainPendingCandidates();
  }

  private async drainPendingCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      await this.pc!.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private fail(): void {
    if (this.state === 'ended' || this.state === 'failed') return;
    this.teardown();
    this.failureReason = 'could-not-connect';
    this.setState('failed');
  }

  private teardown(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.pc?.close();
    for (const [type, handler] of this.signalingHandlers) {
      this.options.signaling.off(type, handler);
    }
    this.signalingHandlers = [];
  }

  private setState(next: CallState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
