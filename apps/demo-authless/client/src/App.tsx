// Root component. AUTHLESS has no auth gate and no routing — there is exactly
// ONE screen, so this is just the connection owner + the Home page.
//
// CONNECTION OWNERSHIP: `<OrpcWs>` constructs the client from props, owns its
// connect-on-mount / dispose-on-unmount lifecycle (StrictMode-safe), and
// exposes it to descendants via context — so `Home` reads it with
// `useOrpcWs()` instead of importing a module-level singleton. (This REPLACES
// the old hand-rolled `lib/ws-client.ts` singleton + `connect()`-in-effect.)
//
// BIDI (issue #7): we pass a `clientRouter` — the flat server→client handler
// map. Its `showToast` handler closes over THIS component's React state, so a
// SERVER push mutates live UI. That is the whole point of the bidi demo: the
// handler is defined in render (fresh closure each time), and `<OrpcWs>` reads
// it through a render-updated ref, so the client is never rebuilt.

import { useState, type ReactElement } from "react";

import { consoleLogger } from "@orpc-ws/client";
import { OrpcWs } from "@orpc-ws/react";

import type { ClientContract } from "@demo/authless-contract";
import { config } from "./lib/config.js";
import { Home } from "./pages/Home.js";
import { ToastStack, type Toast } from "./components/ToastStack.js";

export function App(): ReactElement {
  // Server-pushed toasts. The `showToast` handler below closes over this
  // setter — a server→client RPC therefore mutates live React state.
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = (id: number): void =>
    setToasts((current) => current.filter((t) => t.id !== id));

  return (
    // The toast stack is a SIBLING of (not a child below) `<OrpcWs>` so it
    // overlays regardless of the connection-gating `fallback` — its state lives
    // here in `App`, above the provider, and the s2c handler closes over it.
    <>
      <OrpcWs<ClientContract>
        url={config.WS_URL}
        // Console bridge so the library's events are visible in devtools.
        onEvent={(e) => console.log("[orpc-ws event]", e)}
        logger={consoleLogger("orpc-ws")}
        // NO `tokenProvider` — authless carries no credential; the WS URL gets
        // no `?token=` and the library never tries to refresh.
        clientRouter={{
          // Runs IN THE BROWSER when the server calls
          // `conn.client.showToast(...)`. Appends to React state (live UI
          // mutation from a server push) and returns the contract's output so
          // the server's s2c call resolves.
          showToast: ({ text }) => {
            setToasts((current) => [...current, { id: nextToastId++, text }]);
            return { shown: true };
          },
        }}
        fallback={<p style={{ textAlign: "center", marginTop: "2rem" }}>Connecting…</p>}
      >
        <Home />
      </OrpcWs>
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

// Monotonic toast id source. Module-level (not state) because it is a pure
// id generator, never read for rendering — keeping it out of React state
// avoids a needless re-render and the `Date.now()`/`Math.random()` seams the
// library forbids (a counter is deterministic and collision-free here).
let nextToastId = 0;
