#!/usr/bin/env bash
# Lockstep publish for the @orpc-ws/* monorepo.
#
# All 7 packages share ONE version (set by scripts/sync-version.mjs) and
# publish together, in topological order (deps before dependents). The root
# package.json version is the single source of truth.
#
# Auth is NOT handled here. The workflow sets up ~/.npmrc / OIDC before
# calling this script; locally you must already be `npm login`'d.
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
echo "Publishing @orpc-ws/* at version: $VERSION"

# Detect prerelease (e.g. "beta" from "0.2.0-beta.1") -> npm dist-tag.
# Stable releases get the default "latest" tag (empty NPM_TAG).
NPM_TAG=""
if [[ "$VERSION" =~ -([a-zA-Z]+) ]]; then
  NPM_TAG="${BASH_REMATCH[1]}"
  echo "Prerelease detected; publishing to dist-tag: $NPM_TAG"
else
  echo "Stable release; publishing to dist-tag: latest"
fi

# Topological publish order: a package is published only after everything it
# depends on. The three "tiers" below correspond to the dependency layers.
PACKAGES=(
  # tier 1: shared seam types (no @orpc-ws deps)
  "@orpc-ws/shared"
  # tier 2: cores depending only on shared
  "@orpc-ws/oidc-pkce"
  "@orpc-ws/client"
  "@orpc-ws/server"
  # tier 3: adapters / verifiers depending on tier-2 packages
  "@orpc-ws/oidc-react"
  "@orpc-ws/server-nestjs"
  "@orpc-ws/oidc-verifier-jose"
)

publish_args=(--access public --provenance)
if [[ -n "$NPM_TAG" ]]; then
  publish_args+=(--tag "$NPM_TAG")
fi

for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "==> Publishing $pkg@$VERSION ${NPM_TAG:+(tag: $NPM_TAG)}"
  npm publish -w "$pkg" "${publish_args[@]}"
done

echo ""
echo "All 7 @orpc-ws/* packages published at $VERSION."
