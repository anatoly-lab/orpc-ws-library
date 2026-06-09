// HTTP upload handler — the second `RPCHandler` against the same composed router.
//
// Phase 6. The WS handler (built in `OrpcWsServer`'s constructor) already
// owns the composed router; this handler is the HTTP-transport twin.
// Same router, two transports — CLAUDE.md "Architectural decisions for
// this phase" point 1.
//
// What this file owns:
//   1. Build the Node `RPCHandler` from `@orpc/server/node` against the
//      already-composed router (consumer's + library's stealth heartbeat).
//      Optionally install `BodyLimitPlugin` when `bodyLimitBytes` is set.
//   2. Wrap that into a Node/Express-compatible `(req, res, next?)`
//      callback. The Node `RPCHandler.handle()` resolves to
//      `{matched: true|false}`; we translate `matched: false` into a
//      404 response so the consumer's HTTP server sees a clean answer.
//   3. Pre-`handle()` auth: extract the Bearer token, run the consumer's
//      `verifyClient`, return 401 on failure with the consumer's
//      `code` / `reason`. The verified user lands in the ORPC `context`.
//
// What this file does NOT own:
//   - Mounting on an HTTP framework. The NestJS adapter does that
//     (`OrpcWsService.onApplicationBootstrap`). Bare-Node consumers do it
//     themselves via `OrpcWsServer.getHttpHandler()`.
//   - Router composition. The composed router is built once in
//     `OrpcWsServer`'s constructor and shared with both handlers.

import type { IncomingMessage, ServerResponse } from "http";

import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";

import { type Logger, noopLogger } from "@repo/orpc-ws-shared";

import type {
  VerifyClient,
  VerifyClientResult,
} from "../lifecycle/verify-client-orchestrator.js";

import {
  type BeforeUploadResult,
  DEFAULT_BEFORE_UPLOAD_REJECT_CODE,
  DEFAULT_BEFORE_UPLOAD_REJECT_REASON,
  type UploadHttpConfig,
} from "./http-config.js";
import { extractBearerToken } from "./http-verify.js";

/**
 * Node/Express-compatible handler signature.
 *
 * Express middleware is `(req, res, next)`; raw Node `http.Server` uses
 * `(req, res)`. We accept either by making `next` optional. When `next`
 * is provided AND `handle()` returns `matched: false`, we delegate to
 * `next()` so the Express app can try its other routes. When `next` is
 * absent and the request didn't match, we write 404 ourselves.
 */
export type HttpUploadHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (err?: unknown) => void,
) => void;

/**
 * Runtime fail-closed guards for the two consumer-supplied hook returns.
 *
 * Both `VerifyClient` and `BeforeUploadHook` are *typed* to return a
 * well-formed discriminated union, but a plain-JS consumer can violate
 * that at runtime — return `undefined`, a bare boolean, `{ ok: "yes" }` —
 * and TS cannot catch it. The hook-running helpers `await` the result; a
 * non-conforming *return* (unlike a throw) slips past their try/catch, and
 * the later `!result.ok` read then throws a TypeError inside the void-ed
 * async IIFE → unhandled rejection, no response written, request hangs.
 * These predicates narrow the runtime value so the helpers can coerce
 * anything malformed into a clean 500 reject. (`code`/`reason` are
 * required on the reject branch because the auth reject path reads them
 * without defaults, and the accept branch must carry a `user`.)
 */
function isWellFormedAuthResult(v: unknown): v is VerifyClientResult<unknown> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.ok === true) return "user" in r;
  if (r.ok === false) {
    return typeof r.code === "number" && typeof r.reason === "string";
  }
  return false;
}

function isWellFormedBeforeUploadResult(v: unknown): v is BeforeUploadResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  // `code`/`reason` are optional on the reject branch (the gate defaults
  // them), so a boolean `ok` is the only hard requirement here.
  return typeof r.ok === "boolean";
}

/**
 * Build the HTTP upload handler.
 *
 * @param composedRouter - The already-composed router (consumer's + system
 *   heartbeat), exactly the same instance the WS handler uses.
 * @param verifyClient - The consumer's auth callback. Bearer token from
 *   the HTTP request is extracted and passed as `ctx.token`.
 * @param config - Resolved HTTP upload config (path + body limit).
 * @param logger - Structured logger; defaults to noop.
 */
export function createHttpUploadHandler<TUser>(deps: {
  composedRouter: Record<string, unknown>;
  verifyClient: VerifyClient<TUser>;
  config: UploadHttpConfig<TUser>;
  logger?: Logger;
}): HttpUploadHandler {
  const logger = deps.logger ?? noopLogger;

  // ----- Build the ORPC Node HTTP RPCHandler -----
  // Plugins are installed conditionally; body-limit is the only one we
  // touch in v1. The RPCHandler accepts `Router<any, T>` — we type the
  // context as a record holding `user`, mirroring the WS context shape.
  const plugins =
    deps.config.bodyLimitBytes !== undefined
      ? [new BodyLimitPlugin({ maxBodySize: deps.config.bodyLimitBytes })]
      : [];

  // RPCHandler typing is parameterised on the runtime context. We use a
  // permissive `Record<string, unknown>` because the composed router has
  // heterogeneous keys (consumer narrow + library empty), same compromise
  // the WS handler in `OrpcWsServer` makes. The cast names the seam.
  const rpcHandler = new RPCHandler<Record<string, unknown>>(
    deps.composedRouter as never,
    { plugins },
  );

  /**
   * Run the consumer's verifyClient. Returns the auth result; on success
   * the caller invokes `rpcHandler.handle` with `result.user` as context.
   *
   * `clientIp` mirrors the WS verifier's extraction (x-forwarded-for first
   * hop, then socket address).
   */
  const runVerify = async (
    req: IncomingMessage,
  ): Promise<VerifyClientResult<TUser>> => {
    const token = extractBearerToken(req);
    const fwd = req.headers["x-forwarded-for"];
    const clientIp =
      typeof fwd === "string" && fwd.length > 0
        ? fwd.split(",")[0]?.trim()
        : req.socket.remoteAddress;
    try {
      const result = await deps.verifyClient({ req, token, clientIp });
      // Fail-closed normalisation. `verifyClient` is typed to return a
      // `VerifyClientResult`, but a plain-JS consumer can violate that
      // contract at runtime (return `undefined`, a bare boolean, etc.) —
      // a class TS cannot see. Without this guard a non-conforming return
      // escapes the catch (it's a return, not a throw) and the caller's
      // `!auth.ok` read throws inside the void-ed IIFE → unhandled
      // rejection, hung request. Coerce anything malformed to a 500 reject.
      if (!isWellFormedAuthResult(result)) {
        logger.error("orpc-ws-server: HTTP verifyClient returned a non-conforming value", {
          clientIp,
        });
        return { ok: false, code: 500, reason: "Internal server error" };
      }
      return result;
    } catch (err) {
      logger.error("orpc-ws-server: HTTP verifyClient threw", {
        error: err instanceof Error ? err.message : String(err),
        clientIp,
      });
      return { ok: false, code: 500, reason: "Internal server error" };
    }
  };

  /**
   * Run the consumer's `beforeUpload` gate (if configured) for an already-
   * authenticated request. Returns the consumer's discriminated-union
   * result; `{ ok: true }` when no hook is configured (absent hook = allow,
   * never accidentally blocks). A throw from the consumer's hook maps to a
   * 500 reject — mirroring `runVerify`, the consumer's async code must not
   * crash the request.
   *
   * Receives `headers` + `user` (the documented levers) plus the raw `req`
   * escape hatch — and deliberately NOT the body, which has not been read
   * yet (the caller invokes this BEFORE `rpcHandler.handle()`).
   */
  const runBeforeUpload = async (
    req: IncomingMessage,
    user: TUser,
  ): Promise<BeforeUploadResult> => {
    if (!deps.config.beforeUpload) return { ok: true };
    try {
      const result = await deps.config.beforeUpload({
        headers: req.headers,
        user,
        req,
      });
      // Fail-closed normalisation — see `isWellFormedBeforeUploadResult`.
      // A non-conforming *return* from a plain-JS hook escapes this catch
      // (it's a return, not a throw), so guard the shape here rather than
      // letting the `!gate.ok` read crash the void-ed IIFE.
      if (!isWellFormedBeforeUploadResult(result)) {
        logger.error("orpc-ws-server: HTTP beforeUpload returned a non-conforming value");
        return { ok: false, code: 500, reason: "Internal server error" };
      }
      return result;
    } catch (err) {
      logger.error("orpc-ws-server: HTTP beforeUpload threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, code: 500, reason: "Internal server error" };
    }
  };

  /**
   * Reply with a JSON-shaped error. The body is intentionally minimal —
   * just `{ error: reason }` — because verifyClient failures should not
   * leak internal detail. Consumers wanting richer error responses can
   * override `verifyClient` to return a different `reason` string.
   */
  const sendError = (res: ServerResponse, code: number, reason: string) => {
    if (res.headersSent) return;
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: reason }));
  };

  return (req, res, next) => {
    // ORPC's Node RPCHandler returns a promise; we kick it off here.
    void (async () => {
      const auth = await runVerify(req);
      if (!auth.ok) {
        logger.warn("orpc-ws-server: HTTP upload rejected", {
          code: auth.code,
          reason: auth.reason,
        });
        sendError(res, auth.code, auth.reason);
        return;
      }

      // ----- Pre-body-buffer gate -----
      // Runs AFTER verifyClient succeeds (so the hook sees the
      // authenticated `auth.user`) and BEFORE the URL is normalised /
      // `rpcHandler.handle()` reads the body. On reject we `sendError` and
      // return WITHOUT touching `handle()` — so a wrong-content-type or
      // oversized body is never buffered. A reject is definitive ("this
      // upload isn't allowed"), so we do NOT call `next()`: there is no
      // "let Express try another route" semantics for a gated upload.
      const gate = await runBeforeUpload(req, auth.user);
      if (!gate.ok) {
        const code = gate.code ?? DEFAULT_BEFORE_UPLOAD_REJECT_CODE;
        const reason = gate.reason ?? DEFAULT_BEFORE_UPLOAD_REJECT_REASON;
        logger.warn("orpc-ws-server: HTTP upload rejected by beforeUpload", {
          code,
          reason,
        });
        sendError(res, code, reason);
        return;
      }

      // Hand off to ORPC. We DON'T pass `prefix` here because we
      // normalise the URL ourselves. The challenge: depending on how the
      // consumer mounted the handler, the request shape differs.
      //   - Bare Node mount with path-routing
      //     (`if (req.url.startsWith('/upload')) handler(req, res)`):
      //     `req.url` still has the prefix; no `originalUrl`.
      //   - Express middleware (`app.use('/upload', handler)`):
      //     Express STRIPS the mount prefix from `req.url`, but sets
      //     `req.originalUrl` to the un-stripped URL. ORPC's Node
      //     adapter reads `originalUrl ?? url` — so it sees the FULL
      //     path including `/upload`.
      // Normalise both fields by stripping the configured `httpPath`
      // prefix from whichever field still carries it. ORPC then sees a
      // procedure-only path (`/media/upload`) and matches without a
      // configured prefix in either mount style.
      const reqMut = req as IncomingMessage & { originalUrl?: string };
      const stripPrefix = (u: string | undefined): string | undefined => {
        if (!u) return u;
        if (u === deps.config.httpPath) return "/";
        if (u.startsWith(`${deps.config.httpPath}/`)) {
          return u.slice(deps.config.httpPath.length);
        }
        return u;
      };
      reqMut.url = stripPrefix(reqMut.url);
      if (reqMut.originalUrl !== undefined) {
        reqMut.originalUrl = stripPrefix(reqMut.originalUrl);
      }

      try {
        const result = await rpcHandler.handle(req, res, {
          context: {
            user: auth.user,
          },
        });

        if (!result.matched) {
          // ORPC did not match the route. Delegate to `next` (Express)
          // if available so the consumer's other routes get a shot;
          // otherwise return 404 ourselves.
          if (next) {
            next();
            return;
          }
          sendError(res, 404, "Not found");
        }
      } catch (err) {
        logger.error("orpc-ws-server: HTTP handler threw", {
          error: err instanceof Error ? err.message : String(err),
        });
        // If response already started streaming we can't rewrite; the
        // request will close mid-flight. That's a worse UX than a clean
        // 500, but the alternative — buffering the entire response — is
        // not on the table for upload responses.
        if (!res.headersSent) {
          sendError(res, 500, "Internal server error");
        } else {
          // Best-effort: close the socket so the client doesn't hang.
          try {
            res.end();
          } catch {
            // Already ended / destroyed — fine.
          }
        }
        if (next) next(err);
      }
    })();
  };
}
