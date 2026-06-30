// Server-pushed toast overlay + the `showToast` server→client registration.
//
// BIDI (issue #7): this component implements the SERVER→CLIENT `showToast`
// procedure. It owns the toast React state and registers the handler via
// `useServerHandler` — so a SERVER push (`conn.client.showToast(...)`) mutates
// live UI here, then replies `{ shown: true }` so the server's s2c call resolves.
//
// WHY a child of `<OrpcWs>` (not a sibling, as the old hand-rolled version was):
// `useServerHandler` reads the registration context that `<OrpcWs>` provides, so
// it MUST render below it.
//
// REGISTRATION TIMING — why the handler is reliably live before the server push.
// This component is gated behind `<OrpcWs>`'s `fallback`, so it mounts (and
// `useServerHandler` registers `showToast`) only AFTER the connection reaches
// "connected" — one React commit LATER than the socket opening. A push arriving
// before that registration would get NOT_FOUND. What guarantees the handler wins
// the race is the server's deliberate `WELCOME_TOAST_DELAY_MS` (1s) wait before
// `conn.client.showToast(...)` (see the authless server's `app-module.ts`): the
// delay outlasts the fallback→child commit, so the handler is registered first.

import { useState, type ReactElement } from "react";

import { useServerHandler } from "../lib/ws.js";
import { ToastStack, type Toast } from "./ToastStack.js";

export function ServerToasts(): ReactElement {
  // Server-pushed toasts. The `showToast` handler below closes over this setter
  // — a server→client RPC therefore mutates live React state.
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = (id: number): void =>
    setToasts((current) => current.filter((t) => t.id !== id));

  // Runs IN THE BROWSER when the server calls `conn.client.showToast(...)`.
  // Appends to React state (live UI mutation from a server push) and returns the
  // contract's output so the server's s2c call resolves. The closure is fresh
  // each render; `useServerHandler` reads it through a render-updated ref, so the
  // client is never rebuilt.
  useServerHandler("showToast", ({ text }) => {
    setToasts((current) => [...current, { id: nextToastId++, text }]);
    return { shown: true };
  });

  return <ToastStack toasts={toasts} onDismiss={dismiss} />;
}

// Monotonic toast id source. Module-level (not state) because it is a pure id
// generator, never read for rendering — keeping it out of React state avoids a
// needless re-render and the `Date.now()`/`Math.random()` seams the library
// forbids (a counter is deterministic and collision-free here).
let nextToastId = 0;
