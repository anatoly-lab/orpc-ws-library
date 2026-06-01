import { describe, expect, it } from "vitest";
import { act, render, renderHook } from "@testing-library/react";

import type { OidcAuth } from "@repo/oidc-pkce";

import { useAuthState } from "../use-auth-state.js";
import { ANON, authed, makeFakeAuth } from "./fake-auth.js";

describe("useAuthState", () => {
  it("returns the client's current snapshot on first render", () => {
    const fake = makeFakeAuth(authed({ sub: "u1", name: "Ada" }));
    const { result } = renderHook(() =>
      useAuthState(fake.client as OidcAuth),
    );
    expect(result.current.status).toBe("authenticated");
    expect(result.current.user).toEqual({ sub: "u1", name: "Ada" });
  });

  it("re-renders when the snapshot changes via emit", () => {
    const fake = makeFakeAuth(ANON);
    const { result } = renderHook(() =>
      useAuthState(fake.client as OidcAuth),
    );
    expect(result.current.status).toBe("anonymous");

    act(() => {
      fake.set(authed({ sub: "u1", name: "Ada" }));
    });
    expect(result.current.status).toBe("authenticated");
    expect(result.current.user?.name).toBe("Ada");
  });

  it("does NOT re-render (no loop) when emit fires with an identical snapshot", () => {
    const fake = makeFakeAuth(authed({ sub: "u1", name: "Ada" }));

    let renders = 0;
    function Probe(): null {
      useAuthState(fake.client as OidcAuth);
      renders += 1;
      return null;
    }
    render(<Probe />);
    const baseline = renders;

    // A no-op emit keeps the SAME snapshot identity. useSyncExternalStore's
    // Object.is bail-out must suppress the re-render — the #1 stable-snapshot
    // foot-gun this whole seam exists to avoid.
    act(() => {
      fake.emit();
      fake.emit();
      fake.emit();
    });
    expect(renders).toBe(baseline);
  });

  it("unsubscribes on unmount", () => {
    const fake = makeFakeAuth(ANON);
    const { unmount } = renderHook(() =>
      useAuthState(fake.client as OidcAuth),
    );
    expect(fake.listenerCount()).toBe(1);
    unmount();
    expect(fake.listenerCount()).toBe(0);
  });
});
