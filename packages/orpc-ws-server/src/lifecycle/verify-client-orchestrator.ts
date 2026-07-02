// Pre-upgrade auth orchestrator.
//
// Two concerns living in one class — both load-bearing for Bug 5 (no
// race between 101 response and the consumer's first message):
//
//   1. Translates the consumer's pluggable `VerifyClient` callback into
//      the shape `ws`'s `WebSocketServer` `verifyClient` option expects
//      (sync info → async result via Node-style callback). Auth happens
//      BEFORE the 101 upgrade response.
//
//   2. Stashes the auth result so the `'connection'` handler can retrieve
//      it synchronously. The source app stored it on
//      `(req as any).__wsAuth`; we use a `WeakMap<IncomingMessage,
//      VerifyClientResult>` instead — same wire effect, but no `any`
//      cast (CLAUDE.md "Tests from day 0 — non-negotiable" forbids
//      eroding end-to-end typing). The WeakMap also frees memory when
//      the request object is GC'd, which the source's monkey-patched
//      property did not.
//
// Token extraction (URL `?token=` query) lives here because every consumer
// VerifyClient needs the same bit; lifting it once is friendlier than
// asking each consumer to repeat the URL parsing dance. The consumer's
// callback receives `token` already extracted plus the raw `req` if they
// want headers / cookies.

import type { IncomingMessage } from "http";

import { type Logger, noopLogger } from "@orpc-ws/shared";

import { extractClientIp, extractToken } from "./request-helpers.js";

/**
 * Argument the library passes to the consumer's verify callback. The
 * consumer reads `token` for the default flow; `req` is escape-hatch
 * access for header-based / cookie-based auth setups.
 */
export interface VerifyClientContext {
  /** The raw upgrade request. Use for headers, cookies, etc. */
  req: IncomingMessage;
  /**
   * The `?token=` query param (URL-decoded by `URL`'s parser). `null`
   * when no token query is present; the consumer's verify decides what
   * that means (always-reject vs cookie-only flow).
   */
  token: string | null;
  /**
   * Source IP. Prefers `x-forwarded-for` (first hop) when present —
   * matches the source gateway's behavior behind a proxy / load balancer.
   * Falls back to the socket's remote address. `undefined` only in the
   * pathological case where neither is available.
   */
  clientIp: string | undefined;
  /**
   * The `Origin` header on the upgrade request (`ws`'s `info.origin`).
   * Empty string when the client sent no Origin header — non-browser
   * clients (curl, native apps, server-to-server) typically omit it.
   *
   * WebSocket upgrades are NOT subject to the same-origin policy, so
   * cross-site WebSocket hijacking is stopped only by credential
   * validity unless the consumer checks this value (SEC-3). It is
   * attacker-controlled (a non-browser client can send anything), but
   * browsers always set it truthfully — so it works as an allowlist
   * for browser traffic. Enforcement stays the consumer's choice; the
   * library only surfaces the value. An empty string naturally fails
   * an allowlist check (fail-closed).
   */
  origin: string;
  /**
   * Whether the upgrade arrived over TLS (`wss://`) — `ws`'s
   * `info.secure`. `false` for plain `ws://`. Behind a TLS-terminating
   * proxy the Node process sees plain TCP, so this is `false` even when
   * the public edge is TLS.
   */
  secure: boolean;
}

/**
 * Discriminated-union result from the consumer's `VerifyClient`.
 *
 * Discriminated union (vs thrown exception) is the documented contract
 * — verifyClient runs in `ws`'s upgrade callback, BEFORE any framework
 * exception filter exists. Throwing would force this library to catch
 * and map, and silently lose the consumer's error code. See
 * docs/implementation-plan.md "verifyClient's discriminated-union
 * return".
 *
 * `connectionKey` is the optional handle used by the connection registry
 * to enforce one-connection-per-user. When omitted, the registry falls
 * back to `JSON.stringify(user)` — coarse but safe.
 *
 * `expiresAt` is the credential's expiry instant in **epoch milliseconds**
 * (matching the injected `Clock.now()` unit — note the JWT `exp` claim is
 * epoch *seconds*, so verifiers convert `exp * 1000`). Optional and purely
 * informational unless `ConnectionConfig.enforceTokenExpiry` is enabled,
 * in which case the connection handler schedules a close
 * (`authFailedCloseCode`, default 4001) when the instant passes. Verifiers
 * that don't know the expiry simply omit it.
 */
export type VerifyClientResult<TUser> =
  | { ok: true; user: TUser; connectionKey?: string; expiresAt?: number }
  | { ok: false; code: number; reason: string };

/**
 * The consumer-pluggable verify callback. Async by contract — every real
 * consumer needs at least one external lookup (JWKS, DB, cache) before
 * deciding.
 */
export type VerifyClient<TUser> = (
  ctx: VerifyClientContext,
) => Promise<VerifyClientResult<TUser>>;

/**
 * Signature `ws`'s `verifyClient` option (async form) expects. We build
 * this from the consumer's `VerifyClient` and pass it to `WebSocketServer`.
 *
 * `origin` is declared `string | undefined` even though `ws`'s own types
 * say `string`: at runtime `ws` populates it straight from the request's
 * Origin header, which is absent for non-browser clients. Accepting the
 * wider type here is assignability-safe (parameter contravariance) and
 * keeps the normalization (`?? ""`) honest instead of relying on a typed
 * lie.
 */
export type WsVerifyClientFn = (
  info: { origin: string | undefined; secure: boolean; req: IncomingMessage },
  callback: (
    res: boolean,
    code?: number,
    message?: string,
    headers?: Record<string, string>,
  ) => void,
) => void;

/**
 * Adapts the consumer's `VerifyClient` to `ws`'s upgrade-time verify
 * callback. Owns the WeakMap that bridges verify-time → connection-time.
 */
export class VerifyClientOrchestrator<TUser> {
  private readonly verify: VerifyClient<TUser>;
  private readonly logger: Logger;
  /**
   * WeakMap so a never-completed upgrade (network drops mid-verify, or
   * the consumer's verify throws) doesn't leak memory: the
   * IncomingMessage gets GC'd, the entry vanishes with it. The source
   * app's `(req as any).__wsAuth` monkey-patch did not benefit from
   * this — once the property was set, it lived as long as the req did.
   */
  private readonly authByReq = new WeakMap<
    IncomingMessage,
    VerifyClientResult<TUser>
  >();

  constructor(verify: VerifyClient<TUser>, logger?: Logger) {
    this.verify = verify;
    this.logger = logger ?? noopLogger;
  }

  /**
   * Returns the `ws.WebSocketServer` `verifyClient` callback. Closure
   * captures `this` — call once at composition time and hand the result
   * to `new WebSocketServer({ verifyClient: ... })`.
   *
   * On success: stores the result in the WeakMap (so
   * `getAuthForRequest(req)` returns it in the `'connection'` handler)
   * and calls `callback(true)`. On failure: calls
   * `callback(false, code, reason)` — `ws` translates this into a pre-101
   * HTTP response with the matching status, the client receives a close
   * code WITHOUT ever opening the socket.
   *
   * The "unexpected throw" branch maps to 500 + a non-revealing reason
   * — the consumer's verify shouldn't throw (the discriminated union is
   * the documented contract), but a thrown error doesn't crash the
   * server. That promise covers BOTH escape routes: an async rejection
   * AND a synchronous throw from a plain-JS non-async verify (e.g.
   * `jwt.decode` throwing on a garbage `?token=`). `ws` v8 does NOT wrap
   * its verifyClient call site, so an unguarded sync throw would escape
   * the HTTP server's `'upgrade'` emit as an uncaughtException — an
   * attacker-triggerable process crash.
   */
  buildWsVerifyClient(): WsVerifyClientFn {
    return (info, callback) => {
      const { req } = info;
      const clientIp = extractClientIp(req);
      const token = extractToken(req);
      // SEC-3: surface Origin + wss/ws to the consumer's verify so an
      // origin allowlist is possible without digging into req.headers.
      // Absent Origin header normalizes to "" (see VerifyClientContext).
      const origin = info.origin ?? "";
      const secure = info.secure;

      // Fail-closed reject, shared by the sync-throw and async-rejection
      // paths — identical wire behavior (pre-101 HTTP 500) either way.
      const failClosed = (err: unknown): void => {
        this.logger.error("verify-client: consumer verify threw", {
          error: err instanceof Error ? err.message : String(err),
          clientIp,
        });
        callback(false, 500, "Internal server error");
      };

      // The INVOCATION is guarded, not just the returned promise: only a
      // rejection reaches `.catch`, so a sync throw from an untyped
      // consumer's non-async verify would otherwise crash the process
      // (see docstring).
      let pending: Promise<VerifyClientResult<TUser>>;
      try {
        // Promise.resolve also legalizes a plain-JS verify returning the
        // result object directly (non-thenable): it's treated exactly as
        // an already-resolved promise instead of exploding on
        // `.then is not a function`. The typed contract still promises a
        // Promise (see VerifyClient); this is runtime hardening only.
        pending = Promise.resolve(
          this.verify({ req, token, clientIp, origin, secure }),
        );
      } catch (err) {
        failClosed(err);
        return;
      }

      pending
        .then((result) => {
          if (result.ok) {
            this.authByReq.set(req, result);
            callback(true);
            return;
          }
          this.logger.warn("verify-client: rejected", {
            code: result.code,
            reason: result.reason,
            clientIp,
          });
          callback(false, result.code, result.reason);
        })
        .catch(failClosed);
    };
  }

  /**
   * Retrieve the auth result attached to `req` during verify. The
   * `'connection'` handler calls this synchronously — by the time `ws`
   * fires `'connection'`, verifyClient has already populated the WeakMap.
   *
   * Returns `undefined` only if the request never went through this
   * orchestrator's verifyClient (defensive — should not happen in a
   * properly wired server).
   */
  getAuthForRequest(req: IncomingMessage): VerifyClientResult<TUser> | undefined {
    return this.authByReq.get(req);
  }
}

