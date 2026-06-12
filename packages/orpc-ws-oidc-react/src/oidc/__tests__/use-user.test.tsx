import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { OidcAuth } from "@orpc-ws/oidc-pkce";

import { useUser } from "../use-user.js";
import { ANON, authed, makeFakeAuth } from "./fake-auth.js";

describe("useUser", () => {
  it("returns null when anonymous", () => {
    const fake = makeFakeAuth(ANON);
    const { result } = renderHook(() => useUser(fake.client as OidcAuth));
    expect(result.current).toBeNull();
  });

  it("returns the user and re-renders on login", () => {
    const fake = makeFakeAuth(ANON);
    const { result } = renderHook(() => useUser(fake.client as OidcAuth));
    expect(result.current).toBeNull();

    act(() => {
      fake.set(authed({ sub: "u1", name: "Ada" }));
    });
    expect(result.current).toEqual({ sub: "u1", name: "Ada" });
  });

  it("returns the SAME user identity the snapshot holds (no wrapper)", () => {
    const user = { sub: "u1", name: "Ada" };
    const fake = makeFakeAuth(authed(user));
    const { result } = renderHook(() => useUser(fake.client as OidcAuth));
    // Identity, not just value — the hook must not allocate a new object.
    expect(result.current).toBe(user);
  });
});
