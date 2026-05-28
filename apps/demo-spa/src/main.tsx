import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { authClient } from "./lib/auth.js";
import { wsClient } from "./lib/ws-client.js";

// Auto-connect if we already have a token. The Home page's effect
// also calls connect() — both calls are safe because connect() is
// idempotent (see @repo/orpc-ws-client README "Lifecycle").
if (authClient.hasToken()) {
  wsClient.connect();
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
