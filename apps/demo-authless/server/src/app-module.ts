// authless `AppModule`. The entire point of this demo: register the
// library's WS module in AUTHLESS mode.
//
// `mode: "authless"` selects the discriminated-union arm that has NO
// `verifyClient`, NO `uploads`, NO `enforceTokenExpiry`. Every WS upgrade is
// accepted; the consumer's procedures run with an empty ORPC context. The
// adapter's `OrpcWsService` reads `mode` and dispatches to the core's
// `createAuthlessOrpcWsServer` (see the adapter's `orpc-ws.options.ts` /
// `orpc-ws.service.ts`).
//
// There is no auth controller, no session store, no OIDC code-exchange —
// authless is strictly simpler than every other demo. The only controller is
// the trivial /health liveness endpoint.
//
// BIDI (issue #7): this module ALSO opts into server→client RPC by passing
// `clientContract`. Its presence gives every (user-less) connection a typed
// `conn.client` caller; the `onConnected` hook below uses it to PUSH two
// messages to the browser — `showToast` and `announce`, each owned by its own
// feature fragment (see the contract's `src/client/*.contract.ts`). The merged
// `ClientContract` carries both, so one typed `conn.client` invokes either —
// the end-to-end demonstration of server→client RPC plus contract composition.

import { Logger, Module } from "@nestjs/common";
import {
  fromNestShape,
  OrpcWsModule,
  type OrpcWsModuleOptions,
} from "@orpc-ws/server-nestjs";

import { clientContract, type ClientContract } from "@demo/authless-contract";
import { appRouter } from "./router.js";
import { HealthController } from "./health.controller.js";

const nestLogger = new Logger("OrpcWs");

// How long after connect to push the welcome toast. A deliberate delay (not 0)
// so the toast lands AFTER the SPA has painted — making it visibly a SERVER
// push that arrives on a settled page, not something the page rendered on load.
const WELCOME_TOAST_DELAY_MS = 1_000;

// The second server→client push, from a DIFFERENT feature fragment (`announce`).
// A slightly later delay than the toast so the two pushes are visibly distinct
// and so the gated `<Announcements>` child has surely registered its handler.
const ANNOUNCE_DELAY_MS = 2_000;

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      // The factory's RETURN TYPE is annotated so the bidi `TClientContract`
      // generic flows through: `forRootAsync`'s higher-order inference will NOT
      // pull the third generic out of a bare factory return, so without this
      // annotation `conn.client` would silently collapse to absent (see the
      // BIDI INFERENCE CAVEAT in the adapter's orpc-ws.module.ts). Annotating
      // keeps `onConnected`'s `conn.client` typed against `ClientContract`.
      useFactory: (): OrpcWsModuleOptions<
        unknown,
        typeof appRouter,
        ClientContract
      > => ({
        // The AUTHLESS arm: no verifyClient, no uploads, no token.
        mode: "authless",
        router: appRouter,
        // Opt into server→client RPC. Passing the VALUE (not just the generic)
        // keeps the type and the runtime bidi switch in lockstep.
        clientContract,
        connection: { path: "/ws" },
        logger: fromNestShape(nestLogger),
        hooks: {
          // Fires once per accepted connection. `conn.client` is the typed
          // server→client caller (present because we passed `clientContract`).
          // We push a welcome toast after a short delay; fire-and-forget, but
          // we log the browser's `{ shown }` reply to prove the s2c RPC
          // round-trips back to the server.
          onConnected: (conn) => {
            setTimeout(() => {
              void conn.client
                .showToast({ text: "Hello from the server 👋" })
                .then((reply) => {
                  nestLogger.log(`client acked toast: shown=${reply.shown}`);
                })
                .catch((err: unknown) => {
                  // The browser may have disconnected within the delay window;
                  // a rejected s2c call is benign for a best-effort demo push.
                  nestLogger.warn(`showToast push failed: ${String(err)}`);
                });
            }, WELCOME_TOAST_DELAY_MS);

            // A SECOND push, from the `announce` feature fragment. Same typed
            // `conn.client` (the merged `ClientContract` carries both procs);
            // same fire-and-forget + benign-on-early-disconnect shape.
            setTimeout(() => {
              void conn.client
                .announce({ message: "Composed from a feature fragment 🧩" })
                .then((reply) => {
                  nestLogger.log(`client acked announce: ok=${reply.ok}`);
                })
                .catch((err: unknown) => {
                  nestLogger.warn(`announce push failed: ${String(err)}`);
                });
            }, ANNOUNCE_DELAY_MS);
          },
        },
      }),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
