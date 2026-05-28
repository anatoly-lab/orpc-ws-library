// Shared vitest base config. Per-package configs extend / override this.
//
// Why a base config:
//   - Test discipline lives in one place (fake timers, common matchers,
//     coverage shape) so packages can't drift apart.
//   - Packages that need DOM globals (e.g. client + React adapter) override
//     `environment` to `"happy-dom"`.

import { defineConfig } from "vitest/config";

export const baseConfig = defineConfig({
  test: {
    // Node environment by default. Browser-ish packages override to happy-dom.
    environment: "node",

    // Discover *.test.ts and __tests__/**/*.test.ts only.
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],

    // Fake timers are opt-in per-test (we don't want every test paying for
    // them), but we make the choice deterministic by setting the default.
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
      ],
    },

    // Don't pollute test runs with watch mode in CI.
    watch: false,

    // Show failures fast.
    reporters: ["default"],

    // Coverage: opt-in via `--coverage`; this just standardizes the shape.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__tests__/**",
        "src/**/index.ts",
      ],
    },
  },
});

export default baseConfig;
