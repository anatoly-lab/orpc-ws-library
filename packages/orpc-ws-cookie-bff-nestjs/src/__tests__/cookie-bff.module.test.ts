// `CookieBffModule.forRootAsync` wiring + the Decision #23 proof.
//
// Decision #23: a consumer importing ONLY `CookieBffModule` must get a working
// cookie verifier on the WS server WITHOUT touching any WS verifier wiring. We
// prove it by resolving the `ORPC_WS_OPTIONS` the INTERNAL `OrpcWsModule`
// received and invoking its `verifyClient` against the cookie + fake store:
// it authenticates from the session cookie end-to-end.

import type { IncomingMessage } from "node:http";

import { describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { HttpAdapterHost } from "@nestjs/core";
import { Injectable, Module } from "@nestjs/common";
import { ORPC_WS_OPTIONS, type OrpcWsModuleOptions } from "@orpc-ws/server-nestjs";

import "reflect-metadata";

import { CookieBffModule } from "../cookie-bff.module.js";
import { CookieBffService } from "../cookie-bff.service.js";
import { COOKIE_BFF_CORE, COOKIE_BFF_OPTIONS } from "../cookie-bff.tokens.js";
import {
  FakeSessionStore,
  liveSession,
  stubHttpAdapterHost,
  type TestUser,
} from "./fakes.js";
import type { CookieBffModuleOptions } from "../cookie-bff.options.js";

const ORIGIN = "https://web.example";
const ROUTER = { ping: "fake-procedure" };

function options(store: FakeSessionStore): CookieBffModuleOptions<TestUser> {
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

// A DI dep proving forRootAsync threads injected providers into the factory.
// Holds the SAME store the test seeds, so the wired verifier reads it.
@Injectable()
class FakeStoreProvider {
  store = new FakeSessionStore();
}
@Module({ providers: [FakeStoreProvider], exports: [FakeStoreProvider] })
class FakeStoreModule {}

/**
 * Compile a testing module wiring `CookieBffModule.forRootAsync`. The factory
 * pulls the store from the injected `FakeStoreProvider` (proving DI threading),
 * and `seed` lets a test pre-populate THAT store so the wired verifier sees it.
 */
async function compile(seed?: (store: FakeSessionStore) => void) {
  const provider = new FakeStoreProvider();
  seed?.(provider.store);

  return Test.createTestingModule({
    imports: [
      FakeStoreModule,
      CookieBffModule.forRootAsync<TestUser>({
        imports: [FakeStoreModule],
        inject: [FakeStoreProvider],
        useFactory: (dep: FakeStoreProvider) => {
          const opts = options(dep.store); // store comes from the injected dep
          return opts;
        },
      }),
    ],
  })
    .overrideProvider(FakeStoreProvider)
    .useValue(provider)
    .overrideProvider(HttpAdapterHost)
    .useValue(stubHttpAdapterHost)
    .compile();
}

describe("CookieBffModule.forRootAsync", () => {
  it("compiles with an injected store and exposes CookieBffService", async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(CookieBffService)).toBeInstanceOf(CookieBffService);
    // The core (the /auth/* handlers) is built and injectable.
    expect(moduleRef.get(COOKIE_BFF_CORE)).toHaveProperty("login");
    expect(moduleRef.get(COOKIE_BFF_CORE)).toHaveProperty("callback");

    await moduleRef.close();
  });

  it("DECISION #23: the internal OrpcWsModule got a cookie verifier wired from the same config", async () => {
    const moduleRef = await compile((store) =>
      store.map.set("sid-1", liveSession("kc-1")),
    );

    // The OrpcWsModule options the bridge produced — resolved off the SAME
    // container, proving the adapter (not the consumer) wired the verifier.
    const wsOptions = moduleRef.get<OrpcWsModuleOptions<TestUser>>(
      ORPC_WS_OPTIONS,
      { strict: false },
    );

    // Router was forwarded.
    expect(wsOptions.router).toBe(ROUTER);
    // A verifyClient was built (authenticated arm, so it's present).
    if (wsOptions.mode === "authless") throw new Error("expected authed arm");
    expect(typeof wsOptions.verifyClient).toBe("function");

    // Invoke it against the session cookie — it authenticates from the store.
    const ctx = {
      req: { headers: { cookie: "__Host-sid=sid-1" } } as IncomingMessage,
      token: null,
      clientIp: "1.2.3.4",
      origin: ORIGIN,
      secure: true,
    };
    const result = await wsOptions.verifyClient(ctx);
    expect(result).toMatchObject({
      ok: true,
      user: { id: "db-kc-1", sub: "kc-1" },
      connectionKey: "kc-1",
    });

    await moduleRef.close();
  });

  it("the wired verifier rejects a disallowed Origin (fail-closed)", async () => {
    const moduleRef = await compile((store) =>
      store.map.set("sid-1", liveSession("kc-1")),
    );

    const wsOptions = moduleRef.get<OrpcWsModuleOptions<TestUser>>(
      ORPC_WS_OPTIONS,
      { strict: false },
    );
    if (wsOptions.mode === "authless") throw new Error("expected authed arm");

    const result = await wsOptions.verifyClient({
      req: { headers: { cookie: "__Host-sid=sid-1" } } as IncomingMessage,
      token: null,
      clientIp: "1.2.3.4",
      origin: "https://evil.example",
      secure: true,
    });
    expect(result).toMatchObject({ ok: false });

    await moduleRef.close();
  });

  it("F1a: forwards WS lifecycle `hooks` to the internal OrpcWsModule", async () => {
    const onConnected = vi.fn();
    const onKicked = vi.fn();
    const provider = new FakeStoreProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeStoreModule,
        CookieBffModule.forRootAsync<TestUser>({
          imports: [FakeStoreModule],
          inject: [FakeStoreProvider],
          useFactory: (dep: FakeStoreProvider) => ({
            ...options(dep.store),
            hooks: { onConnected, onKicked },
          }),
        }),
      ],
    })
      .overrideProvider(FakeStoreProvider)
      .useValue(provider)
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    const wsOptions = moduleRef.get<OrpcWsModuleOptions<TestUser>>(
      ORPC_WS_OPTIONS,
      { strict: false },
    );
    if (wsOptions.mode === "authless") throw new Error("expected authed arm");
    // The same hooks object reached the WS-server options.
    expect(wsOptions.hooks?.onConnected).toBe(onConnected);
    expect(wsOptions.hooks?.onKicked).toBe(onKicked);

    await moduleRef.close();
  });

  it("runs the async useFactory with injected deps", async () => {
    const store = new FakeSessionStore();
    const useFactory = vi.fn((dep: FakeStoreProvider) => {
      const opts = options(store);
      opts.sessionStore = dep.store;
      return opts;
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeStoreModule,
        CookieBffModule.forRootAsync<TestUser>({
          imports: [FakeStoreModule],
          inject: [FakeStoreProvider],
          useFactory,
        }),
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    expect(useFactory).toHaveBeenCalledWith(expect.any(FakeStoreProvider));
    await moduleRef.close();
  });
});

describe("CookieBffModule.forRoot (sync)", () => {
  it("compiles from a literal options object", async () => {
    const store = new FakeSessionStore();
    const moduleRef = await Test.createTestingModule({
      imports: [CookieBffModule.forRoot<TestUser>(options(store))],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    expect(moduleRef.get(CookieBffService)).toBeInstanceOf(CookieBffService);
    await moduleRef.close();
  });
});

// REGRESSION GUARD for the subtle DI invariant: `COOKIE_BFF_OPTIONS`'s
// `useFactory` must run EXACTLY ONCE so the `/auth/*` core handlers and the
// internally-bridged WS verifier share the SAME `sessionStore` instance. If a
// future refactor rebuilt `optionsModule` (or provided the options twice), the
// factory would run twice and hand out two stores — the verifier would read a
// drawer the handlers never wrote to. The factory below returns a FRESH store
// on every call, so a second invocation would yield a DIFFERENT reference and
// the identity assertions below would fail.
describe("CookieBffModule single-resolution invariant", () => {
  it("invokes the options factory exactly once; core + verifier share one store", async () => {
    let calls = 0;
    const stores: FakeSessionStore[] = [];

    const moduleRef = await Test.createTestingModule({
      imports: [
        CookieBffModule.forRootAsync<TestUser>({
          useFactory: () => {
            calls += 1;
            const store = new FakeSessionStore(); // FRESH per call
            stores.push(store);
            return options(store);
          },
        }),
      ],
    })
      .overrideProvider(HttpAdapterHost)
      .useValue(stubHttpAdapterHost)
      .compile();

    // 1. Factory ran exactly once → exactly one store was created.
    expect(calls).toBe(1);
    expect(stores).toHaveLength(1);
    const theStore = stores[0]!;

    // 2. The resolved options (consumed by the COOKIE_BFF_CORE provider) hold
    //    that one store reference.
    const resolved = moduleRef.get<CookieBffModuleOptions<TestUser>>(
      COOKIE_BFF_OPTIONS,
      { strict: false },
    );
    expect(resolved.sessionStore).toBe(theStore);

    // 3. The internally-wired verifier reads the SAME store: seed a session on
    //    `theStore`, then authenticate through the verifier the OrpcWsModule
    //    got. If the factory had run twice, the verifier's store would be a
    //    different instance and this lookup would miss → ok:false.
    theStore.map.set("sid-1", liveSession("kc-1"));
    const wsOptions = moduleRef.get<OrpcWsModuleOptions<TestUser>>(
      ORPC_WS_OPTIONS,
      { strict: false },
    );
    if (wsOptions.mode === "authless") throw new Error("expected authed arm");
    const result = await wsOptions.verifyClient({
      req: { headers: { cookie: "__Host-sid=sid-1" } } as IncomingMessage,
      token: null,
      clientIp: "1.2.3.4",
      origin: ORIGIN,
      secure: true,
    });
    expect(result).toMatchObject({ ok: true, connectionKey: "kc-1" });

    await moduleRef.close();
  });
});
