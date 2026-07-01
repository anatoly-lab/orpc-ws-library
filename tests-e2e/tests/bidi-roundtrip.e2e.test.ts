// Phase 6 — server↔client bidirectional-RPC e2e (the headline round-trip).
//
// This is the ONLY place both real cores meet: it imports the BUILT
// `@orpc-ws/server` AND `@orpc-ws/client` packages (neither core may depend on
// the other, so a cross-core test cannot live inside either package — it lives
// in this top-level `@repo/tests-e2e` workspace, which can devDep both). Turbo's
// `test` task `dependsOn: ["^build"]`, so the cores' `dist/` is built before this
// runs and we exercise the real published artifacts.
//
// Harness shape — a REAL `ws` server on an ephemeral 127.0.0.1 port (via
// `http.createServer().listen(0)`, exactly the server-integration-test pattern)
// + a REAL `createOrpcWsClient` connecting over `ws://127.0.0.1:<port>/ws`. The
// client's partysocket transport resolves the WebSocket implementation from the
// global (`this._options.WebSocket || WebSocket`); Node 22 ships a spec-compliant
// global `WebSocket` (undici), so no impl injection is needed and the full-duplex
// channel (incl. server→client frames) is genuine.
//
// What this proves that the per-package Phase-5 tests could not: a real ORPC
// client peer ANSWERS the server's s2c calls (Phase 5a used a plain `ws` client
// with no peer; Phase 5b inspected only the client's outbound framing). Here the
// values actually round-trip both ways over one multiplexed socket.

import { describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { oc } from "@orpc/contract";
import { os } from "@orpc/server";

import {
  createAuthlessOrpcWsServer,
  createOrpcWsServer,
  type AuthlessConnection,
  type ServerConnection,
  type VerifyClient,
} from "@orpc-ws/server";
import { createOrpcWsClient } from "@orpc-ws/client";

// ----------------------------------------------------------------------------
// Shared fixtures
// ----------------------------------------------------------------------------

interface TestUser {
  sub: string;
}

// Trivial always-accept verifier. Returns a fixed user + connectionKey so the
// test body can `server.getConnection("u1")`. Token is ignored — the client
// connects with no `?token=` and is accepted regardless.
const verify: VerifyClient<TestUser> = async () => ({
  ok: true,
  user: { sub: "u1" },
  connectionKey: "u1",
});

// The CONSUMER's c2s contract (server implements it, client calls it). The client
// takes only the contract TYPE (never a runtime value), so this is type-only. A
// bare `oc` procedure — no schema means the wire payload passes through
// untouched, which is all we need to assert a value round-trips.
type C2sContract = { greet: typeof oc };

// The server-side c2s implementation answering `client.rpc.greet(...)`.
const c2sRouter = {
  greet: os.handler(({ input }) => {
    const i = input as { name: string };
    return { hello: i.name };
  }),
};

// The s2c contract — the SERVER's typed view of the client's hosted router. Its
// PRESENCE (`clientContract`) is what flips bidi on server-side and gives
// `conn.client` its typed shape.
const clientContract = { echo: oc, boom: oc };
type ClientContract = typeof clientContract;

// The CLIENT's hosted router — the procedures the client answers when the server
// calls `conn.client.<proc>()`. `echo` returns an input-derived value (so a real
// value round-trips); `boom` throws (error-propagation scenario).
const clientRouter = {
  echo: os.handler(({ input }) => {
    const i = input as { msg: string };
    return { echoed: i.msg };
  }),
  boom: os.handler((): never => {
    throw new Error("client handler boom");
  }),
};

// Single-procedure s2c fixture for the teardown test (scenario 5): a handler
// that NEVER resolves on its own, so the only way a pending server-side call to
// it settles is the connection teardown rejecting it.
const blockContract = { block: oc };
type BlockContract = typeof blockContract;

const blockRouter = {
  block: os.handler(() => new Promise<never>(() => {})),
};

// Heartbeat tuned for short tests: fast cadence (a few beats per test) with a
// generous client deadline (`intervalMs + timeoutMs` = 5.2s), so liveness is
// actively exercised yet never trips a spurious timeout/reconnect mid-test.
// pingPong off — the ORPC heartbeat channel alone carries liveness, keeping the
// assertions on pure application traffic.
const HEARTBEAT = { intervalMs: 200, timeoutMs: 5_000, pingPong: false };

// ----------------------------------------------------------------------------
// Harness helpers (lifted from the existing per-package integration tests)
// ----------------------------------------------------------------------------

/** A bare HTTP server on an ephemeral loopback port, for `ws` to attach to. */
async function startHttpServer(): Promise<{
  http: HttpServer;
  port: number;
  close: () => Promise<void>;
}> {
  const http = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    http,
    port,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
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

/** A one-shot promise + its resolver, for capturing the server-side conn. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe("bidi e2e — real ws server ↔ real orpc-ws client round-trip", () => {
  // 1. THE HEADLINE: a value round-trips server→client→server. The server, from
  //    its `onConnected(conn)`, calls the client's hosted `echo` and gets the
  //    client handler's REAL return value back.
  it("server→client round-trip: conn.client.echo returns the client handler's value", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<ServerConnection<TestUser, ClientContract>>();

    const server = createOrpcWsServer<TestUser, typeof c2sRouter, ClientContract>({
      router: c2sRouter,
      verifyClient: verify,
      clientContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter,
      sleepDetection: false,
    });

    try {
      client.connect();
      const conn = await connReady.promise;

      const result = (await conn.client.echo({ msg: "hello-from-server" })) as {
        echoed: string;
      };
      expect(result.echoed).toBe("hello-from-server");
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 2. ERROR PROPAGATION: a client handler that throws ⇒ the server's
  //    `conn.client.boom()` REJECTS. ORPC sanitizes the wire message, so we only
  //    assert it rejects with an Error, not the text.
  it("error propagation: a throwing client handler rejects the server-side s2c call", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<ServerConnection<TestUser, ClientContract>>();

    const server = createOrpcWsServer<TestUser, typeof c2sRouter, ClientContract>({
      router: c2sRouter,
      verifyClient: verify,
      clientContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter,
      sleepDetection: false,
    });

    try {
      client.connect();
      const conn = await connReady.promise;

      await expect(conn.client.boom({ anything: true })).rejects.toThrow();
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 3. CONCURRENT s2c calls: the server fires several `echo`s at once to distinct
  //    inputs ⇒ each resolves to ITS OWN value, proving request-id multiplexing
  //    over the single channel (no cross-talk / response misrouting).
  it("concurrent s2c calls each resolve to their own value (request-id mux)", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<ServerConnection<TestUser, ClientContract>>();

    const server = createOrpcWsServer<TestUser, typeof c2sRouter, ClientContract>({
      router: c2sRouter,
      verifyClient: verify,
      clientContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter,
      sleepDetection: false,
    });

    try {
      client.connect();
      const conn = await connReady.promise;

      const inputs = ["a", "b", "c", "d", "e"];
      const results = (await Promise.all(
        inputs.map((msg) => conn.client.echo({ msg })),
      )) as Array<{ echoed: string }>;

      expect(results.map((r) => r.echoed)).toEqual(inputs);
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 4. NO INTERFERENCE: on the SAME live connection a normal c2s RPC and an s2c
  //    call both succeed, and the heartbeat (multiplexed on the c2s channel) keeps
  //    the socket alive across several beats. Demonstrates the three traffic kinds
  //    coexist on one socket without breaking liveness.
  it("s2c alongside c2s + heartbeat coexist on one connection without interference", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<ServerConnection<TestUser, ClientContract>>();

    const server = createOrpcWsServer<TestUser, typeof c2sRouter, ClientContract>({
      router: c2sRouter,
      verifyClient: verify,
      clientContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter,
      sleepDetection: false,
    });

    try {
      client.connect();
      const conn = await connReady.promise;
      await waitUntil(
        () => client.state.getState().status === "connected",
        { label: "client connected" },
      );

      // c2s (client → server) typed RPC.
      const greeting = (await client.rpc.greet({ name: "Ada" })) as {
        hello: string;
      };
      expect(greeting.hello).toBe("Ada");

      // s2c (server → client) typed RPC on the same socket.
      const echoed = (await conn.client.echo({ msg: "still-here" })) as {
        echoed: string;
      };
      expect(echoed.echoed).toBe("still-here");

      // Let several heartbeats (every 200ms) flow, then prove the connection is
      // still alive AND both directions still work — heartbeat did not disrupt,
      // and application traffic did not starve the heartbeat.
      await new Promise((r) => setTimeout(r, 700));
      expect(client.state.getState().status).toBe("connected");

      const greeting2 = (await client.rpc.greet({ name: "Bob" })) as {
        hello: string;
      };
      expect(greeting2.hello).toBe("Bob");
      const echoed2 = (await conn.client.echo({ msg: "after-beats" })) as {
        echoed: string;
      };
      expect(echoed2.echoed).toBe("after-beats");
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 5. TEARDOWN MUST NOT HANG: an in-flight s2c call to a client handler that
  //    never resolves on its own ⇒ when the connection closes (client dispose),
  //    the server-side promise REJECTS rather than hanging forever. The bounded
  //    vitest test timeout makes a regression (a true hang) fail fast.
  it("teardown: an in-flight s2c call rejects (does not hang) when the connection closes", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<ServerConnection<TestUser, BlockContract>>();

    // A separate, single-procedure contract/router whose handler NEVER resolves —
    // the only way this s2c call settles is the connection teardown rejecting it.
    const server = createOrpcWsServer<TestUser, typeof c2sRouter, BlockContract>({
      router: c2sRouter,
      verifyClient: verify,
      clientContract: blockContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof blockRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter: blockRouter,
      sleepDetection: false,
    });

    try {
      client.connect();
      const conn = await connReady.promise;

      // Fire the never-resolving s2c call and attach the rejection assertion
      // BEFORE tearing down, so the rejection is awaited (no unhandled rejection).
      const pending = conn.client.block({ forever: true });
      const settled = expect(pending).rejects.toThrow();

      // Give the request a tick to leave on the wire, then close from the client.
      await new Promise((r) => setTimeout(r, 30));
      client.dispose();

      await settled;
    } finally {
      // client already disposed above; dispose is idempotent so this is safe even
      // if an assertion threw earlier.
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 6. AUTHLESS bidi: `createAuthlessOrpcWsServer({ router, clientContract })` ↔ a
  //    client hosting a router ⇒ the round-trip works with NO auth, and the conn
  //    carries no `user`.
  it("authless bidi: round-trip works with no auth; conn has no user", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<AuthlessConnection<ClientContract>>();

    const server = createAuthlessOrpcWsServer<typeof c2sRouter, ClientContract>({
      router: c2sRouter,
      clientContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter,
      sleepDetection: false,
    });

    try {
      client.connect();
      const conn = await connReady.promise;

      // The authless conn type has no `user` field; assert the runtime agrees.
      expect((conn as { user?: unknown }).user).toBeUndefined();

      const echoed = (await conn.client.echo({ msg: "anon" })) as {
        echoed: string;
      };
      expect(echoed.echoed).toBe("anon");
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 7. OPT-IN OFF (regression): a normal client (NO clientRouter) against a server
  //    with NO clientContract ⇒ ordinary c2s RPC + heartbeat work exactly as
  //    before, and `getConnection(key)?.client` is ABSENT. Proves bidi is purely
  //    additive — the off path is unchanged.
  it("opt-in off: plain c2s + heartbeat work and conn carries no client", async () => {
    const { http, port, close } = await startHttpServer();
    const connReady = deferred<ServerConnection<TestUser>>();

    // No `clientContract` → bidi off (byte-identical pre-bidi server).
    const server = createOrpcWsServer<TestUser, typeof c2sRouter>({
      router: c2sRouter,
      verifyClient: verify,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => connReady.resolve(conn) },
    });
    server.attach(http);

    // No `clientRouter` → bidi off on the client too.
    const client = createOrpcWsClient<C2sContract>({
      url: `ws://127.0.0.1:${port}/ws`,
      sleepDetection: false,
    });

    try {
      client.connect();
      await connReady.promise;
      await waitUntil(
        () => client.state.getState().status === "connected",
        { label: "client connected" },
      );

      const greeting = (await client.rpc.greet({ name: "Grace" })) as {
        hello: string;
      };
      expect(greeting.hello).toBe("Grace");

      // The off-path conn exposes no `client`, via either delivery channel.
      const fromGet = server.getConnection("u1") as
        | { client?: unknown }
        | undefined;
      expect(fromGet).toBeDefined();
      expect(fromGet!.client).toBeUndefined();

      // Heartbeat liveness held across a few beats with bidi fully off.
      await new Promise((r) => setTimeout(r, 500));
      expect(client.state.getState().status).toBe("connected");
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });

  // 8. RECONNECT-THEN-s2c: force the client to reconnect (server drops the socket
  //    with a retryable, non-auth code) and assert s2c STILL works against the NEW
  //    server-side connection.
  //
  //    What this actually exercises (host SURVIVAL, not host rebuild): a server
  //    `close(1012)` is a `normal-disconnect` — the library just sets state, and
  //    partysocket reconnects its INNER socket under the SAME wrapper. So
  //    `WebSocketFactory.create` (hence `bidi.attach`) is NOT re-invoked and the
  //    client-side mux + s2c host SURVIVE; the surviving host answers the new
  //    server connection's s2c call. (The genuine wrapper-SWAP that rebuilds the
  //    mux + host fires only on a library-driven `swapSocket` — token-refresh /
  //    sleep-wake / heartbeat-timeout — and is pinned by the Phase-5b unit swap
  //    test. We don't fake one here; we drive the real normal-reconnect path.)
  //
  //    AUTHLESS is used deliberately: it assigns a UNIQUE key per connection, so a
  //    reconnect produces a brand-new `conn` (a second `onConnected`) instead of
  //    tripping single-session replacement (4005 `kicked`, which an authenticated
  //    same-key reconnect would). This drives the production reconnect path with
  //    NO token/auth machinery.
  it("reconnect: s2c works against the rebuilt connection after a forced socket drop", async () => {
    const { http, port, close } = await startHttpServer();
    const conns: Array<AuthlessConnection<ClientContract>> = [];

    const server = createAuthlessOrpcWsServer<typeof c2sRouter, ClientContract>({
      router: c2sRouter,
      clientContract,
      heartbeat: HEARTBEAT,
      hooks: { onConnected: (conn) => conns.push(conn) },
    });
    server.attach(http);

    const client = createOrpcWsClient<C2sContract, typeof clientRouter>({
      url: `ws://127.0.0.1:${port}/ws`,
      clientRouter,
      sleepDetection: false,
      // Fast, fixed reconnect delay so the swap happens promptly and
      // deterministically (default is 1s growing to 30s).
      reconnect: { minReconnectionDelay: 50, maxReconnectionDelay: 50 },
    });

    try {
      client.connect();
      await waitUntil(() => conns.length >= 1, { label: "first connection" });

      // s2c works on the first connection.
      const first = (await conns[0]!.client.echo({ msg: "before" })) as {
        echoed: string;
      };
      expect(first.echoed).toBe("before");

      // Force a server-side drop with a benign, retryable code (NOT 1008/4001/4005
      // — those drive auth-recovery/kick). partysocket auto-reconnects the inner
      // socket under the SAME wrapper (mux + host survive, not rebuilt — see the
      // block comment above), and the authless server files a fresh unique-key
      // connection that the surviving s2c host answers.
      conns[0]!.ws.close(1012, "service restart");

      await waitUntil(() => conns.length >= 2, {
        label: "reconnected (second connection)",
        timeoutMs: 6_000,
      });

      // s2c works against the NEW connection — the rebuilt s2c host answers.
      const second = (await conns[1]!.client.echo({ msg: "after-reconnect" })) as {
        echoed: string;
      };
      expect(second.echoed).toBe("after-reconnect");
    } finally {
      client.dispose();
      await server.dispose();
      await close();
    }
  });
});
