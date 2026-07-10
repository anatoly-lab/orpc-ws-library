// Bidi (server→client RPC) threading through `CookieBffModule`.
//
// The adapter's ONLY bidi job is forwarding: `clientContract` on the module
// options must reach the internal `OrpcWsModule`'s `ORPC_WS_OPTIONS` as the
// SAME object reference (its PRESENCE is what flips bidi on in the core
// factory), alongside the cookie verifier the bridge already builds. And when
// it is OMITTED, the produced WS options must not grow a `clientContract` key
// — byte-identical one-way behavior.

import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import {
  type AnyContractRouter,
  ORPC_WS_OPTIONS,
  type OrpcWsModuleOptions,
} from "@orpc-ws/server-nestjs";

import "reflect-metadata";

import { CookieBffModule } from "../cookie-bff.module.js";
import { FakeSessionStore, stubHttpAdapterHost, type TestUser } from "./fakes.js";
import type { CookieBffModuleOptions } from "../cookie-bff.options.js";

const ORIGIN = "https://web.example";
const ROUTER = { ping: "fake-procedure" };

// A stand-in client contract. We deliberately do NOT depend on
// `@orpc/contract` to author a real one — the adapter treats the value as an
// opaque token it forwards unchanged, so an object reference is exactly what
// the assertion needs.
const clientContract = { showToast: {} } as unknown as AnyContractRouter;
type ClientContract = typeof clientContract;

function baseOptions(
  store: FakeSessionStore,
): CookieBffModuleOptions<TestUser, typeof ROUTER> {
  return {
    router: ROUTER,
    keycloak: {
      issuerUrl: "https://idp.example",
      clientId: "demo",
      redirectUri: "https://api.example/auth/callback",
    },
    originAllowlist: [ORIGIN],
    encryptionKey: Buffer.alloc(32, 1),
    sessionStore: store,
    spaRedirectUri: ORIGIN,
    resolveUser: async (claims) => ({ id: `db-${claims.sub}`, sub: claims.sub }),
  };
}

describe("CookieBffModule bidi (clientContract) threading", () => {
  it("forwards `clientContract` into the internal OrpcWsModule (bidi ON)", async () => {
    const store = new FakeSessionStore();

    const moduleRef = await Test.createTestingModule({
      imports: [
        // NO explicit type arguments on `forRootAsync` — the ANNOTATED
        // `useFactory` return type ALONE must flow the generics through
        // (without it higher-order inference would collapse `TClientContract`
        // to `never`). This is exactly the path the doc comment prescribes,
        // so the test proves the annotation suffices.
        CookieBffModule.forRootAsync({
          useFactory: (): CookieBffModuleOptions<
            TestUser,
            typeof ROUTER,
            ClientContract
          > => ({
            ...baseOptions(store),
            clientContract,
            hooks: {
              // Compile-time proof: with `clientContract` supplied, the hook's
              // `conn` carries a typed `client` caller. The body never runs in
              // this test (no WS server attaches).
              onConnected: (conn) => {
                void conn.client;
              },
            },
          }),
        }),
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    const wsOptions = moduleRef.get<
      OrpcWsModuleOptions<TestUser, typeof ROUTER, ClientContract>
    >(ORPC_WS_OPTIONS, { strict: false });

    if (wsOptions.mode === "authless") throw new Error("expected authed arm");
    // The SAME contract object reference reached the WS options — presence is
    // the runtime bidi switch, so identity (not shape) is the invariant.
    expect(wsOptions.clientContract).toBe(clientContract);
    // The cookie verifier bridge is unaffected by bidi.
    expect(typeof wsOptions.verifyClient).toBe("function");

    await moduleRef.close();
  });

  it("omitting `clientContract` leaves the WS options byte-identical (bidi OFF)", async () => {
    const store = new FakeSessionStore();

    const moduleRef = await Test.createTestingModule({
      imports: [
        CookieBffModule.forRootAsync<TestUser, typeof ROUTER>({
          useFactory: () => baseOptions(store),
        }),
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    const wsOptions = moduleRef.get<OrpcWsModuleOptions<TestUser>>(
      ORPC_WS_OPTIONS,
      { strict: false },
    );

    if (wsOptions.mode === "authless") throw new Error("expected authed arm");
    // NOT `toBeUndefined()` — the stated invariant is "no key at all" (the
    // adapter must not grow a `clientContract: undefined` entry), and `in`
    // is what distinguishes a missing key from an undefined value.
    expect("clientContract" in wsOptions).toBe(false);
    expect(typeof wsOptions.verifyClient).toBe("function");

    await moduleRef.close();
  });
});
