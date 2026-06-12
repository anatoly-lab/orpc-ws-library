// `<OidcCallback>` — the react-router sub-path component. We render it inside
// a real `<MemoryRouter>` and assert the three observable states: the fallback
// while pending, the `renderError` output on failure, and a real navigation
// (the landing route appears) on success.
//
// Same fake-OidcAuth strategy as the hook test: `handleCallback` is a
// controllable `vi.fn()`. The URL query is set via `history.replaceState`
// because `useOidcCallback` reads `window.location.search` (MemoryRouter's
// in-memory location does NOT drive that read). Reset in `afterEach`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { CallbackResult, OidcAuth } from "@orpc-ws/oidc-pkce";

import { OidcCallback } from "../oidc-callback.js";

function makeFakeAuth(result: CallbackResult): OidcAuth {
  const handleCallback = vi.fn(
    (_p: URLSearchParams): Promise<CallbackResult> => Promise.resolve(result),
  );
  return { handleCallback } as unknown as OidcAuth;
}

function setSearch(search: string): void {
  window.history.replaceState({}, "", `/auth/callback${search}`);
}

const OK_RESULT: CallbackResult = {
  ok: true,
  user: { sub: "u1" },
  tokens: {
    accessToken: "a",
    refreshToken: "r",
    idToken: "i",
    expiresAt: Date.now() + 60_000,
  },
};

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("OidcCallback", () => {
  it("renders the fallback while pending", () => {
    setSearch("?code=abc&state=xyz");
    const client = makeFakeAuth(OK_RESULT);

    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <Routes>
          <Route
            path="/auth/callback"
            element={
              <OidcCallback client={client} fallback={<p>Loading…</p>} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders renderError output on failure", async () => {
    setSearch("?error=access_denied");
    const client = makeFakeAuth({
      ok: false,
      error: { type: "idp_error", error: "access_denied" },
    });

    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <Routes>
          <Route
            path="/auth/callback"
            element={
              <OidcCallback
                client={client}
                renderError={(e) => (
                  <div data-testid="err">{e.type}</div>
                )}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    // findByTestId auto-retries until the failed exchange settles.
    expect(await screen.findByTestId("err")).toHaveTextContent("idp_error");
  });

  it("navigates to navigateTo on success (landing route renders)", async () => {
    setSearch("?code=abc&state=xyz");
    const client = makeFakeAuth(OK_RESULT);

    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <Routes>
          <Route path="/" element={<div data-testid="home">Home</div>} />
          <Route
            path="/auth/callback"
            element={<OidcCallback client={client} navigateTo="/" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    // onSuccess → navigate("/", { replace: true }) → the home route mounts.
    // findByTestId auto-retries until that navigation completes.
    expect(await screen.findByTestId("home")).toBeInTheDocument();
  });
});
