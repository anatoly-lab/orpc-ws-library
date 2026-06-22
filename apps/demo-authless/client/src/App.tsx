// Root component. AUTHLESS has no auth gate and no routing — there is exactly
// ONE screen, so this is just the connect owner + the Home page.
//
// Unlike the auth-mode demos there is no <BrowserRouter>, no RequireAuth, no
// /auth/me check, no SignIn. The WS is connected unconditionally on mount —
// there is no credential to wait for.

import { useEffect, type ReactElement } from "react";

import { wsClient } from "./lib/ws-client.js";
import { Home } from "./pages/Home.js";

export function App(): ReactElement {
  // Connect once on mount. `connect()` is idempotent, so React StrictMode's
  // dev double-mount is harmless. We deliberately DON'T `dispose()` on
  // unmount: the wsClient is a module-level singleton that outlives this
  // component, and disposing it would leave a terminal client that can never
  // reconnect on a StrictMode remount.
  useEffect(() => {
    wsClient.connect();
  }, []);

  return <Home />;
}
