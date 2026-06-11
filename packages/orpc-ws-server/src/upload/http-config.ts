// HTTP upload transport config.
//
// Phase 6 — opt-in HTTP transport.
//
// The library's primary transport is the WebSocket; this config governs
// the *secondary* HTTP transport, which exists only to carry file uploads
// (ORPC's native multipart support over HTTP). When `enabled: false`
// (the default), no HTTP handler is built and `OrpcWsServer.getHttpHandler()`
// returns `null`.
//
// CLAUDE.md "Library scope" pins this as opt-in: no HTTP transport,
// no HTTP route registration, no Express dependency in the core. The
// NestJS adapter (Phase 5) is the one that mounts the handler onto an
// Express app at `OnApplicationBootstrap`; consumers using the bare core
// from Node mount it themselves via `getHttpHandler()`.

import type { IncomingHttpHeaders, IncomingMessage } from "http";

/**
 * Argument the library passes to the consumer's `beforeUpload` hook.
 *
 * Deliberately the *header*-and-*user* view, NOT the body: the hook runs
 * BEFORE the request body is read/buffered (that's the whole point — let
 * the consumer reject a wrong-`content-type` / oversized upload without
 * ever pulling the bytes off the socket). The file body is therefore not
 * — and cannot be — passed here.
 *
 * Mirrors `VerifyClientContext` (raw `req` escape hatch + the bits the
 * common path needs lifted out): `headers` is the documented primary
 * lever (`content-type`, `content-length`), `user` is the authenticated
 * principal `verifyClient` already resolved, and `req` is the same
 * escape hatch the WS verifier exposes.
 */
export interface BeforeUploadContext<TUser> {
  /**
   * Parsed request headers. The documented primary input — read
   * `headers["content-type"]` / `headers["content-length"]` to gate the
   * upload by media type or declared size before the body is buffered.
   */
  headers: IncomingHttpHeaders;
  /**
   * The authenticated user `verifyClient` returned. `beforeUpload` runs
   * AFTER `verifyClient` succeeds, so the principal is always present —
   * the hook can apply per-user upload policy (quota, plan tier, etc.).
   */
  user: TUser;
  /** The raw upload request. Escape hatch for anything not on `headers`. */
  req: IncomingMessage;
}

/**
 * Discriminated-union result from the consumer's `beforeUpload`.
 *
 * Mirrors `VerifyClientResult`'s accept/reject convention rather than
 * inventing a divergent one (thrown-exception or boolean): `{ ok: true }`
 * lets the upload proceed to the RPC handler, `{ ok: false, ... }` rejects
 * it with an HTTP error and the RPC handler is never invoked.
 *
 * The ONE justified divergence from `VerifyClientResult`: `code` and
 * `reason` are OPTIONAL here. `verifyClient` rejection is always "auth
 * failed → 401-ish", so it requires an explicit code; an upload rejection
 * has a sensible REST default (415 Unsupported Media Type — the canonical
 * status for a content-type the endpoint won't accept), so the common
 * "reject by content-type" case needs no boilerplate. Consumers rejecting
 * for size supply `code: 413` (Payload Too Large) themselves.
 */
export type BeforeUploadResult =
  | { ok: true }
  | { ok: false; code?: number; reason?: string };

/**
 * Optional pre-body-buffer upload gate.
 *
 * Runs AFTER `verifyClient` succeeds (so it sees the authenticated
 * `user`) and BEFORE the request body is read by ORPC's RPC handler.
 * Async by contract — return a value or a Promise — because real policy
 * checks (per-user quota lookups, etc.) need an external call.
 *
 * Why a dedicated hook instead of overloading `verifyClient`: the WS
 * `verifyClient` is auth, runs pre-101 on the upgrade request, and never
 * learns it's gating an upload. Upload-specific gating (content-type,
 * declared size, per-user upload policy) is a separate concern; folding
 * it into `verifyClient` would couple two unrelated levers and force the
 * WS auth path to reason about HTTP upload headers it never sees.
 */
export type BeforeUploadHook<TUser> = (
  ctx: BeforeUploadContext<TUser>,
) => BeforeUploadResult | Promise<BeforeUploadResult>;

/**
 * Default HTTP status when `beforeUpload` rejects without an explicit
 * `code`. 415 Unsupported Media Type — the canonical REST status for "the
 * endpoint refuses this request's content-type", which is the dominant
 * reason a consumer rejects pre-body. Size rejections use 413; the hook
 * supplies that code itself.
 */
export const DEFAULT_BEFORE_UPLOAD_REJECT_CODE = 415;

/** Default reason paired with {@link DEFAULT_BEFORE_UPLOAD_REJECT_CODE}. */
export const DEFAULT_BEFORE_UPLOAD_REJECT_REASON = "Unsupported Media Type";

/**
 * Default request-body cap when uploads are enabled — 100 MB (SEC-4).
 *
 * Secure-by-default posture: before this constant existed, enabling
 * uploads without an explicit `bodyLimitBytes` accepted UNBOUNDED bodies
 * (a resource-exhaustion vector). 100 MB is generous enough not to break
 * typical file uploads while still bounding a trivial DoS; consumers
 * with bigger payloads raise the limit deliberately.
 */
export const DEFAULT_UPLOAD_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * Configuration for the HTTP upload transport.
 *
 * Defaults are conservative: disabled, root path `/upload`, body limit
 * 100 MB ({@link DEFAULT_UPLOAD_BODY_LIMIT_BYTES}). ORPC's HTTP path has
 * no implicit ceiling of its own, so the library ships the bound — see
 * SEC-4 in docs/fable/security-review.md.
 *
 * Generic over `TUser` so `beforeUpload` receives the same typed
 * principal the server core threads through `OrpcWsServerOptions<TUser>`
 * / `verifyClient`. When uploads are unused the parameter erases to the
 * core's `TUser` default with no consumer-visible cost.
 */
export interface UploadHttpConfig<TUser = unknown> {
  /**
   * Master switch. When `false` (default), `OrpcWsServer.getHttpHandler()`
   * returns `null` and no HTTP infrastructure is built.
   */
  enabled: boolean;
  /**
   * Path prefix the HTTP `RPCHandler` matches. The composed router's
   * keys (e.g. `media.upload`) resolve under this prefix; a procedure
   * at `media.upload` is reachable at `${httpPath}/media/upload`.
   *
   * Default `/upload`. Match the NestJS adapter's `httpPath` registration
   * exactly; mismatched paths surface as 404s with no clear diagnostic.
   */
  httpPath: string;
  /**
   * Cap on request body size in bytes, applied by ORPC's
   * `BodyLimitPlugin`. Defaults to 100 MB
   * ({@link DEFAULT_UPLOAD_BODY_LIMIT_BYTES}) — uploads larger than the
   * limit are rejected (SEC-4: secure by default; raise deliberately).
   *
   * Only a **number** override is honored: passing an explicit
   * `undefined` does NOT disable the cap — the default applies whenever
   * no number is given, so the unbounded-body posture is unreachable by
   * accident. To effectively disable the cap, set a very large value
   * (e.g. `Number.MAX_SAFE_INTEGER`). The consumer's HTTP framework may
   * still apply its own, tighter limit.
   */
  bodyLimitBytes?: number;
  /**
   * Optional pre-body-buffer upload gate. See {@link BeforeUploadHook}.
   *
   * When absent (the default), uploads are NOT gated — behavior is
   * byte-for-byte identical to before this hook existed. Never accidentally
   * blocks an upload when unset; the handler skips the call entirely.
   */
  beforeUpload?: BeforeUploadHook<TUser>;
}

/**
 * Defaults. Disabled, `/upload`, 100 MB body limit, no `beforeUpload`
 * gate. Consumers opt in by setting `enabled: true` in
 * `OrpcWsServerOptions.uploads`.
 *
 * Typed via `satisfies` (NOT an explicit `UploadHttpConfig<...>`
 * annotation) so the inferred const type carries only the keys present
 * here — `beforeUpload` is deliberately absent. This sidesteps the
 * function-parameter contravariance wall: were `beforeUpload` part of the
 * default's type, merging `{...DEFAULT, ...opts.uploads}` for an arbitrary
 * `TUser` would not type-check (a `(ctx: { user: unknown }) => ...` default
 * is not assignable where `(ctx: { user: TUser }) => ...` is expected).
 * With `satisfies`, the merged result's `beforeUpload` flows purely from
 * `opts.uploads: Partial<UploadHttpConfig<TUser>>` and stays correctly
 * typed.
 */
export const DEFAULT_UPLOAD_HTTP_CONFIG = {
  enabled: false,
  httpPath: "/upload",
  bodyLimitBytes: DEFAULT_UPLOAD_BODY_LIMIT_BYTES,
} satisfies UploadHttpConfig<unknown>;
