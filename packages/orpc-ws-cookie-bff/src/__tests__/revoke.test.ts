import { noopLogger } from "@orpc-ws/shared";
import { describe, expect, it, vi } from "vitest";

import { revokeUser } from "../revoke.js";
import type { SessionData } from "../session-store.js";
import { FakeSessionStore } from "./fakes.js";

type User = { id: string };

describe("revokeUser", () => {
  it("deletes every session for the subject AND closes the live socket", async () => {
    const store = new FakeSessionStore<User>();
    const session: SessionData<User> = {
      sub: "user-1",
      user: { id: "db-1" },
      csrfToken: "csrf-x",
      enc: { accessToken: "x", refreshToken: null, idToken: null },
      accessTokenExpiresAt: 0,
      sessionExpiresAt: 0,
      createdAt: 0,
    };
    store.map.set("sid-a", session);
    store.map.set("sid-b", session);

    const closeUser = vi.fn();
    await revokeUser(store, closeUser, "user-1");

    expect(store.deletedByUser).toEqual(["user-1"]);
    expect(store.map.size).toBe(0);
    expect(closeUser).toHaveBeenCalledWith(
      "user-1",
      4001,
      "session invalidated",
    );
  });

  it("deletes before closing (store delete awaited first)", async () => {
    const store = new FakeSessionStore<User>();
    const order: string[] = [];
    const origDelete = store.deleteByUser.bind(store);
    store.deleteByUser = async (sub) => {
      order.push("delete");
      await origDelete(sub);
    };
    const closeUser = vi.fn(() => {
      order.push("close");
    });
    await revokeUser(store, closeUser, "user-1");
    expect(order).toEqual(["delete", "close"]);
  });

  it("STILL kicks the live socket when the store delete rejects (would fail pre-fix)", async () => {
    // A store outage must not leave a just-revoked user's authenticated
    // socket up — the kick is the more urgent of the two actions and is
    // guaranteed via `finally`.
    const store = new FakeSessionStore<User>();
    store.deleteByUser = async () => {
      throw new Error("store down");
    };
    const closeUser = vi.fn();

    await expect(revokeUser(store, closeUser, "user-1")).rejects.toThrow(
      "store down",
    );
    expect(closeUser).toHaveBeenCalledWith(
      "user-1",
      4001,
      "session invalidated",
    );
  });

  it("propagates the delete failure AFTER the kick (caller can retry/redeliver)", async () => {
    // Chosen semantics: "best-effort" covers the local kick, not a swallowed
    // store outage. `CookieBffService.revokeUser` awaits + propagates, so the
    // consumer's revocation-event handler sees the rejection and can retry —
    // otherwise the sessions would silently survive until their TTL.
    const store = new FakeSessionStore<User>();
    const order: string[] = [];
    store.deleteByUser = async () => {
      order.push("delete-throw");
      throw new Error("store down");
    };
    const closeUser = vi.fn(() => {
      order.push("close");
    });

    await expect(revokeUser(store, closeUser, "user-1")).rejects.toThrow();
    expect(order).toEqual(["delete-throw", "close"]);
  });

  it("a throwing closeUser does NOT mask the delete rejection — the DELETE failure propagates, the kick failure is logged", async () => {
    // JS finally-throw semantics: a throw escaping the `finally` would
    // REPLACE the in-flight deleteByUser rejection. The kick is therefore
    // guarded by its own try/catch — the store outage is what the caller's
    // retry/redeliver logic needs to see, and the kick failure (a
    // consumer-supplied CloseUser; the library core's never throws) is
    // logged via the injected Logger.
    const store = new FakeSessionStore<User>();
    store.deleteByUser = async () => {
      throw new Error("store down");
    };
    const closeUser = vi.fn(() => {
      throw new Error("closeUser blew up");
    });
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };

    await expect(
      revokeUser(store, closeUser, "user-1", logger),
    ).rejects.toThrow("store down"); // NOT "closeUser blew up"
    expect(closeUser).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[cookie-bff] revocation kick (closeUser) failed",
      { reason: "closeUser blew up" },
    );
  });
});
