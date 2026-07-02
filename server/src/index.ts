import { createPresenceStore } from './presence';
import { createSignalingRouter, type SignalingConnection } from './signaling';

export interface CreateServerOptions {
  port?: number;
  allowedOrigin?: string;
  verifyAuth?: (token: string) => Promise<{ did: string }>;
}

export interface BlueCallServer {
  port: number;
  getState(): { openPresence: string[]; connectionCount: number };
  stop(): Promise<void>;
}

interface ConnData {
  queue: Promise<void>;
}

export function createServer(options: CreateServerOptions = {}): BlueCallServer {
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const allowedOrigin = options.allowedOrigin ?? process.env.ALLOWED_ORIGIN;

  const presence = createPresenceStore();
  const router = createSignalingRouter({ presence, verifyAuth: options.verifyAuth });

  const liveSockets = new Set<Bun.ServerWebSocket<ConnData>>();

  const server = Bun.serve<ConnData, object>({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      if (url.pathname === '/ws') {
        if (allowedOrigin && req.headers.get('origin') !== allowedOrigin) {
          return new Response('Forbidden', { status: 403 });
        }
        const upgraded = srv.upgrade(req, { data: { queue: Promise.resolve() } });
        if (upgraded) return undefined;
        return new Response('Upgrade failed', { status: 400 });
      }

      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open(ws) {
        liveSockets.add(ws);
        router.handleOpen(ws as unknown as SignalingConnection);
      },
      message(ws, message) {
        const raw = typeof message === 'string' ? message : message.toString();
        ws.data.queue = ws.data.queue
          .then(() => router.handleMessage(ws as unknown as SignalingConnection, raw))
          .catch(() => {});
      },
      close(ws) {
        liveSockets.delete(ws);
        router.handleClose(ws as unknown as SignalingConnection);
      },
    },
  });

  function getState(): { openPresence: string[]; connectionCount: number } {
    return {
      openPresence: presence.list(),
      connectionCount: router.connectionCount(),
    };
  }

  async function stop(): Promise<void> {
    for (const ws of liveSockets) {
      router.handleClose(ws as unknown as SignalingConnection);
    }
    liveSockets.clear();
    // Bun's server.stop() promise never settles once any websocket has been
    // closed from the server side (observed on bun 1.3.4); the listening
    // socket and connections are torn down synchronously regardless, so race
    // against a short bound instead of awaiting the promise directly.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      server.stop(true).then(finish).catch(finish);
      setTimeout(finish, 100);
    });
  }

  return {
    get port() {
      return server.port;
    },
    getState,
    stop,
  };
}

if (import.meta.main) {
  const srv = createServer();
  console.log(`Server listening on port ${srv.port}`);
}
