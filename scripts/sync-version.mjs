#!/usr/bin/env node
// Lockstep version sync for the @orpc-ws/* monorepo.
//
// All 7 published packages share ONE identical version and publish together.
// This script is the single writer of that version: it stamps the given
// version into every @orpc-ws/* package.json AND the (private) root
// package.json — the latter is the canonical source the CI tag guard checks.
//
// It also rewrites cross-package @orpc-ws/* dependency ranges to the SAME
// exact version (the repo pins cross-deps exactly; see .npmrc save-exact=true),
// so adapter↔core skew stays unrepresentable. This rewrite spans EVERY
// workspace — including the private demo apps (apps/*) and tests-e2e — because
// they consume the cores at exact pins too; if their pins lagged behind, npm
// would stop linking the local workspace copy and try (and fail) to fetch the
// old version from the registry. Third-party deps (react, @nestjs/*, jose, ws,
// @orpc/*, …) are left untouched. Only the publishable packages get their own
// `version` bumped; apps/tests-e2e keep their version, only their pins move.
//
// Finally it regenerates package-lock.json (a full `npm install`) so the
// committed lockfile matches — otherwise `npm ci` in the release/publish
// workflows fails with "package.json and package-lock.json not in sync".
//
// Re-running with the current version is a near no-op (package.json files
// unchanged); the lockfile step keeps the lock complete. Requires npm on PATH.
//
// Usage: node scripts/sync-version.mjs <version>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const SCOPE = "@orpc-ws/";
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// Basic semver (with optional prerelease), matching the anki repo's guard.
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];
if (!version || !SEMVER_RE.test(version)) {
  console.error("Usage: node scripts/sync-version.mjs <version>");
  console.error("  <version> must be a semver like 0.2.0 or 1.0.0-beta.1");
  if (version) console.error(`  got: ${version}`);
  process.exit(1);
}

/** Read a package.json, returning its parsed JSON. */
function readPkg(pkgPath) {
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
}

/** Write a package.json with 2-space indent + trailing newline (matches existing files). */
function writePkg(pkgPath, json) {
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n");
}

/**
 * Rewrite every @orpc-ws/* dependency in `json` to the exact `version`.
 * Returns the list of human-readable changes made (empty if none).
 */
function rewriteScopedDeps(json) {
  const changes = [];
  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps || typeof deps !== "object") continue;
    for (const key of Object.keys(deps)) {
      if (!key.startsWith(SCOPE)) continue; // leave react/@nestjs/jose/etc. alone
      if (deps[key] !== version) {
        changes.push(`${field}.${key} ${deps[key]} -> ${version}`);
        deps[key] = version; // exact pin, no ^ / ~
      }
    }
  }
  return changes;
}

// Every workspace package.json: packages/* + apps/* + the top-level tests-e2e.
// (Mirrors root package.json "workspaces": ["packages/*","apps/*","tests-e2e"].)
function listWorkspacePkgs() {
  const out = [];
  for (const group of ["packages", "apps"]) {
    const base = path.join(repoRoot, group);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(base, entry.name, "package.json");
      if (fs.existsSync(pkgPath)) out.push(pkgPath);
    }
  }
  const e2e = path.join(repoRoot, "tests-e2e", "package.json");
  if (fs.existsSync(e2e)) out.push(e2e);
  return out;
}

let written = 0;
let bumped = 0;

for (const pkgPath of listWorkspacePkgs()) {
  const json = readPkg(pkgPath);
  const isPublishable =
    typeof json.name === "string" && json.name.startsWith(SCOPE);
  const changes = [];

  // Only the publishable @orpc-ws/* packages get their own version bumped;
  // private apps / e2e keep their version (just their pins move).
  if (isPublishable && json.version !== version) {
    changes.push(`version ${json.version} -> ${version}`);
    json.version = version;
  }
  if (isPublishable) bumped += 1;

  changes.push(...rewriteScopedDeps(json));

  const rel = path.relative(repoRoot, pkgPath);
  if (changes.length > 0) {
    writePkg(pkgPath, json);
    written += 1;
    console.log(`~ ${rel}${json.name ? ` (${json.name})` : ""}: ${changes.join(", ")}`);
  }
}

// Stamp the root package.json version (canonical source for the CI tag guard).
// Root has no @orpc-ws/* deps of its own.
const rootPath = path.join(repoRoot, "package.json");
const rootJson = readPkg(rootPath);
if (rootJson.version !== version) {
  console.log(`~ package.json (root): version ${rootJson.version} -> ${version}`);
  rootJson.version = version;
  writePkg(rootPath, rootJson);
  written += 1;
}

console.log(
  `\nStamped ${bumped} publishable packages + root to ${version} (${written} file(s) changed).`,
);

// Keep the lockfile in sync so `npm ci` works in CI. We run a FULL `npm install`
// (NOT --package-lock-only): the lock must contain EVERY platform-specific
// optional dependency (e.g. @esbuild/linux-x64, @esbuild/win32-x64, …), and
// --package-lock-only records only the current platform's — which makes a
// stricter `npm ci` (newer npm) fail with "Missing: @esbuild/… from lock file".
console.log("Regenerating package-lock.json (npm install)…");
execFileSync("npm", ["install"], {
  cwd: repoRoot,
  stdio: "inherit",
});
console.log("Done.");
