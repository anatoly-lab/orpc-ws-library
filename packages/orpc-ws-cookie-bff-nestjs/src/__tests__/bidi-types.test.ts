// TYPE-LEVEL test for the cookie-BFF adapter's bidi (`TClientContract`) surface.
//
// The runtime body is trivial — the value is in the structural assignments +
// `@ts-expect-error` directives, checked by the chained
// `tsconfig.test-types.json` pass in `pnpm typecheck` (the main tsconfig
// excludes tests, so without that pass these guarantees would never be
// checked). Mirrors the server-nestjs adapter's `bidi-types.test.ts`. Pins:
//   1. `CookieBffModuleOptions<TUser>` (no third generic) REJECTS a
//      `clientContract` value — proving the opt-in / byte-identical-when-off
//      contract.
//   2. With the third generic — flowed through `forRootAsync` by an ANNOTATED
//      `useFactory` return type ALONE (the exact fix the doc comment
//      prescribes for the higher-order-inference footgun; no explicit type
//      arguments on the call) — `hooks.onConnected`'s `conn` carries a typed
//      `client` caller.
//   3. Without the third generic, `conn.client` is not accessible.

import { oc } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";
import { describe, it } from "vitest";

import type { SessionStore } from "@orpc-ws/cookie-bff";

import { CookieBffModule } from "../cookie-bff.module.js";
import type { CookieBffModuleOptions } from "../cookie-bff.options.js";

const clientContract = { notify: oc };
type ClientContract = typeof clientContract;

const router = {} as const;
type Router = typeof router;
interface TestUser {
  sub: string;
}

// Minimal VALID base options. Runtime-safe: the vitest run ALSO globs
// `*-types.test.ts` (base config has no exclusion), but `forRootAsync` only
// STORES the factory in a DynamicModule — nothing here ever resolves DI, so
// the fake sessionStore / IdP config are never touched.
function baseOptions(): CookieBffModuleOptions<TestUser, Router> {
  return {
    router,
    keycloak: {
      issuerUrl: "https://idp.example",
      clientId: "demo",
      redirectUri: "https://api.example/auth/callback",
    },
    originAllowlist: ["https://web.example"],
    encryptionKey: Buffer.alloc(32, 1),
    sessionStore: undefined as unknown as SessionStore<TestUser>,
    spaRedirectUri: "https://web.example",
    resolveUser: async (claims) => ({ sub: claims.sub }),
  };
}

describe("cookie-BFF adapter bidi — type-level guarantees", () => {
  it("CookieBffModuleOptions gates clientContract on the third generic; annotated forRootAsync types conn.client", () => {
    // ----- 1. Opt-in: with the `never` default, clientContract is un-passable. -----
    const plain: CookieBffModuleOptions<TestUser, Router> = {
      ...baseOptions(),
      // @ts-expect-error — no TClientContract ⇒ `clientContract?: never`.
      clientContract,
    };
    void plain;

    // ----- 1b. With the third generic, the options ACCEPT the value and the
    // hook conn carries the typed caller. -----
    const bidi: CookieBffModuleOptions<TestUser, Router, ClientContract> = {
      ...baseOptions(),
      clientContract,
      hooks: {
        onConnected: (conn) => {
          const caller: ContractRouterClient<ClientContract> = conn.client;
          void caller;
        },
      },
    };
    void bidi;

    // ----- 2. forRootAsync with ONLY an annotated useFactory return type. -----
    // NO explicit type arguments on the call — the annotation alone must flow
    // `TClientContract` through (an unannotated factory would collapse it to
    // `never` and `conn.client` would silently disappear — the documented
    // footgun; this pins its prescribed fix).
    CookieBffModule.forRootAsync({
      useFactory: (): CookieBffModuleOptions<
        TestUser,
        Router,
        ClientContract
      > => ({
        ...baseOptions(),
        clientContract,
        hooks: {
          onConnected: (conn) => {
            // Typed-present: the annotated return type carried the generic.
            const caller: ContractRouterClient<ClientContract> = conn.client;
            void caller;
          },
        },
      }),
    });

    // ----- 3. Without the third generic, the hook conn has NO `client`. -----
    CookieBffModule.forRootAsync({
      useFactory: (): CookieBffModuleOptions<TestUser, Router> => ({
        ...baseOptions(),
        hooks: {
          onConnected: (conn) => {
            // @ts-expect-error — no TClientContract ⇒ the conn has no `client`.
            void conn.client;
          },
        },
      }),
    });
  });
});
