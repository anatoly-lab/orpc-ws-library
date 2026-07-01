// TYPE-LEVEL test for the adapter's bidi (`TClientContract`) surface.
//
// The runtime body is trivial — the value is in the structural assignments +
// `@ts-expect-error` directives, checked by the chained
// `tsconfig.test-types.json` pass in `pnpm typecheck` (the main tsconfig
// excludes tests, so without that pass these guarantees would never be
// checked). Mirrors the core's `bidi-conn-types.test.ts`. Pins:
//   1. `OrpcWsModuleOptions<…, ClientContract>` ACCEPTS a `clientContract`
//      value — on both the authenticated and authless arms.
//   2. With the `never` default (no third generic), `clientContract` is NOT
//      passable — proving the opt-in / byte-identical-when-off contract.
//   3. `OrpcWsService.getConnection<ClientContract>()` types `.client` as the
//      `ContractRouterClient`; the no-generic call has NO `.client`.

import { oc } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";
import { describe, it } from "vitest";

import type { OrpcWsModuleOptions } from "../orpc-ws.options.js";
import type { OrpcWsService } from "../orpc-ws.service.js";

const clientContract = { notify: oc };
type ClientContract = typeof clientContract;

const router = {} as const;
type Router = typeof router;
interface TestUser {
  sub: string;
}

describe("adapter bidi — type-level guarantees", () => {
  it("OrpcWsModuleOptions threads clientContract on both arms; getConnection types .client", () => {
    // ----- 1. Authenticated arm ACCEPTS a clientContract when the generic is set. -----
    const authed: OrpcWsModuleOptions<TestUser, Router, ClientContract> = {
      router,
      verifyClient: async () => ({ ok: true, user: { sub: "u" } }),
      clientContract,
    };
    void authed;

    // ----- 1b. Authless arm ACCEPTS a clientContract too. -----
    const authless: OrpcWsModuleOptions<unknown, Router, ClientContract> = {
      mode: "authless",
      router,
      clientContract,
    };
    void authless;

    // ----- 2. Opt-in: with the `never` default, clientContract is un-passable. -----
    const plain: OrpcWsModuleOptions<TestUser, Router> = {
      router,
      verifyClient: async () => ({ ok: true, user: { sub: "u" } }),
      // @ts-expect-error — no TClientContract ⇒ `clientContract?: never`.
      clientContract,
    };
    void plain;

    // ----- 3. getConnection: `.client` typed by the call-site generic. -----
    // Type-only. Unlike steps 1-2 (runtime-safe object literals), this probes a
    // METHOD on a service we cannot build without a DI container, so we fake it
    // with `undefined as OrpcWsService`. The vitest run ALSO globs
    // `*-types.test.ts` (base config has no exclusion), so the body must never
    // EXECUTE the `undefined.getConnection(...)` deref — we park it in a
    // declared-but-never-invoked function. tsc still checks the body (incl. the
    // `@ts-expect-error`) via the chained `tsconfig.test-types.json` pass.
    const probeGetConnectionTypes = (): void => {
      const service = undefined as unknown as OrpcWsService;

      const bidiConn = service.getConnection<ClientContract>("k");
      if (bidiConn) {
        const caller: ContractRouterClient<ClientContract> = bidiConn.client;
        void caller;
      }

      const plainConn = service.getConnection("k");
      if (plainConn) {
        // @ts-expect-error — no generic ⇒ the `never` default ⇒ no `client`.
        void plainConn.client;
      }
    };
    void probeGetConnectionTypes; // type-checked; never invoked (see above)
  });
});
