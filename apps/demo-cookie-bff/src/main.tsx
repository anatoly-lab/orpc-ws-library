import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

// The connect guard lives in AppLayout (it mounts on first render of the "/"
// route). Consolidating to a single connect owner avoids a double-trigger
// (module load + page effect) and keeps the guard tied to the /auth/me result.

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
