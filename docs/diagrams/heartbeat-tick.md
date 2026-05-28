# Sequence — heartbeat tick (single timer, N subscribers)

The library's heartbeat is published as an ORPC AsyncIterable
subscription at the reserved namespace `__orpc_ws_lib__.heartbeat`.
**One** server-side timer fans out to **N** client subscribers via the
`MemoryPublisher` — not N timers.

```mermaid
sequenceDiagram
    autonumber
    participant Clock as Clock (injected)
    participant Pub as HeartbeatPublisher (server)
    participant Router as system-router (ORPC)
    participant ClientA as Client A subscriber
    participant ClientB as Client B subscriber
    participant ClientN as Client N subscriber
    participant Mon as HeartbeatMonitor (per-client)

    Note over Pub: One setInterval(intervalMs) for the whole process.
    Clock->>Pub: tick (every intervalMs, e.g. 25000ms)
    Pub->>Pub: ev = { type: "ping", ts: clock.now() }
    Pub->>Router: publish("ping", ev)

    par fan-out
        Router-->>ClientA: yield { type: "ping", ts }
        Router-->>ClientB: yield { type: "ping", ts }
        Router-->>ClientN: yield { type: "ping", ts }
    end

    ClientA->>Mon: recordPing()
    Note over Mon: deadline = clock.now() + intervalMs + timeoutMs<br/>If no recordPing() by deadline → timeout fires.

    Mon-->>Mon: watchdog timer rearmed
```

Why this matters:

- **One timer for N clients** is the load-bearing scalability claim
  for the heartbeat path. The source app's earlier approach of one
  timer per connection was the reason its gateway had a `Map<WebSocket,
  NodeJS.Timeout>` cleanup foot-gun. (Bug 8 documented the related
  framing issue: heartbeat went over raw `ws.send()` instead of ORPC,
  bypassing the typed channel.)
- **Per-client monitor.** Each subscribed client has its own
  `HeartbeatMonitor` with an injected `Clock`. Deadline arithmetic uses
  the client's clock, not the wire-carried `ts` — clock skew between
  server and client can't artificially trip the watchdog.
- **AsyncIterable through ORPC, not raw WS.** The library calls
  `link.call(["__orpc_ws_lib__","heartbeat"], undefined, { signal })`
  on the same `RPCLink` instance the consumer's typed proxy uses.
  Framing is identical to every other RPC; nothing special on the wire.
- **`config` event is sent once at subscribe**, before the first `ping`.
  It carries `intervalMs` + `timeoutMs` so the client's watchdog gets
  the deadline from the server, not from a hardcoded constant.

## Belt-and-braces: WS-protocol ping/pong

Independent of the application-layer heartbeat, the server also runs
the WS-protocol ping/pong watchdog (`ws.ping()` → browser auto-pong).
Missing two consecutive pongs → connection is a zombie → terminate.
That path is not in this diagram — see
[`packages/orpc-ws-server/src/heartbeat/ws-ping-pong.ts`](../../packages/orpc-ws-server/src/heartbeat/ws-ping-pong.ts).
Two independent paths because they catch different failure modes:
ORPC stalls (server can't produce events) vs kernel-level dead sockets.
