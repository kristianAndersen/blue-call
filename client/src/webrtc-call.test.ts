import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRTCCall } from './webrtc-call';

/**
 * Contract under test (U29 → implemented in U30, client/src/webrtc-call.ts):
 *
 *   new WebRTCCall({
 *     signaling,                     // injected signaling channel: { send, on, off }
 *     selfDid: string,               // this user's DID
 *     peerDid: string,               // the other party's DID
 *     connectionTimeoutMs: number,   // connecting → failed after this without 'connected'
 *     onStateChange?: (state: CallState) => void,
 *   })
 *
 *   .placeCall(): Promise<void>       — caller flow: getUserMedia, attach local tracks,
 *                                       createOffer, setLocalDescription, send SdpOffer
 *   .acceptCall(offer): Promise<void> — callee flow: getUserMedia, attach local tracks,
 *                                       setRemoteDescription(offer), createAnswer,
 *                                       setLocalDescription, send SdpAnswer
 *   .hangUp(): void                   — full teardown: stop local tracks, close the
 *                                       RTCPeerConnection, remove signaling listeners
 *   .state: CallState                 — 'connecting' | 'connected' | 'ended' | 'failed'
 *   .failureReason                    — 'could-not-connect' | null
 *   .localStream / .remoteStream      — MediaStream | null
 *
 * ICE servers are STUN-only: stun:stun.l.google.com:19302 and
 * stun:stun.cloudflare.com:3478. There is NO TURN fallback. If the ICE
 * connection has not reached 'connected' within connectionTimeoutMs, or
 * iceConnectionState reports 'failed', the call transitions to state 'failed'
 * with failureReason 'could-not-connect' and tears down completely (tracks
 * stopped, peer connection closed, signaling listeners removed).
 *
 * Signaling frames use the pinned protocol names from @blue-call/shared
 * (shared/src/protocol.ts): SdpOffer, SdpAnswer, IceCandidate — each carrying
 * from/to DIDs. Inbound IceCandidate frames that arrive before the remote
 * description has been applied must be buffered and added afterwards.
 */

const STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

class MockMediaStreamTrack {
  kind: string;
  enabled = true;
  stop = vi.fn();

  constructor(kind: string) {
    this.kind = kind;
  }
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[];

  constructor(tracks: MockMediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks(): MockMediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  addTrack(track: MockMediaStreamTrack): void {
    this.tracks.push(track);
  }
}

class MockRTCSessionDescription {
  type: string | undefined;
  sdp: string | undefined;

  constructor(init?: { type?: string; sdp?: string }) {
    this.type = init?.type;
    this.sdp = init?.sdp;
  }
}

class MockRTCIceCandidate {
  candidate: string | undefined;
  sdpMid: string | null | undefined;
  sdpMLineIndex: number | null | undefined;

  constructor(init?: Record<string, unknown>) {
    Object.assign(this, init);
  }
}

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];

  config: RTCConfiguration | undefined;
  iceConnectionState = 'new';
  connectionState = 'new';
  localDescription: unknown = null;
  remoteDescription: unknown = null;

  onicecandidate: ((ev: unknown) => void) | null = null;
  ontrack: ((ev: unknown) => void) | null = null;
  oniceconnectionstatechange: ((ev: unknown) => void) | null = null;
  onconnectionstatechange: ((ev: unknown) => void) | null = null;

  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0 mock-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'v=0 mock-answer' }));
  setLocalDescription = vi.fn(async (desc: unknown) => {
    this.localDescription = desc;
  });
  setRemoteDescription = vi.fn(async (desc: unknown) => {
    this.remoteDescription = desc;
  });
  addIceCandidate = vi.fn(async (_candidate: unknown) => {});
  addTrack = vi.fn((_track: unknown, ..._streams: unknown[]) => ({}));
  getSenders = vi.fn(() => []);
  close = vi.fn();

  constructor(config?: RTCConfiguration) {
    this.config = config;
    MockRTCPeerConnection.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  // --- test drivers (not part of the RTCPeerConnection API) ---

  /** Simulate local ICE gathering producing a candidate (null = end of gathering). */
  emitIceCandidate(init: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | null): void {
    const candidate = init
      ? {
          ...init,
          toJSON() {
            return { candidate: init.candidate, sdpMid: init.sdpMid, sdpMLineIndex: init.sdpMLineIndex };
          },
        }
      : null;
    this.dispatch('icecandidate', { type: 'icecandidate', candidate });
  }

  /** Simulate the ICE state machine advancing. */
  setIceConnectionState(state: string): void {
    this.iceConnectionState = state;
    this.dispatch('iceconnectionstatechange', { type: 'iceconnectionstatechange' });
  }

  /** Simulate a remote track arriving. */
  emitTrack(track: MockMediaStreamTrack, stream: MockMediaStream): void {
    this.dispatch('track', { type: 'track', track, streams: [stream] });
  }

  private dispatch(type: string, ev: unknown): void {
    const prop = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof prop === 'function') prop.call(this, ev);
    this.listeners.get(type)?.forEach((fn) => fn.call(this, ev));
  }
}

class MockSignaling {
  sent: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, Set<(msg: unknown) => void>>();

  send = vi.fn((msg: Record<string, unknown>) => {
    this.sent.push(msg);
  });

  on = vi.fn((type: string, fn: (msg: unknown) => void) => {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  });

  off = vi.fn((type: string, fn: (msg: unknown) => void) => {
    this.handlers.get(type)?.delete(fn);
  });

  // --- test drivers ---

  /** Simulate an inbound signaling frame. */
  emit(type: string, msg: unknown): void {
    this.handlers.get(type)?.forEach((fn) => fn(msg));
  }

  /** Total registered handlers across all frame types. */
  handlerCount(): number {
    let n = 0;
    for (const set of this.handlers.values()) n += set.size;
    return n;
  }
}

const pcInstances = () => MockRTCPeerConnection.instances;
const lastPc = () => {
  const all = MockRTCPeerConnection.instances;
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};

/** Flush pending microtasks + a macrotask tick (real timers only). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const flatIceUrls = (config: RTCConfiguration | undefined): string[] =>
  (config?.iceServers ?? []).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

const answerFrame = {
  type: 'SdpAnswer',
  from: 'did:plc:bob',
  to: 'did:plc:alice',
  sdp: 'v=0 remote-answer',
};

const offerFrame = {
  type: 'SdpOffer',
  from: 'did:plc:bob',
  to: 'did:plc:alice',
  sdp: 'v=0 remote-offer',
};

const inboundIceFrame = {
  type: 'IceCandidate',
  from: 'did:plc:bob',
  to: 'did:plc:alice',
  candidate: {
    candidate: 'candidate:2 1 udp 1686052607 203.0.113.5 61000 typ srflx',
    sdpMid: '0',
    sdpMLineIndex: 0,
  },
};

interface MakeCallOverrides {
  connectionTimeoutMs?: number;
}

function makeCall(overrides: MakeCallOverrides = {}) {
  const signaling = new MockSignaling();
  const onStateChange = vi.fn();
  const call = new WebRTCCall({
    signaling,
    selfDid: 'did:plc:alice',
    peerDid: 'did:plc:bob',
    connectionTimeoutMs: 10_000,
    onStateChange,
    ...overrides,
  });
  return { call, signaling, onStateChange };
}

let localAudio: MockMediaStreamTrack;
let localVideo: MockMediaStreamTrack;
let localStream: MockMediaStream;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  MockRTCPeerConnection.instances = [];
  localAudio = new MockMediaStreamTrack('audio');
  localVideo = new MockMediaStreamTrack('video');
  localStream = new MockMediaStream([localAudio, localVideo]);
  getUserMedia = vi.fn(async () => localStream);
  vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription as unknown as typeof RTCSessionDescription);
  vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate as unknown as typeof RTCIceCandidate);
  vi.stubGlobal('MediaStream', MockMediaStream as unknown as typeof MediaStream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('STUN-only ICE configuration', () => {
  it('creates the RTCPeerConnection with exactly the two pinned STUN servers', async () => {
    const { call } = makeCall();
    await call.placeCall();
    expect(pcInstances()).toHaveLength(1);
    const urls = flatIceUrls(lastPc().config);
    expect([...urls].sort()).toEqual(STUN_URLS);
  });

  it('configures no TURN servers — every ICE server URL is stun:', async () => {
    const { call } = makeCall();
    await call.placeCall();
    const urls = flatIceUrls(lastPc().config);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('stun:')).toBe(true);
    expect(JSON.stringify(lastPc().config)).not.toContain('turn:');
  });
});

describe('caller offer flow', () => {
  it('requests mic + camera and attaches every local track to the peer connection', async () => {
    const { call } = makeCall();
    await call.placeCall();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0] as Record<string, unknown>;
    expect(constraints.audio).toBeTruthy();
    expect(constraints.video).toBeTruthy();
    const attached = lastPc().addTrack.mock.calls.map((c) => c[0]);
    expect(attached).toContain(localAudio);
    expect(attached).toContain(localVideo);
    expect(call.localStream).toBe(localStream);
  });

  it('creates an offer, applies it locally, then sends SdpOffer over signaling', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    const pc = lastPc();
    expect(pc.createOffer).toHaveBeenCalledTimes(1);
    expect(pc.setLocalDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'offer', sdp: 'v=0 mock-offer' }),
    );
    expect(pc.createOffer.mock.invocationCallOrder[0]).toBeLessThan(
      pc.setLocalDescription.mock.invocationCallOrder[0],
    );
    expect(signaling.sent).toContainEqual(
      expect.objectContaining({
        type: 'SdpOffer',
        from: 'did:plc:alice',
        to: 'did:plc:bob',
        sdp: 'v=0 mock-offer',
      }),
    );
  });

  it('is in the connecting state after placing the call', async () => {
    const { call, onStateChange } = makeCall();
    await call.placeCall();
    expect(call.state).toBe('connecting');
    expect(onStateChange).toHaveBeenCalledWith('connecting');
  });

  it('applies an inbound SdpAnswer as the remote description', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    signaling.emit('SdpAnswer', answerFrame);
    await flush();
    expect(lastPc().setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer', sdp: 'v=0 remote-answer' }),
    );
  });
});

describe('callee answer flow', () => {
  it('attaches local media, applies the offer, and sends SdpAnswer back', async () => {
    const { call, signaling } = makeCall();
    await call.acceptCall(offerFrame);
    const pc = lastPc();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const attached = pc.addTrack.mock.calls.map((c) => c[0]);
    expect(attached).toContain(localAudio);
    expect(attached).toContain(localVideo);
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'offer', sdp: 'v=0 remote-offer' }),
    );
    expect(pc.createAnswer).toHaveBeenCalledTimes(1);
    expect(pc.setRemoteDescription.mock.invocationCallOrder[0]).toBeLessThan(
      pc.createAnswer.mock.invocationCallOrder[0],
    );
    expect(pc.setLocalDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer', sdp: 'v=0 mock-answer' }),
    );
    expect(signaling.sent).toContainEqual(
      expect.objectContaining({
        type: 'SdpAnswer',
        from: 'did:plc:alice',
        to: 'did:plc:bob',
        sdp: 'v=0 mock-answer',
      }),
    );
  });

  it('is in the connecting state after accepting the call', async () => {
    const { call } = makeCall();
    await call.acceptCall(offerFrame);
    expect(call.state).toBe('connecting');
  });
});

describe('ICE candidate exchange', () => {
  it('forwards locally gathered candidates to the peer over signaling', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    lastPc().emitIceCandidate({
      candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await flush();
    const iceFrames = signaling.sent.filter((f) => f.type === 'IceCandidate');
    expect(iceFrames).toHaveLength(1);
    expect(iceFrames[0]).toMatchObject({ from: 'did:plc:alice', to: 'did:plc:bob' });
    expect(iceFrames[0].candidate).toMatchObject({
      candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host',
    });
  });

  it('does not send a frame for the end-of-gathering null candidate', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    lastPc().emitIceCandidate(null);
    await flush();
    expect(signaling.sent.filter((f) => f.type === 'IceCandidate')).toHaveLength(0);
  });

  it('adds inbound candidates to the peer connection once the answer is applied', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    signaling.emit('SdpAnswer', answerFrame);
    await flush();
    signaling.emit('IceCandidate', inboundIceFrame);
    await flush();
    expect(lastPc().addIceCandidate).toHaveBeenCalledTimes(1);
    expect(lastPc().addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: inboundIceFrame.candidate.candidate }),
    );
  });

  it('buffers inbound candidates that arrive before the remote answer', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    signaling.emit('IceCandidate', inboundIceFrame);
    await flush();
    expect(lastPc().addIceCandidate).not.toHaveBeenCalled();
    signaling.emit('SdpAnswer', answerFrame);
    await flush();
    expect(lastPc().addIceCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: inboundIceFrame.candidate.candidate }),
    );
  });
});

describe('state machine', () => {
  it("transitions connecting → connected when iceConnectionState becomes 'connected'", async () => {
    const { call, onStateChange } = makeCall();
    await call.placeCall();
    expect(call.state).toBe('connecting');
    lastPc().setIceConnectionState('connected');
    expect(call.state).toBe('connected');
    expect(onStateChange).toHaveBeenCalledWith('connected');
  });

  it("fails with 'could-not-connect' when the connection timeout elapses", async () => {
    vi.useFakeTimers();
    const { call, onStateChange } = makeCall({ connectionTimeoutMs: 10_000 });
    await call.placeCall();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(call.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(call.state).toBe('failed');
    expect(call.failureReason).toBe('could-not-connect');
    expect(onStateChange).toHaveBeenCalledWith('failed');
  });

  it('does not fire the timeout once the call has connected', async () => {
    vi.useFakeTimers();
    const { call } = makeCall({ connectionTimeoutMs: 10_000 });
    await call.placeCall();
    lastPc().setIceConnectionState('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call.state).toBe('connected');
    expect(call.failureReason).toBeNull();
  });

  it("maps iceConnectionState 'failed' to could-not-connect (no TURN fallback exists)", async () => {
    const { call } = makeCall();
    await call.placeCall();
    lastPc().setIceConnectionState('failed');
    expect(call.state).toBe('failed');
    expect(call.failureReason).toBe('could-not-connect');
  });

  it('hangUp transitions to ended', async () => {
    const { call, onStateChange } = makeCall();
    await call.placeCall();
    call.hangUp();
    expect(call.state).toBe('ended');
    expect(onStateChange).toHaveBeenCalledWith('ended');
  });
});

describe('media streams', () => {
  it('exposes the local stream returned by getUserMedia', async () => {
    const { call } = makeCall();
    await call.placeCall();
    expect(call.localStream).toBe(localStream);
  });

  it('exposes the remote stream when a remote track arrives', async () => {
    const { call } = makeCall();
    await call.placeCall();
    const remoteTrack = new MockMediaStreamTrack('video');
    lastPc().emitTrack(remoteTrack, new MockMediaStream([remoteTrack]));
    await flush();
    expect(call.remoteStream).not.toBeNull();
    expect(call.remoteStream!.getTracks()).toContain(remoteTrack);
  });
});

describe('teardown', () => {
  it('hangUp stops local tracks, closes the peer connection, and removes signaling listeners', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    expect(signaling.handlerCount()).toBeGreaterThan(0);
    call.hangUp();
    expect(localAudio.stop).toHaveBeenCalledTimes(1);
    expect(localVideo.stop).toHaveBeenCalledTimes(1);
    expect(lastPc().close).toHaveBeenCalledTimes(1);
    expect(signaling.handlerCount()).toBe(0);
  });

  it('connection-timeout failure also stops tracks, closes the pc, and removes listeners', async () => {
    vi.useFakeTimers();
    const { call, signaling } = makeCall({ connectionTimeoutMs: 5_000 });
    await call.placeCall();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(call.state).toBe('failed');
    expect(localAudio.stop).toHaveBeenCalledTimes(1);
    expect(localVideo.stop).toHaveBeenCalledTimes(1);
    expect(lastPc().close).toHaveBeenCalledTimes(1);
    expect(signaling.handlerCount()).toBe(0);
  });
});

describe('integration: full caller lifecycle', () => {
  it('offer out, answer + ICE in, ICE out, connected, remote media, hang up', async () => {
    const { call, signaling } = makeCall();
    await call.placeCall();
    const pc = lastPc();

    // 1. offer went out over the injected signaling channel
    expect(signaling.sent).toContainEqual(
      expect.objectContaining({ type: 'SdpOffer', from: 'did:plc:alice', to: 'did:plc:bob' }),
    );
    expect(call.state).toBe('connecting');

    // 2. answer + remote candidate flow back in
    signaling.emit('SdpAnswer', answerFrame);
    await flush();
    signaling.emit('IceCandidate', inboundIceFrame);
    await flush();
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer', sdp: 'v=0 remote-answer' }),
    );
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);

    // 3. local candidate goes out
    pc.emitIceCandidate({
      candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await flush();
    expect(signaling.sent).toContainEqual(
      expect.objectContaining({ type: 'IceCandidate', to: 'did:plc:bob' }),
    );

    // 4. ICE connects; remote media arrives
    pc.setIceConnectionState('connected');
    expect(call.state).toBe('connected');
    const remoteTrack = new MockMediaStreamTrack('video');
    pc.emitTrack(remoteTrack, new MockMediaStream([remoteTrack]));
    await flush();
    expect(call.remoteStream!.getTracks()).toContain(remoteTrack);

    // 5. clean teardown
    call.hangUp();
    expect(call.state).toBe('ended');
    expect(pc.close).toHaveBeenCalledTimes(1);
    expect(localAudio.stop).toHaveBeenCalledTimes(1);
    expect(localVideo.stop).toHaveBeenCalledTimes(1);
    expect(signaling.handlerCount()).toBe(0);
  });
});
