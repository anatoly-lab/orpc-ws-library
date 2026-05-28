# Sequence — reconnect on auth failure (close 1008)

Server closes the WS with `1008` (policy violation — token revoked or
expired). The client routes through the close-decision tree to the
auth-recovery path, asks the `TokenProvider` for a fresh token, and
rebuilds the URL with the new token on the next attempt.

```mermaid
sequenceDiagram
    autonumber
    participant Server
    participant PS as partysocket
    participant EH as EventHandlers
    participant Norm as CloseNormalizer
    participant Decide as close-decision (pure)
    participant RM as ReconnectManager
    participant TRH as TokenRefreshHandler
    participant Token as TokenProvider
    participant URL as urlProvider
    participant State as ConnectionStateManager
    participant App as Consumer (onEvent / onTerminalAuthFailure)

    Server-->>PS: close 1008 "Token revoked"
    PS->>EH: onClose(raw event)
    EH->>Norm: normalize(raw)
    Norm-->>EH: { code: 1008, opened: true, ... }
    EH->>Decide: decide(normalized, holderState)
    Decide-->>EH: { action: "auth-recovery" }

    EH->>State: setState(disconnected({ willRetry: true, code: 1008 }))
    EH->>App: onEvent({ type: "auth_failure", refreshable: true })
    EH->>RM: tryAuthRecovery(1008)

    RM->>RM: storm-guard window check
    Note over RM: First trigger in 30s window → proceed.<br/>Second trigger → terminal.

    RM->>TRH: tryRefreshAndReconnect()
    TRH->>Token: refresh()
    Token-->>TRH: "new-token" (or null)

    alt refresh returned new token
        TRH->>URL: urlProvider() reads token via getToken()
        URL-->>TRH: wss://api/ws?token=new-token
        TRH->>PS: factory.create(urlProvider, handlers, cfg)
        Note over PS: new partysocket; onOpen path same as initial connect
        PS-->>Server: HTTP upgrade with new token
        Server-->>PS: 101
        PS->>EH: onOpen
        EH->>State: setState(connected())
    else refresh returned null OR storm guard tripped
        RM->>App: onTerminalAuthFailure()
        RM->>App: onEvent({ type: "auth_failure", refreshable: false })
        Note over State: state stays disconnected. Client object is dead.<br/>Consumer redirects to login + (post-re-auth) creates new client.
    end
```

Notes:

- `1008` is the auth-failure close. `4001` is treated identically (the
  library's NestJS adapter emits `4001` from `verifyClient`
  rejections); both route to auth-recovery.
- The storm-guard window is **shared** across all triggers — heartbeat
  timeout, close 1008/4001, pre-open 1000 — so two flapping causes can't
  burn the budget twice (the source app had two independent windows;
  the library fixes that drift).
- `refresh()` is **pure**. Returns the token or `null`. No side
  effects, no implicit close, no callback into the client object.
  Cleanup (clearing local auth state, redirect) happens through
  `onTerminalAuthFailure` exactly once.
