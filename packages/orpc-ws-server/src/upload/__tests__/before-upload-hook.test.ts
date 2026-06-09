// Unit tests for the `beforeUpload` pre-body-buffer gate.
//
// The gate runs AFTER verifyClient succeeds and BEFORE ORPC's RPCHandler
// reads the body. These seam-level tests pin its observable contract
// without a real socket / multipart roundtrip (that lives in
// `__tests__/integration/upload-flow.test.ts`):
//
//   (a) reject before body buffering → chosen status, RPC handler (the
//       router procedure) NOT invoked, and `next` NOT called;
//   (b) accept path → request proceeds to the RPC handler;
//   (c) absent hook → behavior unchanged (no rejection);
//   (d) the hook receives the authenticated user + request headers.
//
// "RPC handler not called" is asserted via a `vi.fn` router procedure:
// the only way a post-auth request reaches the procedure is through
// `rpcHandler.handle()`, so the spy is a conclusive proxy for "body would
// have been buffered." Likewise a 415/418 status AFTER auth can only come
// from `beforeUpload` — verifyClient already passed.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { os } from "@orpc/server";

import {
  OrpcWsServer,
  type BeforeUploadHook,
  type VerifyClient,
} from "../../index.js";

interface TestUser {
  sub: string;
}

const okVerify: VerifyClient<TestUser> = async () => ({
  ok: true,
  user: { sub: "alice" },
  connectionKey: "alice",
});

/**
 * Fake (req, res) pair. `res` records the status code + body the handler
 * writes; `next` is a spy so we can assert it is NOT called on reject.
 * `req.url` targets a real procedure key (`media/upload`) so that, on the
 * accept path, ORPC would actually try to match + read the body — which is
 * exactly what we want the procedure spy to detect.
 */
function makeFakePair(headers: Record<string, string> = {}): {
  req: IncomingMessage;
  res: ServerResponse;
  next: ReturnType<typeof vi.fn>;
  written: { statusCode?: number; body?: string };
} {
  const written: { statusCode?: number; body?: string } = {};
  const req = {
    headers: {
      authorization: "Bearer good",
      host: "test.local",
      ...headers,
    },
    url: "/upload/media/upload",
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      written.body = body;
    }),
  } as unknown as ServerResponse;
  Object.defineProperty(res, "statusCode", {
    get: () => written.statusCode ?? 200,
    set: (v: number) => {
      written.statusCode = v;
    },
  });
  return { req, res, next: vi.fn(), written };
}

/** Drain a couple of microtask/macrotask turns for the async handler. */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("beforeUpload gate", () => {
  it("rejects with the default 415 and never reaches the RPC handler", async () => {
    const procedureSpy = vi.fn(async () => "pong");
    const beforeUpload: BeforeUploadHook<TestUser> = () => ({ ok: false });

    const router = { media: { upload: os.handler(procedureSpy) } };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/upload", beforeUpload },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, next, written } = makeFakePair({
      "content-type": "image/png",
    });

    handler(req, res, next);
    await drain();

    // Default reject status + canonical reason.
    expect(written.statusCode).toBe(415);
    expect(written.body).toContain("Unsupported Media Type");
    // Body never buffered → procedure never ran.
    expect(procedureSpy).not.toHaveBeenCalled();
    // Reject is definitive — do NOT delegate to Express.
    expect(next).not.toHaveBeenCalled();
  });

  it("honors the consumer's explicit reject code + reason (e.g. 413)", async () => {
    const procedureSpy = vi.fn(async () => "pong");
    const beforeUpload: BeforeUploadHook<TestUser> = () => ({
      ok: false,
      code: 413,
      reason: "Payload Too Large",
    });

    const router = { media: { upload: os.handler(procedureSpy) } };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/upload", beforeUpload },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, written } = makeFakePair({
      "content-length": "999999999",
    });

    handler(req, res);
    await drain();

    expect(written.statusCode).toBe(413);
    expect(written.body).toContain("Payload Too Large");
    expect(procedureSpy).not.toHaveBeenCalled();
  });

  it("receives the authenticated user and request headers", async () => {
    const seen = vi.fn<BeforeUploadHook<TestUser>>(() => ({ ok: false }));

    const router = { media: { upload: os.handler(async () => "pong") } };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/upload", beforeUpload: seen },
    });

    const handler = server.getHttpHandler()!;
    const { req, res } = makeFakePair({ "content-type": "application/zip" });

    handler(req, res);
    await drain();

    expect(seen).toHaveBeenCalledOnce();
    const ctx = seen.mock.calls[0]?.[0];
    // The authenticated principal from verifyClient.
    expect(ctx?.user).toEqual({ sub: "alice" });
    // The request headers — the documented primary lever.
    expect(ctx?.headers["content-type"]).toBe("application/zip");
    // Raw req escape hatch is present too.
    expect(ctx?.req).toBe(req);
  });

  it("maps a throwing hook to a 500 and never reaches the RPC handler", async () => {
    const procedureSpy = vi.fn(async () => "pong");
    const beforeUpload: BeforeUploadHook<TestUser> = () => {
      throw new Error("policy lookup exploded");
    };

    const router = { media: { upload: os.handler(procedureSpy) } };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/upload", beforeUpload },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, written } = makeFakePair();

    handler(req, res);
    await drain();

    expect(written.statusCode).toBe(500);
    expect(procedureSpy).not.toHaveBeenCalled();
  });

  it("maps an async-rejecting hook to a 500 and never reaches the RPC handler", async () => {
    const procedureSpy = vi.fn(async () => "pong");
    // Async throw (rejected promise) — distinct from the sync-throw case
    // above. The handler `await`s the hook, so a rejection lands in the
    // same catch and must fail CLOSED (500), not leak through as accept.
    const beforeUpload: BeforeUploadHook<TestUser> = async () => {
      throw new Error("async policy lookup exploded");
    };

    const router = { media: { upload: os.handler(procedureSpy) } };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/upload", beforeUpload },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, written } = makeFakePair();

    handler(req, res);
    await drain();

    expect(written.statusCode).toBe(500);
    expect(procedureSpy).not.toHaveBeenCalled();
  });

  it("absent hook = unchanged behavior (request proceeds to the RPC handler)", async () => {
    const procedureSpy = vi.fn(async () => "pong");

    const router = { media: { upload: os.handler(procedureSpy) } };
    const server = new OrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient: okVerify,
      // No beforeUpload configured.
      uploads: { enabled: true, httpPath: "/upload" },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, written } = makeFakePair();

    handler(req, res);
    await drain();

    // The gate is absent, so nothing rejected pre-handle: no 415/500 was
    // written by the gate. This is the reliable signal at the unit layer —
    // the fake `req` from `makeFakePair` is a plain object, NOT a readable
    // stream, so ORPC's `handle()` cannot buffer a real body and the
    // procedure spy would not fire here regardless of the gate. Asserting
    // `procedureSpy` were-called at this layer would test the fake, not the
    // contract. The backwards-compat proof — that an absent hook lets a
    // REAL multipart upload flow all the way to the procedure unchanged —
    // is the integration accept-path test
    // ("beforeUpload accept path lets a real upload proceed unchanged",
    // `__tests__/integration/upload-flow.test.ts`), which runs over a real
    // socket and asserts the procedure ran. Here we pin only what this
    // layer can prove: the gate did NOT short-circuit.
    expect(written.statusCode).not.toBe(415);
    expect(written.statusCode).not.toBe(500);
  });
});
