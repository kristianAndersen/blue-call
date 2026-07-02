import { SignalingMessage } from '@blue-call/shared';

import type { PresenceStore } from './presence';

async function defaultVerifyAuth(token: string): Promise<{ did: string }> {
  const { verifyClientAuth } = await import('./auth');
  const lxm = process.env.SIGNALING_LXM ?? 'com.bluecall.signaling.connect';
  return verifyClientAuth(token, process.env.SIGNALING_SERVER_DID ?? '', lxm);
}

export interface SignalingConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SignalingRouterOptions {
  presence: PresenceStore;
  verifyAuth?: (token: string) => Promise<{ did: string }>;
}

export interface SignalingRouter {
  handleOpen(conn: SignalingConnection): void;
  handleMessage(conn: SignalingConnection, raw: string): Promise<void>;
  handleClose(conn: SignalingConnection): void;
  connectionCount(): number;
}

export function createSignalingRouter(options: SignalingRouterOptions): SignalingRouter {
  const { presence } = options;
  const verifyAuth = options.verifyAuth ?? defaultVerifyAuth;
  const devBypass = process.env.DEV_ALLOW_UNVERIFIED_AUTH === '1';
  if (devBypass) {
    console.warn('DEV MODE: signaling auth disabled');
  }

  const authedConns = new Map<SignalingConnection, string>();
  const didToConn = new Map<string, SignalingConnection>();
  const presenceExpiry = new Map<string, number>();

  function sendError(conn: SignalingConnection, code: string, message: string): void {
    const frame: SignalingMessage = { type: 'error', code, message };
    conn.send(JSON.stringify(frame));
  }

  function rejectConnection(conn: SignalingConnection): void {
    conn.close(4401, 'unauthorized');
  }

  function relay(sender: SignalingConnection, target: string, message: SignalingMessage): void {
    const targetConn = didToConn.get(target);
    if (!targetConn) {
      sendError(sender, 'target-unreachable', 'Target DID is not connected');
      return;
    }
    targetConn.send(JSON.stringify(message));
  }

  function broadcastPresence(): void {
    const open = presence.list().map((did) => ({
      did,
      expiresAt: presenceExpiry.get(did) ?? Date.now(),
    }));
    const frame: SignalingMessage = { type: 'presence-broadcast', open };
    const raw = JSON.stringify(frame);
    for (const conn of didToConn.values()) {
      conn.send(raw);
    }
  }

  function handleOpen(_conn: SignalingConnection): void {
    // Connection is not routable until it completes the auth handshake.
  }

  async function handleMessage(conn: SignalingConnection, raw: string): Promise<void> {
    const did = authedConns.get(conn);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(conn, 'invalid-json', 'Frame is not valid JSON');
      if (!did) rejectConnection(conn);
      return;
    }

    const result = SignalingMessage.safeParse(parsed);
    if (!result.success) {
      sendError(conn, 'invalid-frame', 'Frame does not match the signaling schema');
      if (!did) rejectConnection(conn);
      return;
    }
    const msg = result.data;

    if (!did) {
      if (msg.type !== 'auth-handshake') {
        sendError(conn, 'not-authenticated', 'First frame must be auth-handshake');
        rejectConnection(conn);
        return;
      }
      let verified: { did: string };
      try {
        verified = await verifyAuth(msg.token);
      } catch {
        if (devBypass) {
          verified = { did: msg.did };
        } else {
          sendError(conn, 'auth-failed', 'Token verification failed');
          rejectConnection(conn);
          return;
        }
      }
      if (verified.did !== msg.did) {
        sendError(conn, 'auth-failed', 'Token does not prove the claimed DID');
        rejectConnection(conn);
        return;
      }
      authedConns.set(conn, verified.did);
      didToConn.set(verified.did, conn);
      return;
    }

    switch (msg.type) {
      case 'presence-open':
        presence.open(did, msg.durationMs);
        presenceExpiry.set(did, Date.now() + msg.durationMs);
        broadcastPresence();
        return;
      case 'presence-close':
        presence.close(did);
        presenceExpiry.delete(did);
        broadcastPresence();
        return;
      case 'sdp-offer':
        relay(conn, msg.to, { type: 'sdp-offer', to: msg.to, from: did, sdp: msg.sdp });
        return;
      case 'sdp-answer':
        relay(conn, msg.to, msg);
        return;
      case 'ice-candidate':
        relay(conn, msg.to, msg);
        return;
      case 'join-request':
        relay(conn, msg.to, msg);
        return;
      default:
        // presence-broadcast is server-only vocabulary; repeated auth-handshake
        // and inbound error frames are not part of the client-facing contract.
        return;
    }
  }

  function handleClose(conn: SignalingConnection): void {
    const did = authedConns.get(conn);
    if (!did) return;
    authedConns.delete(conn);
    if (didToConn.get(did) === conn) {
      didToConn.delete(did);
    }
    presence.close(did);
    presenceExpiry.delete(did);
  }

  function connectionCount(): number {
    return didToConn.size;
  }

  return { handleOpen, handleMessage, handleClose, connectionCount };
}
