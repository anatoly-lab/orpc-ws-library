# Sequence — initial connect

The first `client.connect()` call after `createOrpcWsClient`. Covers
the path through URL building, `partysocket` open, server-side
pre-101 auth, ORPC upgrade, and the first heartbeat tick.

```mermaid
sequenceDiagram
    autonumber
    participant App as Consumer app
    participant Client as createOrpcWsClient (composition root)
    participant URL as URL builder
    participant Token as TokenProvider
    participant PS as partysocket (WS wrapper)
    participant WSS as ws.WebSocketServer
    participant Verify as VerifyClientOrchestrator
    participant ConsumerAuth as Consumer verifyClient
    participant RPC as @orpc/server RPCHandler
    participant Pub as HeartbeatPublisher
    participant Sub as HeartbeatSubscriber (client)

    App->>Client: connect()
    Client->>Client: state -> connecting
    Client->>PS: new ReconnectingWebSocket(urlProvider, handlers, cfg)

    Note over PS,URL: partysocket calls urlProvider on EVERY attempt
    PS->>URL: urlProvider()
    URL->>Token: getToken()
    Token-->>URL: "eyJ..."
    URL-->>PS: wss://api/ws?token=eyJ...

    PS->>WSS: HTTP upgrade (token in URL)
    WSS->>Verify: verifyClient(ctx)
    Verify->>ConsumerAuth: verifyClient(ctx)
    ConsumerAuth-->>Verify: { ok: true, user, connectionKey }
    Verify-->>WSS: accept

    WSS-->>PS: 101 Switching Protocols
    WSS->>RPC: rpcHandler.upgrade(ws, { context: user })

    Note over Client,PS: onOpen fires after 101 + ORPC upgrade
    PS->>Client: onOpen()
    Client->>Client: state -> connected
    Client->>Sub: subscribe()

    Sub->>RPC: link.call(["__orpc_ws_lib__","heartbeat"], undefined)
    RPC->>Pub: subscribe via system router
    Pub-->>Sub: { type: "config", intervalMs, timeoutMs }
    Sub->>Sub: monitor.start(intervalMs, timeoutMs)
    Pub-->>Sub: { type: "ping", ts: ... }
    Sub->>Sub: monitor.recordPing()

    Note over App,Sub: Client is now live; typed RPC calls work.
```

Key invariants:

- `verifyClient` runs **before** the 101 response. A failed verify
  closes the upgrade with the consumer's chosen code — no half-open
  state on the wire. (Bug 5.)
- The URL provider is a closure over the token provider, so partysocket
  re-fetches the current token on every reconnect attempt. (Bug 1.)
- The first heartbeat event is always `config`, never `ping` — the
  client's watchdog needs the deadline parameters before it can arm.
