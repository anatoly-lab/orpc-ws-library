// Shared ORPC contract for the orpc-ws-library AUTHLESS demo.
//
// This is the *only* file that defines the wire shape both sides agree on.
// The SPA imports the typed contract; the NestJS server imports it too and
// writes implementations against the same contract. End-to-end types come
// from a single source.
//
// AUTHLESS: there is NO auth on this server. The library's authless mode
// runs every procedure with an EMPTY ORPC context (`{}`) — no `user`, no
// `token`. So unlike the auth-mode demos, NOTHING here surfaces a
// principal; the contract is purely the two capabilities the library
// exists for, plus a tiny stateful counter:
//
//   - `echo`:      request/response RPC. Round-trips a message and stamps a
//                  server timestamp on the reply.
//   - `increment`: mutable shared in-memory state — proves an RPC can
//                  change server state and read it back. No input; returns
//                  the new count.
//   - `ticks`:     server-pushed AsyncIterable. Yields a `TickEvent` (a
//                  monotonically-rising counter + server timestamp) about
//                  once a second; the client cancels via the standard ORPC
//                  `signal: AbortSignal`. Exercises the same wire framing
//                  the library uses internally for its stealth heartbeat —
//                  with zero auth.
//
// This file also composes the CLIENT contract (`clientContract`) — the
// server→client ("bidi") direction added in issue #7 — from per-feature
// fragments. See the thin composition root at the bottom of the file.

import { oc } from "@orpc/contract";
import { z } from "zod";

import { toastClientContract } from "./client/toast.contract.js";
import { announceClientContract } from "./client/announce.contract.js";

const echo = oc
  .input(
    z.object({
      message: z.string(),
    }),
  )
  .output(
    z.object({
      message: z.string(),
      at: z.number(),
    }),
  );

// Tiny mutable state: no input, returns the new running count. The server
// keeps the counter in a module-level variable (see router.ts) so two
// browser tabs share — and race on — the same number, the simplest possible
// demonstration that an RPC can mutate server state.
const increment = oc
  .input(z.void())
  .output(
    z.object({
      count: z.number(),
    }),
  );

/**
 * Per-yield event of the `ticks` subscription.
 *
 * Exported so the SPA can type its local state. The contract owns the
 * shape; consumers should not redeclare it.
 */
export interface TickEvent {
  tick: number;
  at: number;
}

// AsyncIterable output. Pattern mirrors the library's own
// `__orpc_ws_lib__.heartbeat` and the auth-mode demos' `tick`:
//   oc.output(z.custom<AsyncIterable<TickEvent>>())
// No `.input(...)` — the procedure takes no input. ORPC's wire serializer
// probes the handler's returned value at runtime; the schema is the typing
// channel only.
const ticks = oc.output(z.custom<AsyncIterable<TickEvent>>());

export const appContract = oc.router({ echo, increment, ticks });
export type AppContract = typeof appContract;

// ----- CLIENT contract (server→client RPC, "bidi") — COMPOSED from fragments -----
//
// The SERVER→CLIENT direction: procedures the BROWSER hosts and the server
// invokes. Issue #7's bidi support makes the WS socket duplex — the server
// holds a typed caller (`conn.client`) and calls these exactly the way the
// browser calls `appContract`. Same `oc` idiom, opposite direction, second
// source-of-truth shared by this app's server + client.
//
// CONTRACT COMPOSITION: the `clientContract` is the central typed surface, but
// it stays THIN and feature-owned. Each feature owns its own slice in a
// colocated fragment (`./client/<feature>.contract.ts`) alongside the React
// component that implements it; this root just MERGES the fragments. Adding a
// feature = a new fragment file + one more spread here, with no edits to the
// existing slices. In a real app the fragments live in their feature folders.
export const clientContract = oc.router({
  ...toastClientContract, // showToast — see ./client/toast.contract.ts
  ...announceClientContract, // announce — see ./client/announce.contract.ts
});
export type ClientContract = typeof clientContract;
