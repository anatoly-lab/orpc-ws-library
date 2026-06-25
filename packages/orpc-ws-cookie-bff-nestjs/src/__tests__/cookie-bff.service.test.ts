// `CookieBffService.revokeUser` — the best-effort kick wires BOTH the store's
// deleteByUser AND the WS server's closeUser. Constructed directly with fakes
// (no full DI needed for this unit).

import { describe, expect, it, vi } from "vitest";

import { CookieBffService } from "../cookie-bff.service.js";
import { FakeSessionStore, liveSession } from "./fakes.js";
import type { CookieBffModuleOptions } from "../cookie-bff.options.js";

describe("CookieBffService.revokeUser", () => {
  it("deletes every session for the subject AND closes its live socket", async () => {
    const store = new FakeSessionStore();
    store.map.set("sid-1", liveSession("kc-1"));

    const closeUser = vi.fn();
    const fakeOrpcWs = { closeUser } as unknown as Parameters<
      typeof makeService
    >[2];

    const svc = makeService(store, closeUser, fakeOrpcWs);
    await svc.revokeUser("kc-1");

    expect(store.deletedByUser).toEqual(["kc-1"]);
    expect(store.map.has("sid-1")).toBe(false);
    expect(closeUser).toHaveBeenCalledWith(
      "kc-1",
      4001,
      "session invalidated",
    );
  });

  it("closeUser pass-through delegates to the WS service", () => {
    const store = new FakeSessionStore();
    const closeUser = vi.fn();
    const fakeOrpcWs = { closeUser } as never;
    const svc = makeService(store, closeUser, fakeOrpcWs);

    svc.closeUser("kc-9", 4005, "replaced");
    expect(closeUser).toHaveBeenCalledWith("kc-9", 4005, "replaced");
  });

  it("getCore returns the injected core", () => {
    const store = new FakeSessionStore();
    const core = { login: vi.fn() } as never;
    const svc = new CookieBffService(
      { sessionStore: store } as CookieBffModuleOptions,
      core,
      { closeUser: vi.fn() } as never,
    );
    expect(svc.getCore()).toBe(core);
  });
});

function makeService(
  store: FakeSessionStore,
  _closeUser: ReturnType<typeof vi.fn>,
  orpcWs: never,
): CookieBffService {
  return new CookieBffService(
    { sessionStore: store } as CookieBffModuleOptions,
    { login: vi.fn() } as never,
    orpcWs,
  );
}
