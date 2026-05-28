// Shared ORPC contract for the orpc-ws-library demo.
//
// Two procedures, deliberately tiny:
//   - `ping`: liveness check. No input; output is a small payload the
//             SPA can render.
//   - `echo`: round-trips a string AND surfaces the authenticated user
//             principal in the response so the e2e suite can verify the
//             server's `verifyClient` context propagated through to the
//             handler.
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

export const appContract = oc.router({ ping, echo });
export type AppContract = typeof appContract;
