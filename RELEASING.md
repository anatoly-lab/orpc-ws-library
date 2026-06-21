# Releasing `@orpc-ws/*`

How to cut and publish a release of the eight `@orpc-ws/*` packages. The
monorepo is **lockstep-versioned** via [Changesets](https://github.com/changesets/changesets):
every published package shares one identical version and they all publish
together. Publishing is **tag-triggered** — Changesets is kept purely as a
local versioning + changelog tool; pushing an `v*` tag is what ships to npm.

## Prerequisites

- **Node ≥ 22.22** locally (the repo floor — `.nvmrc` pins `22.22`; raised
  by react-router v8's `engines.node >=22.22.0`, on top of the OIDC ≥22.14
  and undici/testcontainers ≥22.19 floors), with **pnpm** provisioned via
  Corepack (`corepack enable` — the version is pinned in the root
  `package.json` `packageManager` field).
- The repository must stay **public** — npm provenance only works for public
  packages (it is automatic under trusted publishing).
- Steady-state publishing needs **no npm token**: CI authenticates via npm
  OIDC trusted publishing (see [Authentication](#authentication--publishing)).
  A token is only needed for the one-time bootstrap of a brand-new package.
- **No special GitHub PR-creation permission is needed.** The release flow no
  longer opens a "Version Packages" bot PR (the `changesets/action` is gone),
  so the org/repo "Allow GitHub Actions to create and approve pull requests"
  toggle is **not** required for releases. Versioning runs locally; CI only
  publishes on a tag.

## Lockstep versioning model

All eight published packages always carry the **same** version and publish as
a unit:

- `@orpc-ws/shared`
- `@orpc-ws/client`
- `@orpc-ws/react`
- `@orpc-ws/server`
- `@orpc-ws/oidc-pkce`
- `@orpc-ws/oidc-react`
- `@orpc-ws/server-nestjs`
- `@orpc-ws/oidc-verifier-jose`

Lockstep is enforced by the Changesets `fixed` group in `.changeset/config.json`
— a release of any one package bumps all eight to the same version. Internal
cross-package deps use the **`workspace:*`** protocol; `pnpm publish` rewrites
each to the exact just-published version, so an adapter never drifts from the
core version it was built against.

## Cutting a release (the normal path)

Releases are **tag-triggered**: `.github/workflows/npm-publish.yml` runs **only**
on a pushed `v*` tag and publishes via `pnpm -r publish`. Pushing or merging to
`main` **never** publishes — push to `main` as freely as you like; pending
`.changeset/*.md` files simply accumulate there until you decide to cut a
release.

### 1. Add a changeset with each PR

Whenever a PR changes published behavior, run:

```bash
pnpm changeset
```

Pick the bump type (patch / minor / major) and write a one-line summary. Because
of the `fixed` group you only need to select one package — all eight move
together — but the summary is what lands in the CHANGELOGs. Commit the generated
`.changeset/*.md` file alongside your change. (A PR with no user-facing change
needs no changeset.) Merge to `main` as usual; nothing publishes yet.

### 2. Version the packages (locally)

When you're ready to release, consume the pending changesets:

```bash
pnpm version-packages   # = `changeset version`
```

This:

- bumps all eight packages in lockstep,
- rewrites internal `workspace:*` deps,
- folds the changeset summaries into each `CHANGELOG.md`,
- and deletes the consumed `.changeset/*.md` files.

### 3. Commit the bump and push to `main`

```bash
git commit -am "release: vX.Y.Z"
git push
```

(Substitute the version that `version-packages` just produced — read it off any
bumped `package.json`.) This lands the version bumps and CHANGELOGs on `main`;
it still does **not** publish.

### 4. Tag the release → CI publishes

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag push is the publish trigger. `npm-publish.yml` checks out the tagged
commit, builds, and runs `pnpm -r publish --no-git-checks`, which:

- publishes every package whose version is not yet on the registry via npm OIDC
  trusted publishing + provenance (resolving `workspace:*` to the exact new
  version),
- skips the private `@demo/*` apps,
- and is a safe no-op if re-run on the same tag (already-published versions are
  skipped).

GitHub Releases are not created automatically anymore; cut one by hand from the
tag if you want release notes (the CHANGELOGs already carry the detail).

## Prereleases & snapshots

**Prerelease line** (e.g. a `beta` channel):

```bash
pnpm changeset pre enter beta   # start prerelease mode
# ... merge PRs with changesets as usual; versions become 0.2.0-beta.0, .1, ...
pnpm changeset pre exit         # back to stable releases
```

While in prerelease mode `pnpm version-packages` produces `-beta.N` versions;
tagging and pushing `vX.Y.Z-beta.N` then ships them (pnpm publishes a
prerelease version under the `beta` dist-tag when the version carries a
`-beta` suffix). Commit the `.changeset/pre.json` that `pre enter` creates.

**One-off snapshot release** (ephemeral, e.g. for testing a PR build):

```bash
pnpm changeset version --snapshot
pnpm changeset publish --tag snapshot
```

This publishes a throwaway `0.0.0-snapshot-*` version under the `snapshot`
dist-tag without touching `main` history. (The root `release` script was
removed — invoke `changeset publish` via `pnpm exec changeset publish` for this
one-off local path; steady-state releases never call it, CI publishes on tag.)

## Authentication & publishing

Steady state uses **npm OIDC trusted publishing** — no long-lived token.
`npm-publish.yml` declares `permissions: id-token: write` and deliberately sets
**no** `NPM_TOKEN` / `NODE_AUTH_TOKEN`. Leaving the token unset is what selects
OIDC (a present-but-empty token would bypass OIDC and 404). Provenance is
automatic.

> **Do not rename `npm-publish.yml`.** The npmjs.org trusted-publisher bindings
> for all eight packages are keyed to this exact workflow filename; renaming it
> breaks OIDC authorization. (The binding matches on repo + workflow filename,
> **not** on branch/ref — which is why moving the trigger from `push: main` to
> `push: tags: v*` authorizes identically, no re-registration needed.)

## One-time setup for a brand-NEW package

OIDC trusted publishing cannot **create** a package that doesn't yet exist on
npm — there's nothing to attach the trusted-publisher link to. So the very first
publish of any new `@orpc-ws/*` package needs a one-time token bootstrap:

1. **Create a granular npm token** with "Bypass 2FA" enabled and add it as the
   `NPM_TOKEN` repo secret.
2. **Temporarily wire it in.** In `npm-publish.yml`, add
   `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` to the publish step's `env` so
   that first publish authenticates with the token and creates the package on
   npm.
3. **Register the trusted publisher** (see below).
4. **Tear down.** Remove the `NODE_AUTH_TOKEN` line, delete the `NPM_TOKEN`
   secret, and revoke the token. All future publishes use OIDC.

### Registering the trusted publisher

This is **per package** — there is no scope-wide trusted-publisher setting. It
requires **npm ≥ 11.10.0 installed globally** (NOT via `npx` — `npx` breaks the
interactive web-auth flow):

```bash
npm install -g npm@latest   # ensure >= 11.10.0
npm trust github @orpc-ws/<pkg> \
  --repo anatoly-lab/orpc-ws-library \
  --file npm-publish.yml \
  --allow-publish
```

The first `npm trust` invocation opens a browser for 2FA — tick **"skip 2FA for
the next 5 minutes"**, then run the remaining packages' commands within that
window so each doesn't re-prompt.

Alternatively, configure it on the website: for each package on npmjs.com →
**Settings → Trusted publishing → GitHub Actions**, pointing at this repo and
the `npm-publish.yml` workflow.
