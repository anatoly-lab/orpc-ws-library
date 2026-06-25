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

// NOTE: no `uploadImage` procedure here. cookie-BFF deliberately has NO HTTP
// upload transport — the library's upload path authenticates via a Bearer
// token, which cookie-BFF (cookie-only, no token in the browser) doesn't have.
// A dead procedure with no route would just confuse a reader of this teaching
// reference, so it's omitted. (The PKCE / backend-token demos, which DO carry a
// token, keep their upload procedure.)
export const appContract = oc.router({ ping, echo, getUser, tick });
export type AppContract = typeof appContract;
