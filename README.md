# Blue Call

Presence-native P2P video calls for Bluesky mutuals via atproto OAuth. See
which of your Bluesky mutuals are "open to a call" right now and start a
1:1 verified P2P WebRTC video call with them, no scheduling and no missed
calls.

Signaling is memoryless: the server relays WebRTC offers/answers/ICE
candidates between two verified DIDs and holds no call state beyond an
in-memory presence list of who is currently "open to a call." Media flows
directly peer-to-peer over WebRTC using STUN only — there is no TURN
relay, by design, so calls between two peers on strict/symmetric NATs may
fail to connect.

## Setup

```
bun install
```

Copy `.env.example` to `.env` and adjust if needed (defaults shown below).

## Development

```
bun run dev
```

This starts both processes concurrently via Bun's workspace filter:

- Server (signaling + presence, Bun) on `http://localhost:8787` (`PORT` in `.env.example`)
- Client (Vite + Svelte) on `http://localhost:5173` (`CLIENT_PORT` in `.env.example`)

Verify both are up:

```
curl http://localhost:5173/          # client, expect 200
curl http://localhost:8787/health    # server, expect 200 "OK"
```

## Testing

```
bun run test
```

This runs `bun test` across `shared` and `server` (110 tests), then runs
the client's Vitest suite (148 tests). Current totals: 110 server+shared,
148 client.

To run a subset directly:

```
bun test shared server        # server + shared unit/integration tests
cd client && bun run vitest run   # client component/unit tests
```

## Manual two-account local test

Automated tests cover protocol and component logic, but a real call needs
two live Bluesky identities. To exercise the full flow locally:

1. Use two Bluesky accounts that **mutually follow each other** (presence
   and calling are gated on the mutuals relationship).
2. Open two separate browser profiles or windows (so each keeps its own
   session) pointed at the Vite dev URL, e.g. `http://localhost:5173`.
3. In each window, log in via atproto OAuth. Localhost is covered by the
   loopback client-metadata exemption, so OAuth works against
   `http://localhost:5173` without a hosted client-metadata document.
4. In one window, declare yourself "open to a call."
5. In the other window, you should see a presence "halo" on that mutual.
   Click it to start the call.
6. Grant camera/microphone permissions when prompted in both windows — the
   call is a real WebRTC P2P connection, not a mock.
7. If the call fails to connect, this may be an expected STUN-only
   limitation: pairs where both peers are behind strict/symmetric NATs
   (no TURN relay by design) may not be able to establish a direct P2P
   path.
