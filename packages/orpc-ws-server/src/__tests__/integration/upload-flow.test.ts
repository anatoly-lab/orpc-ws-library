// Phase 6 — integration test for the HTTP upload transport.
//
// Spins up a real Node HTTP server, attaches the OrpcWsServer's HTTP
// upload handler at `/upload`, and POSTs a request against it. Pins
// three observable behaviors:
//
//   1. Missing Authorization → 401 + handler did NOT reach the consumer's
//      router (verifyClient gates before ORPC's match).
//   2. Bad Bearer token → 401, same as above.
//   3. Good Bearer token → handler runs through to the procedure and
//      returns 200 (procedure executed, response received).
//
// We use ORPC's HTTP `RPCLink` as the client — same one
// `OrpcHttpUploadStrategy` uses — so the multipart encoding is exactly
// what production code will send. Avoids hand-rolling multipart bodies.

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

/**
 * Build a router with a `media.upload` procedure that returns the file's
 * size and the user from context. The verifyClient result is passed in
 * via `context.user`.
 */
function buildRouter(handler: (input: unknown, ctx: unknown) => unknown) {
  return {
    media: {
      upload: os.handler(async ({ input, context }) =>
        handler(input, context),
      ),
    },
  };
}

/**
 * Start an HTTP server, attach the upload handler, return port + close fn.
 */
async function startServerWithHandler(
  server: OrpcWsServer<TestUser, object>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = server.getHttpHandler();
  if (!handler) throw new Error("expected handler to be non-null");

  const http: HttpServer = createServer((req, res) => {
    // The handler is mounted at the upload path; for these tests we
    // simulate the NestJS adapter's `app.use(httpPath, handler)` by
    // routing only requests under `/upload` to it. Anything else 404s.
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url.startsWith("/upload")) {
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

describe("Upload HTTP transport — integration", () => {
  it("rejects with 401 when no Authorization header is sent", async () => {
    const procedureSpy = vi.fn();
    const router = buildRouter((input, ctx) => {
      procedureSpy(input, ctx);
      return { ok: true };
    });
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient,
      uploads: { enabled: true, httpPath: "/upload" },
    });
    const { port, close } = await startServerWithHandler(server);

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        // No Authorization header.
        headers: () => ({}),
      });

      // ORPC throws on non-2xx; we capture and inspect.
      let error: unknown = undefined;
      try {
        await link.call(
          ["media", "upload"],
          {
            file: new Blob(["hello world"], { type: "text/plain" }),
            name: "hello.txt",
          },
          { signal: new AbortController().signal, context: {} },
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      // The procedure must NOT have been reached.
      expect(procedureSpy).not.toHaveBeenCalled();
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("rejects with 401 when the Bearer token is bad", async () => {
    const procedureSpy = vi.fn();
    const router = buildRouter((input, ctx) => {
      procedureSpy(input, ctx);
      return { ok: true };
    });
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient,
      uploads: { enabled: true, httpPath: "/upload" },
    });
    const { port, close } = await startServerWithHandler(server);

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        headers: () => ({ authorization: "Bearer wrong-token" }),
      });

      let error: unknown = undefined;
      try {
        await link.call(
          ["media", "upload"],
          { file: new Blob(["x"]) },
          { context: {} },
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(procedureSpy).not.toHaveBeenCalled();
    } finally {
      await server.dispose();
      await close();
    }
  });

  it("accepts and routes to the procedure when the Bearer token is good", async () => {
    const procedureSpy = vi.fn();
    const router = buildRouter((input, ctx) => {
      procedureSpy(input, ctx);
      // Return a marker so we can assert the response came from us.
      return { uploaded: true, sub: (ctx as { user: TestUser }).user.sub };
    });
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

      expect(procedureSpy).toHaveBeenCalledOnce();
      // Verified user landed in context.
      expect(result).toEqual({ uploaded: true, sub: "alice" });
    } finally {
      await server.dispose();
      await close();
    }
  });
});
