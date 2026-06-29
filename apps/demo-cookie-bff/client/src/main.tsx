import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

// The WS connection is owned by <OrpcWs>, mounted inside AppLayout's authed
// branch (after the /auth/me gate). No client exists at module load — the
// connection is tied to being signed in, and StrictMode-safe via <OrpcWs>.

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
