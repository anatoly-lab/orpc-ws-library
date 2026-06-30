// Server-pushed announcements + the `announce` server→client registration.
//
// CONTRACT COMPOSITION (client side): the SECOND feature. It mirrors
// `ServerToasts` but owns the OTHER fragment — `announce` (see the contract's
// `src/client/announce.contract.ts`). It knows nothing about the toast feature;
// it just implements its own slice and renders its own state. Two features, two
// components, two procedure names — and the SAME `useServerHandler` hook serves
// both (the hook is bound once to the MERGED `ClientContract`; see `../lib/ws`).
//
// BIDI: this component implements the SERVER→CLIENT `announce` procedure. It
// owns the announcements React state and registers the handler via
// `useServerHandler` — so a SERVER push (`conn.client.announce(...)`) mutates
// live UI here, then replies `{ ok: true }` so the server's s2c call resolves.
//
// REGISTRATION TIMING — like `ServerToasts`, this is gated behind `<OrpcWs>`'s
// `fallback`, so it mounts (and registers `announce`) only AFTER the connection
// reaches "connected" — one React commit later than the socket opening. The
// server's deliberate `ANNOUNCE_DELAY_MS` (2s) wait before the push outlasts
// that commit, so the handler is registered first and wins the race.

import { useState, type ReactElement } from "react";

import { useServerHandler } from "../lib/ws.js";

interface Announcement {
  id: number;
  message: string;
}

export function Announcements(): ReactElement | null {
  // Server-pushed announcements. The `announce` handler below closes over this
  // setter — a server→client RPC therefore mutates live React state.
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  // Runs IN THE BROWSER when the server calls `conn.client.announce(...)`.
  // Appends to React state and returns the contract's output so the server's
  // s2c call resolves. Fresh closure each render; read through a render-updated
  // ref, so the client is never rebuilt.
  useServerHandler("announce", ({ message }) => {
    setAnnouncements((current) => [
      ...current,
      { id: nextAnnouncementId++, message },
    ]);
    return { ok: true };
  });

  if (announcements.length === 0) return null;

  return (
    <ul data-testid="announcements">
      {announcements.map((a) => (
        <li key={a.id} data-testid="announcement">
          {a.message}
        </li>
      ))}
    </ul>
  );
}

// Monotonic announcement id source. Module-level (not state) because it is a
// pure id generator, never read for rendering — keeping it out of React state
// avoids a needless re-render and the `Date.now()`/`Math.random()` seams the
// library forbids (a counter is deterministic and collision-free here).
let nextAnnouncementId = 0;
