# Sequence — single session per user (close 4005, terminal "kicked")

User logs in from a second tab / device. The server's
`ConnectionRegistry` sees an existing entry for that user, replaces
it, and closes the older socket with `4005`. The first client moves to
the terminal `kicked` state — no reconnect attempted.

```mermaid
sequenceDiagram
    autonumber
    participant FirstClient as First client (already connected)
    participant Server as ws.WebSocketServer
    participant Reg as ConnectionRegistry
    participant SecondClient as Second client (new login)
    participant EH as EventHandlers (first client)
    participant Decide as close-decision
    participant State as ConnectionStateManager
    participant App as Consumer

    Note over FirstClient,Reg: First client connected. registry["user-123"] = wsA

    SecondClient->>Server: HTTP upgrade ?token=...
    Server->>Reg: register(connectionKey "user-123", wsB)
    Reg->>Reg: existing entry wsA found
    Reg->>FirstClient: wsA.close(4005, "Session replaced")
    Reg->>Reg: registry["user-123"] = wsB
    Note over Reg: Atomic "delete only if still the same WS" check<br/>so a stale close can't clobber the new entry.

    FirstClient->>EH: onClose({ code: 4005, ... })
    EH->>Decide: decide({code: 4005, opened: true})
    Decide-->>EH: { action: "terminal-kicked", reason: "session_replaced" }
    EH->>State: setState(kicked({ reason: "session_replaced" }))

    State->>App: subscribers notified
    Note over App: UI reads state.status === "kicked",<br/>can show "Logged in elsewhere" banner.

    Note over EH: NO reconnect scheduled. kicked is terminal.<br/>connect() is a no-op while state.status === "kicked".
```

Key invariants:

- **`4005` is library-reserved** for "session replaced." The close
  code is the wire signal; the client's `close-decision` tree
  recognizes it and short-circuits to terminal.
- **`kicked` is terminal.** `connect()` no-ops, the reconnect manager
  refuses to schedule. The only way out is to create a new
  `OrpcWsClient` — which is what the consumer does after the user
  re-auths in a tab that still has session.
- **Registry uses atomic delete-if-same** to avoid the close-clobbering
  race: a stale close from the old WS arriving after the new WS is
  registered would otherwise erase the new entry. (Bug 9 server-side.)
- **`onKicked` hook fires on the server** as part of the registry
  replace, so consumers can audit the kick (`onKicked(user,
  replacedBy)`).
