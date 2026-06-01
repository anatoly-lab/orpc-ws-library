import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

// The eager "connect on reload if a token is present" guard used to live here.
// It now lives in AppLayout, which mounts synchronously on first render of any
// route under it (including "/"). Consolidating to a single connect owner
// avoids the previous double-trigger (module load + Home effect) and keeps the
// guard reactive to auth-state changes.

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
