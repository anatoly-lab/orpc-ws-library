// Flat ESLint config (ESLint 9+).
//
// Enforces the "framework-free core" discipline from CLAUDE.md:
//   - packages/orpc-ws-client/src       — no react/vue/svelte/solid/nest imports
//   - packages/orpc-ws-client/src/react — react allowed, but core internals
//                                          accessed via public surface only
//   - packages/orpc-ws-server/src       — no nest/express/fastify imports
//   - packages/orpc-ws-server-nestjs/src — nest allowed (it's the adapter)
//
// Note: the implementation-plan.md showed the legacy .eslintrc shape with
// `from: ["node_modules/react", ...]` for `import/no-restricted-paths`.
// That worked in legacy config because zone `from` was matched against
// resolved paths. In flat config it's cleaner and more correct to combine
// path-scoped zones (`no-restricted-paths`) for *intra-repo* boundaries
// with `no-restricted-imports` for *npm-package* blocking. Same effect,
// idiomatic for flat config.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

/** Framework packages forbidden in the framework-free client core. */
const CLIENT_CORE_FORBIDDEN_PACKAGES = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "solid-js",
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "reflect-metadata",
];

/** Framework packages forbidden in the framework-free server core. */
const SERVER_CORE_FORBIDDEN_PACKAGES = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "express",
  "fastify",
  "reflect-metadata",
];

const restrictedImportRule = (patterns, message) => [
  "error",
  {
    paths: patterns.map((name) => ({ name, message })),
    patterns: patterns.map((name) => ({
      group: [`${name}/*`],
      message,
    })),
  },
];

export default tseslint.config(
  {
    // Global ignores.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      // Playwright outputs live in tests-e2e but aren't gitignored.
      // Linting their bundled trace/HTML JS produces hundreds of
      // false-positive errors; exclude both.
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Baseline for every TS source file in the repo.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
      // Note: not using `projectService`. None of the enabled rules need
      // type information; turning it on requires every file (incl. tests
      // excluded from per-package tsconfig.json) to be in some TS project,
      // which is friction. Re-add only if a type-aware rule lands.
    },
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["packages/*/tsconfig.json"],
        },
        node: true,
      },
    },
    rules: {
      // SOLID / typing discipline.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Catches phantom imports (CLAUDE.md "Lint compensation for
      // npm-workspaces' looser strictness").
      "import/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/*.spec.ts",
            "**/__tests__/**",
            "**/vitest.config.*",
            "**/eslint.config.*",
          ],
        },
      ],

      // Forbid console.* in library code (CLAUDE.md: "Zero console.log").
      "no-console": "error",
    },
  },

  // ---- Client core: framework-free ----
  {
    files: ["packages/orpc-ws-client/src/**/*.{ts,tsx}"],
    ignores: ["packages/orpc-ws-client/src/react/**"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        CLIENT_CORE_FORBIDDEN_PACKAGES,
        "Client core must remain framework-free; framework code lives in adapters (src/react/, etc.).",
      ),
    },
  },

  // ---- Client React adapter: react allowed; core consumed via public surface ----
  {
    files: ["packages/orpc-ws-client/src/react/**/*.{ts,tsx}"],
    plugins: { import: importPlugin },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./packages/orpc-ws-client/src/react",
              from: "./packages/orpc-ws-client/src",
              except: [
                "./index.ts",
                "./state/connection-state.ts",
                "./react",
              ],
              message:
                "React adapter consumes the public composition root only.",
            },
          ],
        },
      ],
    },
  },

  // ---- Server core: framework-free ----
  {
    files: ["packages/orpc-ws-server/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImportRule(
        SERVER_CORE_FORBIDDEN_PACKAGES,
        "Server core must remain framework-free; framework code lives in adapters (orpc-ws-server-nestjs, etc.).",
      ),
    },
  },

  // ---- Demo apps (apps/*/src) — looser than library code by design ----
  //
  // The framework-free rules deliberately don't apply here: apps/* is the
  // composition layer where react / express / nest are expected. We still
  // keep the typing discipline (`no-explicit-any`, consistent type
  // imports) and `import/no-extraneous-dependencies` for phantom-import
  // catches, but `no-console` is off — demo apps log to console freely.
  {
    files: ["apps/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { project: ["apps/*/tsconfig.json"] },
        node: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "import/no-extraneous-dependencies": [
        "error",
        {
          devDependencies: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/vite.config.*",
            "**/eslint.config.*",
          ],
        },
      ],
    },
  },

  // ---- Test files: relax a couple of rules ----
  {
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // ---- Config files at the root: Node-context, allow devDependencies. ----
  {
    files: ["*.{js,mjs,cjs,ts}", "**/vitest.config.{ts,mts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
    },
  },
);
