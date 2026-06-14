# Releasing `@orpc-ws/*`

How to cut and publish a release of the seven `@orpc-ws/*` packages. The
monorepo is **lockstep-versioned** via [Changesets](https://github.com/changesets/changesets):
every published package shares one identical version and they all publish
together.

## Prerequisites

- **Node ≥ 22.14** locally, with **pnpm** provisioned via Corepack
  (`corepack enable` — the version is pinned in the root `package.json`
  `packageManager` field).
- The repository must stay **public** — npm provenance only works for public
  packages (it is automatic under trusted publishing).
- Steady-state publishing needs **no npm token**: CI authenticates via npm
  OIDC trusted publishing (see [Authentication](#authentication--publishing)).
  A token is only needed for the one-time bootstrap of a brand-new package.
- **One-time GitHub repo setting (required once):** Settings → Actions →
  General → Workflow permissions → enable **"Allow GitHub Actions to create
  and approve pull requests."** Without it, `changesets/action` cannot open
  the "Version Packages" PR.

## Lockstep versioning model

All seven published packages always carry the **same** version and publish as
a unit:

- `@orpc-ws/shared`
- `@orpc-ws/client`
- `@orpc-ws/server`
- `@orpc-ws/oidc-pkce`
- `@orpc-ws/oidc-react`
- `@orpc-ws/server-nestjs`
- `@orpc-ws/oidc-verifier-jose`

Lockstep is enforced by the Changesets `fixed` group in `.changeset/config.json`
— a release of any one package bumps all seven to the same version. Internal
cross-package deps use the **`workspace:*`** protocol; `pnpm publish` (invoked
by `changeset publish`) rewrites each to the exact just-published version, so an
adapter never drifts from the core version it was built against.

## Cutting a release (the normal path)

### 1. Add a changeset with each PR

Whenever a PR changes published behavior, run:

```bash
pnpm changeset
```

Pick the bump type (patch / minor / major) and write a one-line summary. Because
of the `fixed` group you only need to select one package — all seven move
together — but the summary is what lands in the CHANGELOGs. Commit the generated
`.changeset/*.md` file alongside your change. (A PR with no user-facing change
needs no changeset.)

### 2. Merge to `main`

On every push to `main`, the `npm-publish.yml` workflow runs `changesets/action`.
If there are pending `.changeset/*.md` files, it opens (or updates) a **"Version
Packages" PR**. That PR runs `pnpm changeset version`, which:

- bumps all seven packages in lockstep,
- rewrites internal `workspace:*` deps,
- folds the changeset summaries into each `CHANGELOG.md`,
- and deletes the consumed `.changeset/*.md` files.

### 3. Merge the "Version Packages" PR → CI publishes

Merging that PR triggers the workflow again; this time there are no pending
changesets, so the action runs `pnpm changeset publish`, which:

- publishes every bumped package via npm OIDC trusted publishing + provenance
  (resolving `workspace:*` to the exact new version),
- pushes the git tags,
- and creates the GitHub Releases (the action's `createGithubReleases` default).

No manual tagging, no `git push --tags`, no version-stamp script.

## Prereleases & snapshots

**Prerelease line** (e.g. a `beta` channel):

```bash
pnpm changeset pre enter beta   # start prerelease mode
# ... merge PRs with changesets as usual; versions become 0.2.0-beta.0, .1, ...
pnpm changeset pre exit         # back to stable releases
```

While in prerelease mode the Version PR produces `-beta.N` versions and
`changeset publish` ships them under the `beta` dist-tag. Commit the
`.changeset/pre.json` that `pre enter` creates.

**One-off snapshot release** (ephemeral, e.g. for testing a PR build):

```bash
pnpm changeset version --snapshot
pnpm changeset publish --tag snapshot
```

This publishes a throwaway `0.0.0-snapshot-*` version under the `snapshot`
dist-tag without touching `main` history.

## Authentication & publishing

Steady state uses **npm OIDC trusted publishing** — no long-lived token.
`npm-publish.yml` declares `permissions: id-token: write` and deliberately sets
**no** `NPM_TOKEN` / `NODE_AUTH_TOKEN`. Leaving the token unset is what selects
OIDC (a present-but-empty token would bypass OIDC and 404). Provenance is
automatic.

> **Do not rename `npm-publish.yml`.** The npmjs.org trusted-publisher bindings
> for all seven packages are keyed to this exact workflow filename; renaming it
> breaks OIDC authorization.

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
