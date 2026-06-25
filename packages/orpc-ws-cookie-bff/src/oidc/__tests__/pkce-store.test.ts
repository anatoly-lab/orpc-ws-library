import { describe, expect, it } from "vitest";

import { InMemoryPkceStore } from "../pkce-store.js";
import { fakeClock } from "../../__tests__/fakes.js";

describe("InMemoryPkceStore", () => {
  it("returns the verifier exactly once (single-use)", async () => {
    const store = new InMemoryPkceStore(fakeClock());
    await store.set("state-1", "verifier-1", { ttlSeconds: 600 });
    expect(await store.take("state-1")).toBe("verifier-1");
    expect(await store.take("state-1")).toBeNull(); // consumed
  });

  it("treats an expired entry as absent (injected clock)", async () => {
    const clock = fakeClock();
    const store = new InMemoryPkceStore(clock);
    await store.set("state-1", "v", { ttlSeconds: 600 });
    clock.advance(600 * 1000 + 1);
    expect(await store.take("state-1")).toBeNull();
  });

  it("returns null for an unknown state", async () => {
    const store = new InMemoryPkceStore(fakeClock());
    expect(await store.take("nope")).toBeNull();
  });
});
