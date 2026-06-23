// LOAD-BEARING regression: consumer-supplied handler `interceptors` cover a
// procedure on a sub-router SPREAD IN UNWRAPPED, where a consumer ROOT
// MIDDLEWARE does NOT.
//
// The observability gap this closes (real source-app shape): the consumer's
// error logging lived in a ROUTER middleware (`metricsMiddleware`) attached to
// their `os` base. But the auth sub-router was merged in by plain-object spread
// (`{ ...authRouter.getRouter() }`), and those procedures were built from a
// SEPARATE/bare `os` base that never carried that middleware — so a throw in
// `auth.*` bypassed the logger entirely and went unlogged.
//
// Handler-level `interceptors` sit on the RPCHandler itself (OUTSIDE the router
// tree), so they fire for EVERY procedure regardless of how the router was
// composed — closing the gap. This test proves BOTH halves over a real `ws`
// round-trip:
//   (1) the root MIDDLEWARE records ONLY the nested procedure's error, NOT the
//       spread-in one — reproducing/locking the original gap, and
//   (2) the handler `interceptors` onError fires for BOTH errors — proving
//       interceptors are composition-agnostic and close the gap.
//
// If the feature were reverted (interceptors not forwarded), assertion (2)
// would fail for the spread-in procedure — and this test WOULD have caught the
// original bug, since (1) demonstrates the middleware genuinely misses it.

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { onError, os, type RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import WebSocketClient from "ws";

import { createOrpcWsServer } from "../../index.js";

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

// Records every error a procedure under it throws. This is the consumer's
// "central error logger" — the role the source app's `metricsMiddleware`
// played. ORPC's `onError` middleware util sees the thrown error then
// re-propagates it (it does not swallow), so the procedure still rejects.
const middlewareSaw: Error[] = [];

// The consumer's ROOT base carries the recording middleware. A procedure
// built FROM this base (nested/wrapped normally) runs the middleware.
const recordingBase = os.use(
  onError((e) => {
    middlewareSaw.push(e as Error);
  }),
);

// The auth sub-router is built on a SEPARATE, BARE `os` base — it never shares
// the recording middleware. This is the realistic shape of an externally-built
// `authRouter` whose `.getRouter()` is spread in unwrapped.
const authSubRouter = {
  whoami: os.handler(async () => {
    throw new Error("auth subrouter boom");
  }),
};

// The consumer's app router:
//   - `nested.fail` is built FROM `recordingBase` (middleware DOES wrap it),
//   - `auth.*` is the bare sub-router SPREAD IN UNWRAPPED (middleware does NOT
//     wrap it — it was never composed under `recordingBase`).
const router = {
  nested: {
    fail: recordingBase.handler(async () => {
      throw new Error("nested boom");
    }),
  },
  auth: {
    ...authSubRouter,
  },
};

type WsLike = Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "send" | "readyState"
>;

describe("interceptors cover a spread-in/unwrapped sub-router that root middleware misses", () => {
  it("root middleware records ONLY the nested error; handler interceptors record BOTH", async () => {
    middlewareSaw.length = 0;
    const { http, port, close } = await startHttpServer();

    const interceptorSaw = vi.fn();

    const server = createOrpcWsServer<{ id: string }, typeof router>({
      router,
      // `verifyClient` must return a Promise — the orchestrator `.then()`s it.
      verifyClient: async () => ({ ok: true, user: { id: "u1" } }),
      // The whole point: one central error logger on the HANDLER covers EVERY
      // procedure regardless of router composition — including the spread-in
      // sub-router the root middleware can't see.
      interceptors: [onError((e) => interceptorSaw(e))],
    });
    server.attach(http);

    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/ws?token=t`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    try {
      const link = new RPCLink({ websocket: ws as unknown as WsLike });
      const client = createORPCClient<RouterClient<typeof router>>(link);

      // Drive BOTH failing procedures over the real WS round-trip.
      await expect(client.nested.fail()).rejects.toThrow();
      await expect(client.auth.whoami()).rejects.toThrow();

      // (1) The root MIDDLEWARE only saw the NESTED procedure's error. The
      //     spread-in `auth.whoami` bypassed it — this reproduces and LOCKS
      //     the original observability gap: middleware genuinely misses an
      //     unwrapped-spread sub-router.
      expect(middlewareSaw.map((e) => e.message)).toEqual(["nested boom"]);

      // (2) The handler-level INTERCEPTOR saw BOTH throws — it is
      //     composition-agnostic and closes the gap.
      const interceptorMessages = interceptorSaw.mock.calls
        .map((c) => (c[0] as Error).message)
        .sort();
      expect(interceptorMessages).toEqual(["auth subrouter boom", "nested boom"]);
      expect(interceptorSaw).toHaveBeenCalledTimes(2);
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 30));
      await server.dispose();
      await close();
    }
  });
});
