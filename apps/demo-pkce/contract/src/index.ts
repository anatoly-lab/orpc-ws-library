// Shared ORPC contract for the orpc-ws-library demo.
//
// Four procedures, deliberately tiny:
//   - `ping`:    liveness check. No input; output is a small payload the
//                SPA can render.
//   - `echo`:    round-trips a string AND surfaces the authenticated user
//                principal in the response so the e2e suite can verify the
//                server's `verifyClient` context propagated through to the
//                handler.
//   - `getUser`: server-roundtrip version of "who am I" — proves the
//                library propagates the `context.user` populated by
//                `verifyClient` into the handler. The SPA already has
//                a client-side `authClient.getUser()` that parses claims
//                out of the id_token; this is the typed-RPC equivalent.
//   - `tick`:    server-pushed AsyncIterable. Server yields a `TickEvent`
//                every 15s; client cancels via the standard ORPC
//                `signal: AbortSignal`. Exercises the same wire framing
//                the library uses internally for its stealth heartbeat.
//
// This is the *only* file that defines the wire shape both sides agree
// on. The SPA imports the typed contract; the NestJS server imports it
// too and writes implementations against the same contract. End-to-end
// types come from a single source.

import { oc } from "@orpc/contract";
import { z } from "zod";

const ping = oc
  .input(z.void())
  .output(
    z.object({
      pong: z.literal(true),
      at: z.number(),
    }),
  );

const echo = oc
  .input(
    z.object({
      message: z.string(),
    }),
  )
  .output(
    z.object({
      echoed: z.string(),
      user: z.string(),
    }),
  );

// The shape is intentionally narrow: only the three standard OIDC claims
// the library's `OidcUser` exposes. If the demo ever needs IdP-specific
// claims (Keycloak `realm_access`, etc.), the contract widens — but the
// server-side `mapUser` would have to widen first.
const getUser = oc
  .input(z.void())
  .output(
    z.object({
      sub: z.string(),
      email: z.string().optional(),
      name: z.string().optional(),
    }),
  );

/**
 * Per-yield event of the `tick` subscription.
 *
 * Exported so the SPA can type its local state. The contract owns the
 * shape; consumers should not redeclare it.
 */
export interface TickEvent {
  tick: number;
  at: number;
}

// AsyncIterable output. Pattern mirrors the library's own
// `__orpc_ws_lib__.heartbeat` and the origin app's `quota.subscribe`:
//   oc.output(z.custom<AsyncIterable<TickEvent>>())
// No `.input(...)` — the procedure takes no input, matching the
// heartbeat reference. ORPC's wire serializer probes the handler's
// returned value at runtime; the schema is the typing channel only.
const tick = oc.output(z.custom<AsyncIterable<TickEvent>>());

// Demo image upload over the library's opt-in HTTP transport. The input
// object MUST key the file under `file` — the client's `orpc-http` upload
// strategy hardcodes that multipart field name. Native zod-4 `z.file()`
// (this package already depends on zod 4.x) carries the MIME allow-list to
// both sides; the optional `name` rides alongside as a plain field.
const uploadImage = oc
  .input(
    z.object({
      file: z.file().mime(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      name: z.string().optional(),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      storedAs: z.string(),
      size: z.number(),
    }),
  );

export const appContract = oc.router({ ping, echo, getUser, tick, uploadImage });
export type AppContract = typeof appContract;
