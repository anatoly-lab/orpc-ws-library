import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../vitest.config.base.ts";

// Node-level cross-package e2e (server↔client round-trip). Unlike the Playwright
// suite (`test:e2e`, Docker/Keycloak), this runs under plain vitest as part of
// the normal `pnpm test` pass — it only needs loopback TCP and Node's native
// global WebSocket (Node 22), which partysocket picks up automatically.
//
// `node` environment (NOT happy-dom): the client's transport resolves the global
// `WebSocket`, and Node 22's native (undici) implementation does genuine
// full-duplex with the `ws` server — the right tool for asserting server→client
// frames actually arrive. The base config is node-env already; we only narrow the
// discovery glob to this package's `tests/` dir and widen the timeout to cover
// real network + reconnect delays (the in-test bounded `waitUntil`s are what fail
// fast, not an outer vitest timeout).
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@repo/tests-e2e (node round-trip)",
      environment: "node",
      include: ["tests/**/*.test.ts"],
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  }),
);
