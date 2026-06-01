// Composition root.
//
// The ONE place where storage + discovery + flow + tokenProvider wire
// together. CLAUDE.md "Composition root is the only place wires meet."
//
// No module-level singletons: each call to `createOidcAuth` produces
// a fresh, self-contained `OidcAuth` object. Apps that need a single
// instance own that decision (typically one module-level
// `export const auth = createOidcAuth(config)` at the app's entry).
//
// Discovery happens lazily on the first auth-method call. The metadata
// cache itself is module-level (in `discovery.ts`), so two instances
// against the same issuerUrl share one in-flight fetch. The PER-INSTANCE
// `metadataPromise` field below is just a micro-optimization that avoids
// the `Map.get` lookup on every method call after the first; it's safe
// because metadata never invalidates within a tab.

import { type AuthSnapshot, createAuthStore } from "./auth-store.js";
import { createAuthView } from "./auth-view.js";
import { fetchMetadata } from "./discovery.js";
import {
  handleCallback as flowHandleCallback,
  logout as flowLogout,
  redirectToLogin as flowRedirectToLogin,
} from "./flow.js";
import { isTokenExpired, refreshTokens } from "./tokens.js";
import type {
  AuthStatus,
  CallbackResult,
  OidcConfig,
  OidcMetadata,
  OidcUser,
  Storage,
  TokenProvider,
  Tokens,
} from "./types.js";

/**
 * Public surface of one OIDC auth instance.
 *
 * The flow / status / clear methods are the consumer-facing dance. The
 * `tokenProvider` field is what gets plugged into `@repo/orpc-ws-client`'s
 * `createOrpcWsClient({ tokenProvider })`.
 *
 * `redirectToLogin` / `handleCallback` / `logout` are async because the
 * library awaits discovery on first use. After the first call, the
 * metadata is cached and subsequent calls are effectively sync (the
 * `await` resolves immediately).
 *
 * No mutable state visible to consumers: `getUser()` / `getAuthStatus()`
 * always re-read from Storage so a refresh-in-another-tab is visible
 * here too.
 */
export interface OidcAuth {
  redirectToLogin(): Promise<void>;
  handleCallback(searchParams: URLSearchParams): Promise<CallbackResult>;
  logout(opts?: { redirectTo?: string }): Promise<void>;

  hasToken(): boolean;
  isAccessTokenValid(): boolean;
  getAuthStatus(): AuthStatus;
  getUser(): OidcUser | null;
  clearTokens(): void;

  /**
   * Synchronous, referentially-stable snapshot of `{ status, user }`.
   *
   * The PUSH counterpart to `getAuthStatus()` / `getUser()`: same data, but
   * paired with {@link OidcAuth.subscribe} so reactive UIs can observe
   * changes. The returned object identity is stable across calls while
   * nothing changes — required by React's `useSyncExternalStore`
   * (`Object.is` snapshot bail-out). Additive; the pull methods are
   * unchanged.
   */
  getAuthState(): AuthSnapshot;
  /**
   * Register a change listener; returns an unsubscribe function. The listener
   * fires AFTER any auth-state mutation (callback, logout, clear, refresh) and
   * on cross-tab login/logout when using the default localStorage Storage.
   *
   * Does NOT fire on registration — read the current value via
   * `getAuthState()`. Stable method identity (bound once at factory time), so
   * it can be passed straight to `useSyncExternalStore` without `useCallback`.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Optional eager warmup. Fetches the discovery document into the
   * cache so the first `redirectToLogin()` doesn't pay the discovery
   * round-trip. Safe to call multiple times; subsequent calls are
   * no-ops thanks to the module-level cache.
   *
   * Recommended call site: app boot, fire-and-forget alongside
   * `if (auth.hasToken()) wsClient.connect()`.
   */
  prefetchMetadata(): Promise<void>;

  /**
   * Structurally compatible with `@repo/orpc-ws-client`'s `TokenProvider`.
   * Pass directly as the `tokenProvider` option on `createOrpcWsClient`.
   */
  tokenProvider: TokenProvider;
}

/**
 * localStorage key for the default `Storage`. Package-prefixed, not
 * IdP-prefixed. Two instances against the same origin would collide on this
 * key; the library assumes one auth instance per origin, which matches every
 * realistic SPA layout.
 *
 * SINGLE SOURCE OF TRUTH: `defaultStorage()` writes under it, and the
 * cross-tab 'storage' listener (auth-store.ts) filters window events by it.
 * Re-declaring the literal in two places would be a silent drift bug — keep
 * it here.
 */
const DEFAULT_STORAGE_KEY = "oidc.tokens";

/**
 * Default `Storage` implementation backed by `localStorage`. Tokens are
 * serialized as a single JSON blob under one key so reads/writes are
 * atomic with respect to other tabs.
 *
 * Security note: localStorage is XSS-readable. Documented in the README
 * as the SPA-friendly tradeoff. Apps with stricter requirements pass
 * their own `Storage` via `createOidcAuth(config, { storage })`.
 */
function defaultStorage(): Storage {
  const KEY = DEFAULT_STORAGE_KEY;
  return {
    read(): Tokens | null {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Tokens;
      } catch {
        // Corrupt blob — treat as no tokens. Defensive against a tab
        // that wrote a partial value during a crash; the consumer's
        // next login replaces it.
        return null;
      }
    },
    write(tokens: Tokens): void {
      localStorage.setItem(KEY, JSON.stringify(tokens));
    },
    clear(): void {
      localStorage.removeItem(KEY);
    },
  };
}

/**
 * Compose an `OidcAuth` instance. Pure function of `config` + optional
 * storage; no side effects until a method is called.
 *
 * `opts.storage` is captured ONCE here — the rest of the instance reads
 * through this single handle.
 */
export function createOidcAuth(
  config: OidcConfig,
  opts?: { storage?: Storage },
): OidcAuth {
  const usingDefaultStorage = opts?.storage === undefined;
  const storage: Storage = opts?.storage ?? defaultStorage();

  // Read-side projection of storage → `{ status, user }`. Defined once so
  // BOTH the public pull methods and the observable store read through the
  // same logic (DRY) — and so `readUser()` is referentially stable per
  // id_token (snapshot-stability contract). See auth-view.ts.
  const view = createAuthView(storage);

  // Observable seam. Cross-tab wiring is enabled ONLY on the default
  // localStorage path: a custom/in-memory Storage never produces window
  // 'storage' events, so passing its (non-existent) key would be meaningless.
  // See AuthStoreDeps.storageKey jsdoc for the full rationale.
  const authStore = createAuthStore({
    getStatus: view.readStatus,
    getUser: view.readUser,
    storageKey: usingDefaultStorage ? DEFAULT_STORAGE_KEY : null,
  });

  // Per-instance memoization of the metadata promise. The underlying
  // cache is module-level (`discovery.ts`); this field just avoids the
  // `Map.get` on every call after the first.
  let metadataPromise: Promise<OidcMetadata> | null = null;
  const getMetadata = (): Promise<OidcMetadata> => {
    if (metadataPromise) return metadataPromise;
    metadataPromise = fetchMetadata(config.issuerUrl);
    return metadataPromise;
  };

  // In-flight refresh dedupe.
  //
  // The ws-client already gates `tokenProvider.refresh()` to one call per
  // 30s, so a flood is unlikely — but the dedupe is cheap and protects
  // against the "two consumers (WS + future HTTP transport) racing each
  // other through this same provider" case. The promise is cleared in a
  // `finally` so a failed refresh doesn't poison subsequent attempts.
  //
  // No state mutation on failure: this matches the purity guarantee.
  // The `finally` clears `inflight`, but the storage write only happens
  // on the success branch of `refreshTokens()`.
  let inflight: Promise<string | null> | null = null;

  const tokenProvider: TokenProvider = {
    getToken(): string | null {
      // Deliberately DUMB: returns the stored access token AS-IS, even
      // if expired. The ws-client's reconnect flow assumes it can send
      // a stale token, observe a 1008/4001 close, and then call
      // `refresh()`. Filtering out expired tokens here would break that.
      return storage.read()?.accessToken ?? null;
    },
    refresh(): Promise<string | null> {
      if (inflight) return inflight;
      inflight = (async (): Promise<string | null> => {
        const current = storage.read();
        if (!current?.refreshToken) return null;
        let metadata: OidcMetadata;
        try {
          metadata = await getMetadata();
        } catch {
          // Discovery failed — treat as transient refresh failure.
          // The ws-client's storm guard handles the fallout.
          return null;
        }
        const fresh = await refreshTokens({
          metadata,
          clientId: config.clientId,
          prior: current,
        });
        if (!fresh) return null;
        // Success branch: write through. Without this, `getToken()`
        // would keep returning the stale token forever and the
        // ws-client would never recover.
        storage.write(fresh);
        // A refresh swaps the access token (and possibly the id-token, hence
        // the user). Notify so reactive UIs see e.g. `expired` → `authenticated`.
        authStore.emit();
        return fresh.accessToken;
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };

  return {
    async redirectToLogin(): Promise<void> {
      const metadata = await getMetadata();
      await flowRedirectToLogin(config, metadata);
    },
    async handleCallback(
      searchParams: URLSearchParams,
    ): Promise<CallbackResult> {
      // Discovery failure at callback time would otherwise produce an
      // unhandled rejection in the consumer's effect (the original
      // keycloak-browser handleCallback was never-throw). Map to the
      // existing `exchange_failed/0` variant — semantically "couldn't
      // reach the exchange" — so the consumer's switch still covers it.
      let metadata: OidcMetadata;
      try {
        metadata = await getMetadata();
      } catch (e) {
        return {
          ok: false,
          error: {
            type: "exchange_failed",
            status: 0,
            body: e instanceof Error ? e.message : String(e),
          },
        };
      }
      const result = await flowHandleCallback(
        searchParams,
        config,
        metadata,
        storage,
      );
      // Emit unconditionally: on `ok:true` the token write changed state; on
      // `ok:false` nothing was written, and the store's value-compare guard
      // turns the emit into a no-op (no spurious re-render). Unconditional +
      // dedup is fewer branches to get wrong than gating on `result.ok`.
      authStore.emit();
      return result;
    },
    async logout(logoutOpts?: { redirectTo?: string }): Promise<void> {
      // Best-effort: if discovery fails, still clear local tokens so the
      // user isn't stranded "logged in" against a dead IdP. We synthesize
      // a metadata blob with no end_session_endpoint so flow.logout()
      // takes the local-clear-only branch.
      let metadata: OidcMetadata;
      try {
        metadata = await getMetadata();
      } catch {
        metadata = {
          issuer: config.issuerUrl,
          authorization_endpoint: "",
          token_endpoint: "",
          jwks_uri: "",
        };
      }
      // `flowLogout` clears storage (and may navigate away). Emit so any
      // still-mounted reactive UI flips to `anonymous` before navigation.
      flowLogout(config, metadata, storage, logoutOpts);
      authStore.emit();
    },

    hasToken(): boolean {
      return storage.read() !== null;
    },
    isAccessTokenValid(): boolean {
      const t = storage.read();
      return t !== null && !isTokenExpired(t);
    },
    getAuthStatus(): AuthStatus {
      return view.readStatus();
    },
    getUser(): OidcUser | null {
      return view.readUser();
    },
    clearTokens(): void {
      storage.clear();
      authStore.emit();
    },

    getAuthState: authStore.getAuthState,
    subscribe: authStore.subscribe,

    async prefetchMetadata(): Promise<void> {
      await getMetadata();
    },

    tokenProvider,
  };
}
