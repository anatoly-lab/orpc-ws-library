// Root component. AUTHLESS has no auth gate and no routing — there is exactly
// ONE screen, so this is just the connection owner + the Home page.
//
// CONNECTION OWNERSHIP: `<OrpcWs>` constructs the client from props, owns its
// connect-on-mount / dispose-on-unmount lifecycle (StrictMode-safe), and
// exposes it to descendants via context — so `Home` reads it with
// `useOrpcWs()` instead of importing a module-level singleton.
//
// BIDI (issue #7): we pass the `clientContract` VALUE — the server→client
// contract, COMPOSED from per-feature fragments (see the contract package). Its
// procedure keys freeze the hosted router's shape; the IMPLEMENTATIONS are
// registered by descendants via `useServerHandler`. Two children of `<OrpcWs>`
// (so they can read the registration context) each own one feature/fragment:
// `<ServerToasts>` implements `showToast`, `<Announcements>` implements
// `announce` — each closing over its OWN React state, so a SERVER push mutates
// live UI. Both use the SAME `useServerHandler` hook (bound once to the merged
// `ClientContract`). Handlers are defined in render (fresh closure each time)
// and read through a render-updated ref, so the client is never rebuilt.

import type { ReactElement } from "react";

import { consoleLogger } from "@orpc-ws/client";
import { OrpcWs } from "@orpc-ws/react";

import { clientContract } from "@demo/authless-contract";
import { config } from "./lib/config.js";
import { Home } from "./pages/Home.js";
import { ServerToasts } from "./components/ServerToasts.js";
import { Announcements } from "./components/Announcements.js";

export function App(): ReactElement {
  return (
    <OrpcWs
      url={config.WS_URL}
      // Console bridge so the library's events are visible in devtools.
      onEvent={(e) => console.log("[orpc-ws event]", e)}
      logger={consoleLogger("orpc-ws")}
      // NO `tokenProvider` — authless carries no credential; the WS URL gets
      // no `?token=` and the library never tries to refresh.
      //
      // The server→client contract VALUE turns bidi ON. `TClientContract` is
      // INFERRED from it — no explicit generic needed.
      clientContract={clientContract}
      fallback={<p style={{ textAlign: "center", marginTop: "2rem" }}>Connecting…</p>}
    >
      {/* Two server→client features, each owning one fragment of the merged
          `clientContract` and registering its own handler via the SAME
          `useServerHandler` hook (bound once to `ClientContract`). Children of
          `<OrpcWs>` (not siblings) so they can read the registration context;
          server pushes only arrive post-connect, when they're mounted. */}
      <ServerToasts />
      <Announcements />
      <Home />
    </OrpcWs>
  );
}
