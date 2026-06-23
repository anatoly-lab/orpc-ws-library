// SYMMETRIC to the WS interceptor coverage test: consumer-supplied handler
// `interceptors` are ALSO forwarded into the HTTP-upload RPCHandler, so the
// same central error logger covers a FAILING upload procedure.
//
// The forwarding (`OrpcWsServer` → `createHttpUploadHandler` →
// `new RPCHandler(..., { interceptors })`) is advertised in the option JSDoc
// but was untested. This drives a real multipart POST (ORPC's HTTP `RPCLink`,
// the same encoder `OrpcHttpUploadStrategy` uses) against a procedure that
// throws, and asserts the consumer's `onError` interceptor fired with the
// thrown error.
//
// If the feature were reverted (interceptors not forwarded to the upload
// handler), `interceptorSaw` would never be called and this test would fail.

import { describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { onError, os } from "@orpc/server";
import { RPCLink } from "@orpc/client/fetch";

import { OrpcWsServer, type VerifyClient } from "../../../index.js";

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

// A `media.upload` procedure that THROWS — the failure the interceptor must
// observe. The procedure runs AFTER verifyClient passes, so this is a genuine
// ORPC-level throw inside the upload RPCHandler (not a pre-ORPC reject).
const router = {
  media: {
    upload: os.handler(async () => {
      throw new Error("upload procedure boom");
    }),
  },
};

async function startServerWithHandler(
  server: OrpcWsServer<TestUser, typeof router>,
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

describe("interceptors cover the HTTP upload transport", () => {
  it("central onError fires for a throw in an upload procedure over a real multipart POST", async () => {
    const interceptorSaw = vi.fn();

    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient,
      uploads: { enabled: true, httpPath: "/upload" },
      // Same central logger as the WS handler — must cover upload procedures.
      interceptors: [onError((e) => interceptorSaw(e))],
    });
    const { port, close } = await startServerWithHandler(server);

    try {
      const link = new RPCLink({
        url: `http://127.0.0.1:${port}/upload`,
        headers: () => ({ authorization: `Bearer ${GOOD_TOKEN}` }),
      });

      // ORPC throws on the non-2xx the failing procedure produces; capture it.
      let error: unknown = undefined;
      try {
        await link.call(
          ["media", "upload"],
          {
            file: new Blob(["hello world"], { type: "text/plain" }),
            name: "hello.txt",
          },
          { context: {} },
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();

      // The interceptor SAW the upload procedure's throw — forwarding works.
      expect(interceptorSaw).toHaveBeenCalledTimes(1);
      const seen = interceptorSaw.mock.calls[0]?.[0] as Error;
      expect(seen).toBeInstanceOf(Error);
      expect(seen.message).toBe("upload procedure boom");
    } finally {
      await server.dispose();
      await close();
    }
  });
});
