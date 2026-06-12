// Tests for <RequireAuth> — the auth gate component.
//
// Exercised against the same fake OidcAuth seam the hooks use (getAuthState +
// subscribe + redirectToLogin), so these test the adapter, not the core. The
// load-bearing case is the predicate: `expired` MUST still render children
// (token present), proving the gate is `!== "anonymous"`, not
// `=== "authenticated"`.

import type { AuthSnapshot, OidcAuth } from "@orpc-ws/oidc-pkce";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { RequireAuth } from "../require-auth.js";
import { ANON, authed, makeFakeAuth } from "./fake-auth.js";

const EXPIRED: AuthSnapshot = {
  status: "expired",
  user: { sub: "u1", name: "Ada" },
};

describe("RequireAuth", () => {
  it("renders children when status is authenticated", () => {
    const fake = makeFakeAuth(authed({ sub: "u1", name: "Ada" }));
    render(
      <RequireAuth client={fake.client as OidcAuth} fallback={<p>fallback</p>}>
        <p data-testid="protected">secret</p>
      </RequireAuth>,
    );
    expect(screen.getByTestId("protected")).toBeInTheDocument();
    expect(screen.queryByText("fallback")).not.toBeInTheDocument();
  });

  it("renders children when status is expired (predicate is !== anonymous, not === authenticated)", () => {
    const fake = makeFakeAuth(EXPIRED);
    render(
      <RequireAuth client={fake.client as OidcAuth} fallback={<p>fallback</p>}>
        <p data-testid="protected">secret</p>
      </RequireAuth>,
    );
    // An expired token must still render protected content so the WS
    // reconnect+refresh recovery can run — the whole point of the predicate.
    expect(screen.getByTestId("protected")).toBeInTheDocument();
    expect(screen.queryByText("fallback")).not.toBeInTheDocument();
  });

  it("renders the supplied fallback when status is anonymous", () => {
    const fake = makeFakeAuth(ANON);
    render(
      <RequireAuth
        client={fake.client as OidcAuth}
        fallback={<p data-testid="my-fallback">sign in here</p>}
      >
        <p data-testid="protected">secret</p>
      </RequireAuth>,
    );
    expect(screen.getByTestId("my-fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("protected")).not.toBeInTheDocument();
  });

  it("renders the default fallback (with a sign-in button) when none is supplied", () => {
    const fake = makeFakeAuth(ANON);
    render(
      <RequireAuth client={fake.client as OidcAuth}>
        <p data-testid="protected">secret</p>
      </RequireAuth>,
    );
    const button = screen.getByTestId("orpc-ws-oidc-signin");
    expect(button).toBeInTheDocument();
    expect(screen.queryByTestId("protected")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(fake.redirectToLogin).toHaveBeenCalledTimes(1);
  });

  it("re-renders reactively across an anonymous → authenticated transition", () => {
    const fake = makeFakeAuth(ANON);
    render(
      <RequireAuth
        client={fake.client as OidcAuth}
        fallback={<p data-testid="my-fallback">sign in</p>}
      >
        <p data-testid="protected">secret</p>
      </RequireAuth>,
    );
    expect(screen.getByTestId("my-fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("protected")).not.toBeInTheDocument();

    act(() => {
      fake.set(authed({ sub: "u1", name: "Ada" }));
    });
    expect(screen.getByTestId("protected")).toBeInTheDocument();
    expect(screen.queryByTestId("my-fallback")).not.toBeInTheDocument();
  });
});
