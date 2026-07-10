// FULL-BOOT cookie-authed bidi round-trip — the cookie+bidi combination over a
// LIVE socket (nowhere else in the repo do the cookie verifier and the bidi
// channel meet on a real connection: the server-nestjs integration test uses a
// token-shaped verifier, and the tests-e2e round-trip uses a trivial
// always-accept verifier).
//
// Recipe mirrors server-nestjs's `integration/bidi.test.ts` (NestFactory +
// ExpressAdapter on an ephemeral loopback port) plus a REAL `@orpc-ws/client`
// peer hosting a `clientRouter` (the answering side of the s2c channel, as in
// `tests-e2e/tests/bidi-roundtrip.e2e.test.ts`). `@orpc-ws/client` is a
// devDependency of this package for exactly this test — a dev-only edge from
// the adapter's tests to the client core (the PROD cores still never depend on
// each other; the cross-CORE meeting point remains `@repo/tests-e2e`).
//
// Why `ws://` works: the cookie `verifyClient` checks the Origin allowlist and
// the session cookie against the store — NOT `secure`/TLS. The `__Host-`
// prefix's Secure/Path invariants are BROWSER-enforced cookie-jar rules; a
// Node client is free to send the literal `__Host-sid=...` header over plain
// ws://, and the server only string-parses the Cookie header.
//
// Why the global-WebSocket stub: `@orpc-ws/client`'s partysocket transport
// resolves the WebSocket implementation from the GLOBAL. Node's built-in
// (undici) WebSocket is spec-compliant and therefore cannot attach a Cookie
// header (browsers own the cookie jar). The `ws` package can — so we stub the
// global with a `ws` subclass that pins the session Cookie + allowed Origin on
// every (re)connect, which is exactly what a browser would send automatically.

import { describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "net";
import { WebSocket as WsWebSocket } from "ws";
import { oc } from "@orpc/contract";
import { os } from "@orpc/server";
import { createOrpcWsClient } from "@orpc-ws/client";
import { OrpcWsService } from "@orpc-ws/server-nestjs";

import "reflect-metadata";

import { CookieBffModule } from "../../cookie-bff.module.js";
import type { CookieBffModuleOptions } from "../../cookie-bff.options.js";
import { FakeSessionStore, liveSession, type TestUser } from "../fakes.js";

const ORIGIN = "https://web.example";
const SID = "sid-1";
const SUB = "kc-1"; // verifier files the conn under `connectionKey = session.sub`
// The core's default session-cookie name (`cookies` omitted on the options).
const COOKIE_HEADER = `__Host-sid=${SID}`;

// The s2c contract — the server's typed view of the client's hosted router.
const clientContract = { echo: oc };
type ClientContract = typeof clientContract;

// The CLIENT's hosted router — answers the server's `conn.client.echo(...)`.
const clientRouter = {
  echo: os.handler(({ input }) => {
    const i = input as { msg: string };
    return { echoed: i.msg };
  }),
};

// The consumer's c2s router/contract (the server side of normal RPC). The
// round-trip under test is s2c, so a single trivial procedure suffices.
const router = {
  ping: os.handler(async () => "pong"),
};
type Router = typeof router;
type C2sContract = { ping: typeof oc };

// Quiet the watchdog so the short test window is its own.
const quietHeartbeat = { intervalMs: 10_000, timeoutMs: 5_000, pingPong: false };

// A `ws` WebSocket that pins the session cookie + allowed Origin on every
// upgrade — the Node stand-in for the browser's automatic cookie send.
class CookieCarryingWebSocket extends WsWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, {
      headers: { cookie: COOKIE_HEADER },
      origin: ORIGIN,
    });
  }
}

interface Captured {
  key?: string;
}

function buildAppModule(store: FakeSessionStore, captured: Captured) {
  @Module({
    imports: [
      // NO explicit type arguments — the ANNOTATED useFactory return type
      // alone flows `TClientContract` (the documented forRootAsync path).
      CookieBffModule.forRootAsync({
        useFactory: (): CookieBffModuleOptions<
          TestUser,
          Router,
          ClientContract
        > => ({
          router,
          keycloak: {
            issuerUrl: "https://idp.example",
            clientId: "demo",
            redirectUri: "https://api.example/auth/callback",
          },
          originAllowlist: [ORIGIN],
          encryptionKey: Buffer.alloc(32, 1),
          sessionStore: store,
          spaRedirectUri: ORIGIN,
          resolveUser: async (claims) => ({
            id: `db-${claims.sub}`,
            sub: claims.sub,
          }),
          clientContract,
          heartbeat: quietHeartbeat,
          hooks: {
            onConnected: (conn) => {
              captured.key = conn.key;
            },
          },
        }),
      }),
    ],
  })
  class AppModule {}
  return AppModule;
}

async function bootstrap(
  AppModule: new (...args: unknown[]) => unknown,
): Promise<{ app: NestExpressApplication; port: number }> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(),
    { logger: false },
  );
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, port: address.port };
}

async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitUntil: ${opts.label ?? "predicate"} not satisfied within ${timeoutMs}ms`,
  );
}

describe("CookieBffModule — full-boot cookie-authed bidi round-trip", () => {
  it("cookie-authed connection answers a server→client call with a real value", async () => {
    const store = new FakeSessionStore();
    // Seed a LIVE session — the drawer the cookie verifier opens on upgrade.
    await store.set(SID, liveSession(SUB));

    const captured: Captured = {};
    const { app, port } = await bootstrap(buildAppModule(store, captured));

    vi.stubGlobal("WebSocket", CookieCarryingWebSocket);
    let dispose: (() => void) | null = null;

    try {
      const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
        url: `ws://127.0.0.1:${port}/ws`,
        clientRouter,
        sleepDetection: false,
      });
      dispose = () => client.dispose();

      client.connect();
      await waitUntil(() => captured.key !== undefined, {
        label: "cookie-authed connection accepted",
      });

      // The cookie verifier accepted the upgrade and filed the connection
      // under the session's sub — proof the COOKIE arm (not a token) let the
      // bidi connection in.
      expect(captured.key).toBe(SUB);

      // Server→client round-trip through the internally-wired OrpcWsModule:
      // the injectable service resolves the conn by the verifier's key, and
      // the typed caller gets the client handler's REAL return value back.
      const service = app.get(OrpcWsService);
      const conn = service.getConnection<ClientContract>(SUB);
      expect(conn).toBeDefined();

      const result = (await conn!.client.echo({ msg: "hello-from-server" })) as {
        echoed: string;
      };
      expect(result.echoed).toBe("hello-from-server");
    } finally {
      dispose?.();
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});
