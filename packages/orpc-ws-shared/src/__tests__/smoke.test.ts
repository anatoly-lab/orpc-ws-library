import { describe, expect, it } from "vitest";

import {
  defaultRng,
  noopLogger,
  systemClock,
} from "../index.js";

describe("@orpc-ws/shared smoke", () => {
  it("exports a noop logger that accepts the structured-args shape", () => {
    expect(() => {
      noopLogger.debug("d", { k: 1 });
      noopLogger.info("i", { k: 1 });
      noopLogger.warn("w", { k: 1 });
      noopLogger.error("e", { k: 1 });
    }).not.toThrow();
  });

  it("exports a system clock with the expected shape", () => {
    expect(typeof systemClock.now()).toBe("number");
    expect(typeof systemClock.setTimeout).toBe("function");
    expect(typeof systemClock.clearTimeout).toBe("function");
    expect(typeof systemClock.setInterval).toBe("function");
    expect(typeof systemClock.clearInterval).toBe("function");
  });

  it("exports a default RNG returning [0, 1)", () => {
    const v = defaultRng.next();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});
