// BUG-8 regression (docs/fable/bugs-review.md) — HTTP upload context
// omitted `token`; the WS context included it.
//
// Both transports run the SAME composed router, so a procedure that
// reads `context.token` (e.g. to forward auth to an object store) must
// see the identical `{ user, token }` shape over either transport. The
// bug: the HTTP upload handler extracted the Bearer token in `runVerify`
// to authenticate, then DISCARDED it — `rpcHandler.handle` got
// `context: { user }` only, and `context.token` silently read
// `undefined` over HTTP while working over WS.
//
// Real Node HTTP server + ORPC `RPCLink` multipart roundtrip (same
// harness as `upload-flow.test.ts`) — the only layer where a procedure
// actually executes and its received context is observable.

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { os } from "@orpc/server";
import { RPCLink } from "@orpc/client/fetch";

import { OrpcWsServer, type VerifyClient } from "../../index.js";

interface TestUser {
  sub: string;
}

const GOOD_TOKEN = "good-token-value";

const verifyClient: VerifyClient<TestUser> = async (ctx) => {
  if (ctx.token === GOOD_TOKEN) {
    return { ok: true, user: { sub: "alice" }, connectionKey: "alice" };
  }
  return { ok: false, code: 401, reason: "Bad token" };
};

async function startServerWithHandler(
  server: OrpcWsServer<TestUser, object>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = server.getHttpHandler();
  if (!handler) throw new Error("expected handler to be non-null");

  const http: HttpServer = createServer((req, res) => {
    if (req.url?.startsWith("/upload")) {
      handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
      }),
  };
}

describe("BUG-8 — HTTP upload context carries the Bearer token (WS parity)", () => {
  it("the upload-executed procedure receives context.token equal to the Bearer token", async () => {
    const contextSpy = vi.fn();
    const router = {
      media: {
        upload: os.handler(async ({ context }) => {
          contextSpy(context);
          // Echo what the procedure saw so the assertion also covers the
          // full serialize/deserialize roundtrip, not just the spy.
          const ctx = context as { user: TestUser; token: string | null };
          return { sub: ctx.user.sub, token: ctx.token };
        }),
      },
    };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient,
      uploads: { enabled: true, httpPath: "/upload" },
    });
    const { port, close } = await startServerWithHandler(server);

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        headers: () => ({ authorization: `Bearer ${GOOD_TOKEN}` }),
      });

      const result = await link.call(
        ["media", "upload"],
        {
          file: new Blob(["hello world"], { type: "text/plain" }),
          name: "hello.txt",
        },
        { context: {} },
      );

      // Identical context shape to the WS transport's
      // `{ user, token }` (ConnectionHandler.handle): the token is the
      // LITERAL Bearer credential the client sent, not undefined.
      // (`toMatchObject`, not `toEqual` — ORPC's handler plugins add an
      // internal symbol key to the context object it passes through.)
      expect(contextSpy).toHaveBeenCalledOnce();
      expect(contextSpy.mock.calls[0]?.[0]).toMatchObject({
        user: { sub: "alice" },
        token: GOOD_TOKEN,
      });
      expect(result).toEqual({ sub: "alice", token: GOOD_TOKEN });
    } finally {
      await server.dispose();
      await close();
    }
  });
});
