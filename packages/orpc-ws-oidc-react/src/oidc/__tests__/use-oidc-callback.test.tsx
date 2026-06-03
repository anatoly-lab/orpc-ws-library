// `useOidcCallback` — hook behavior, StrictMode safety, and the empty-params
// guard. We drive the hook against a fake `OidcAuth` whose `handleCallback`
// is a `vi.fn()` returning a controllable `CallbackResult`. No real
// `createOidcAuth`, no storage, no fetch — the hook's only dependency is the
// `handleCallback` seam, so the double is tiny and deterministic.
//
// `window.location.search` controls the empty-params guard. happy-dom lets us
// rewrite it via `history.replaceState`; we reset it in `afterEach` so tests
// don't leak query strings into one another.

import { StrictMode, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";

import type { CallbackResult, OidcAuth } from "@repo/oidc-pkce";

import { useOidcCallback } from "../use-oidc-callback.js";

/** Build a fake OidcAuth exposing only `handleCallback` (the seam used). */
function makeFakeAuth(
  result: CallbackResult,
): { client: OidcAuth; handleCallback: ReturnType<typeof vi.fn> } {
  const handleCallback = vi.fn(
    (_params: URLSearchParams): Promise<CallbackResult> =>
      Promise.resolve(result),
  );
  // Only `handleCallback` is consumed by the hook; the cast keeps the double
  // minimal without re-implementing the full OidcAuth surface.
  const client = { handleCallback } as unknown as OidcAuth;
  return { client, handleCallback };
}

/** Rewrite the URL query so the guard sees the params under test. */
function setSearch(search: string): void {
  window.history.replaceState({}, "", `/auth/callback${search}`);
}

const OK_RESULT: CallbackResult = {
  ok: true,
  user: { sub: "u1", name: "Ada" },
  tokens: {
    accessToken: "a",
    refreshToken: "r",
    idToken: "i",
    expiresAt: Date.now() + 60_000,
  },
};

afterEach(() => {
  // Reset the URL so the next test starts from a clean, param-free state.
  window.history.replaceState({}, "", "/");
});

describe("useOidcCallback", () => {
  it("runs the exchange once on the success path and reports status + onSuccess", async () => {
    setSearch("?code=abc&state=xyz");
    const { client, handleCallback } = makeFakeAuth(OK_RESULT);
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOidcCallback(client, { onSuccess }),
    );

    // The async exchange resolves on a microtask; flush it inside act().
    await act(async () => {
      await Promise.resolve();
    });

    expect(handleCallback).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("success");
    expect(result.current.error).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("calls handleCallback EXACTLY ONCE under StrictMode double-mount", async () => {
    // StrictMode mounts → unmounts → re-mounts the effect in dev. The ran-ref
    // must survive that and keep the non-idempotent exchange to a single call.
    setSearch("?code=abc&state=xyz");
    const { client, handleCallback } = makeFakeAuth(OK_RESULT);

    function Probe(): null {
      useOidcCallback(client);
      return null;
    }

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(handleCallback).toHaveBeenCalledTimes(1);
  });

  it("reports the error variant and fires onError when the exchange fails", async () => {
    setSearch("?error=access_denied");
    const errorResult: CallbackResult = {
      ok: false,
      error: { type: "idp_error", error: "access_denied" },
    };
    const { client, handleCallback } = makeFakeAuth(errorResult);
    const onError = vi.fn();

    const { result } = renderHook(() => useOidcCallback(client, { onError }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(handleCallback).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toEqual({
      type: "idp_error",
      error: "access_denied",
    });
    expect(onError).toHaveBeenCalledWith({
      type: "idp_error",
      error: "access_denied",
    });
  });

  it("does NOT call handleCallback when the URL has neither code nor error (empty-params guard)", async () => {
    setSearch(""); // direct hit / refresh with no IdP result in the URL
    const { client, handleCallback } = makeFakeAuth(OK_RESULT);

    const { result } = renderHook(() => useOidcCallback(client));

    await act(async () => {
      await Promise.resolve();
    });

    expect(handleCallback).not.toHaveBeenCalled();
    expect(result.current.status).toBe("pending");
    expect(result.current.error).toBeNull();
  });

  it("surfaces the result in the rendered component", async () => {
    setSearch("?code=abc&state=xyz");
    const { client } = makeFakeAuth(OK_RESULT);

    function Probe(): ReactElement {
      const { status } = useOidcCallback(client);
      return <div data-testid="status">{status}</div>;
    }

    render(<Probe />);
    expect(screen.getByTestId("status")).toHaveTextContent("pending");

    // findByText auto-retries until the async exchange settles — robust
    // against the exact number of microtask ticks the state chain takes.
    expect(await screen.findByText("success")).toBeInTheDocument();
  });
});
