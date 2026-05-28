// Unit tests for the HTTP upload handler.
//
// Three concerns:
//   1. `OrpcWsServer.getHttpHandler()` returns `null` when uploads is
//      disabled (the default) and a callable when enabled.
//   2. Bearer token extraction works for the happy path + cleanly
//      returns null for missing / malformed Authorization headers.
//   3. The handler invokes verifyClient with the extracted token and
//      rejects with 401 when verify says `ok: false`.
//
// Note: full integration (a real POST, multipart parsing, ORPC roundtrip)
// lives in `__tests__/integration/upload-flow.test.ts` — this file stays
// at the seam level.

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";
import { os } from "@orpc/server";

import { OrpcWsServer, type VerifyClient } from "../../index.js";
import { extractBearerToken } from "../http-verify.js";

interface TestUser {
  sub: string;
}

const okVerify: VerifyClient<TestUser> = async () => ({
  ok: true,
  user: { sub: "u1" },
  connectionKey: "u1",
});

describe("OrpcWsServer.getHttpHandler", () => {
  it("returns null when uploads is not configured", () => {
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: okVerify,
    });
    expect(server.getHttpHandler()).toBeNull();
  });

  it("returns null when uploads.enabled is false", () => {
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: okVerify,
      uploads: { enabled: false },
    });
    expect(server.getHttpHandler()).toBeNull();
  });

  it("returns a callable handler when uploads.enabled is true", () => {
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/upload" },
    });
    const handler = server.getHttpHandler();
    expect(handler).toBeTypeOf("function");
  });

  it("getUploadConfig returns the merged config", () => {
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: okVerify,
      uploads: { enabled: true, httpPath: "/files", bodyLimitBytes: 1024 },
    });
    const cfg = server.getUploadConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.httpPath).toBe("/files");
    expect(cfg.bodyLimitBytes).toBe(1024);
  });
});

describe("extractBearerToken", () => {
  function fakeReq(authorization?: string): IncomingMessage {
    return {
      headers: authorization === undefined ? {} : { authorization },
    } as unknown as IncomingMessage;
  }

  it("returns the token for `Bearer xxx`", () => {
    expect(extractBearerToken(fakeReq("Bearer abc.def.ghi"))).toBe(
      "abc.def.ghi",
    );
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken(fakeReq("bearer hello"))).toBe("hello");
    expect(extractBearerToken(fakeReq("BEARER hello"))).toBe("hello");
  });

  it("returns null when the header is absent", () => {
    expect(extractBearerToken(fakeReq())).toBeNull();
  });

  it("returns null when the scheme is not Bearer", () => {
    expect(extractBearerToken(fakeReq("Basic dXNlcjpwYXNz"))).toBeNull();
  });

  it("returns null when the header is empty", () => {
    expect(extractBearerToken(fakeReq(""))).toBeNull();
  });

  it("returns null when the header is just `Bearer ` (no token)", () => {
    expect(extractBearerToken(fakeReq("Bearer "))).toBeNull();
    // Whitespace-only after the scheme is also rejected.
    expect(extractBearerToken(fakeReq("Bearer    "))).toBeNull();
  });
});

describe("HTTP handler: pre-handle verifyClient", () => {
  /**
   * Build a fake (req, res) pair the handler can call into without a
   * real socket. We only assert on what the response wrote and what
   * verifyClient observed.
   */
  function makeFakePair(authorization?: string): {
    req: IncomingMessage;
    res: ServerResponse;
    written: { statusCode?: number; body?: string };
  } {
    const written: { statusCode?: number; body?: string } = {};
    const req = {
      headers: {
        ...(authorization !== undefined
          ? { authorization }
          : {}),
        host: "test.local",
      },
      url: "/upload/foo",
      method: "POST",
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((body?: string) => {
        written.body = body;
      }),
      get statusCode_() {
        return written.statusCode;
      },
      set statusCode_(c: number) {
        written.statusCode = c;
      },
    } as unknown as ServerResponse;
    // Capture statusCode writes via a Proxy-ish trap.
    Object.defineProperty(res, "statusCode", {
      get: () => written.statusCode ?? 200,
      set: (v: number) => {
        written.statusCode = v;
      },
    });
    return { req, res, written };
  }

  it("invokes verifyClient with the extracted Bearer token", async () => {
    const verify = vi.fn<VerifyClient<TestUser>>(async () => ({
      ok: false,
      code: 401,
      reason: "Unauthorized",
    }));
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: verify,
      uploads: { enabled: true, httpPath: "/upload" },
    });

    const handler = server.getHttpHandler()!;
    const { req, res } = makeFakePair("Bearer my-good-token");

    handler(req, res);
    // Verify is async; wait one tick + drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(verify).toHaveBeenCalledOnce();
    const call = verify.mock.calls[0]?.[0];
    expect(call?.token).toBe("my-good-token");
  });

  it("returns 401 when verifyClient rejects", async () => {
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: async () => ({
        ok: false,
        code: 401,
        reason: "Bad token",
      }),
      uploads: { enabled: true, httpPath: "/upload" },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, written } = makeFakePair("Bearer nope");

    handler(req, res);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(written.statusCode).toBe(401);
    expect(written.body).toContain("Bad token");
  });

  it("returns 401 when no Authorization header is present", async () => {
    const verify = vi.fn<VerifyClient<TestUser>>(async (ctx) => {
      // Consumer's policy: no token → reject. The library passes
      // token=null to the consumer for them to decide.
      if (!ctx.token) return { ok: false, code: 401, reason: "Missing token" };
      return { ok: true, user: { sub: "u" } };
    });
    const server = new OrpcWsServer<TestUser, { ping: unknown }>({
      router: { ping: os.handler(async () => "pong") },
      verifyClient: verify,
      uploads: { enabled: true, httpPath: "/upload" },
    });

    const handler = server.getHttpHandler()!;
    const { req, res, written } = makeFakePair(); // no Authorization

    handler(req, res);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[0].token).toBeNull();
    expect(written.statusCode).toBe(401);
  });
});
