// Phase 3.2 — router composer tests.
//
// The composer is the eager collision check that makes the stealth
// pattern safe. Three behaviors pinned:
//
//   1. Composes a plain consumer router with the system fragment —
//      both top-level keys present on the result.
//   2. Throws synchronously if the consumer's router has the reserved
//      namespace. The throw is INSIDE composeRouter; the
//      `OrpcWsServer` constructor calls it eagerly.
//   3. HEARTBEAT_PATH is reachable post-compose (the stealth wire
//      address actually resolves through the composed object).

import { describe, expect, it } from "vitest";

import { HEARTBEAT_NAMESPACE, HEARTBEAT_PATH } from "@orpc-ws/shared";

import { composeRouter } from "../router-composer.js";

describe("composeRouter", () => {
  it("returns an object containing both the consumer and system keys", () => {
    const consumer = {
      users: { me: () => "me-handler" as unknown },
      tunnel: { getStatus: () => "status-handler" as unknown },
    };
    const system = {
      [HEARTBEAT_NAMESPACE]: { heartbeat: () => "hb-handler" as unknown },
    };

    const composed = composeRouter(consumer, system);

    expect("users" in composed).toBe(true);
    expect("tunnel" in composed).toBe(true);
    expect(HEARTBEAT_NAMESPACE in composed).toBe(true);
  });

  it("throws when the consumer router uses the reserved namespace", () => {
    const consumer = {
      [HEARTBEAT_NAMESPACE]: { something: () => undefined },
      other: {},
    };
    const system = {
      [HEARTBEAT_NAMESPACE]: { heartbeat: () => undefined },
    };

    expect(() => composeRouter(consumer, system)).toThrow(
      /reserved library namespace/i,
    );
  });

  it("the system router is reachable via the literal HEARTBEAT_PATH on the composed object", () => {
    const heartbeatHandler = (): string => "live";
    const consumer = { app: { ping: () => "pong" } };
    const system = {
      [HEARTBEAT_NAMESPACE]: { heartbeat: heartbeatHandler },
    };

    const composed = composeRouter(consumer, system) as Record<
      string,
      Record<string, unknown>
    >;

    // Walk by HEARTBEAT_PATH to mirror the wire's tuple lookup.
    const [ns, proc] = HEARTBEAT_PATH;
    const namespaceFragment = composed[ns];
    expect(namespaceFragment).toBeDefined();
    expect(namespaceFragment?.[proc]).toBe(heartbeatHandler);
  });

  it("preserves the consumer's nested structure unchanged", () => {
    const meHandler = (): string => "me";
    const consumer = {
      users: {
        me: meHandler,
        list: () => [],
      },
    };
    const system = { [HEARTBEAT_NAMESPACE]: {} };

    const composed = composeRouter(consumer, system) as {
      users: { me: () => string; list: () => unknown[] };
    };

    expect(composed.users.me).toBe(meHandler);
    expect(composed.users.list()).toEqual([]);
  });
});
