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
});
