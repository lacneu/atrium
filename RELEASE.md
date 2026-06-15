# Releasing Atrium

Atrium is an **application** shipped as a cohesive whole — two Docker images
(`atrium`, `atrium-bridge`), a thin npm package (`@lacneu/atrium`), and an MCP
server — so every artifact carries the **same version, in lockstep**. This is not
a library monorepo with independent per-package cadences.

## The single source of truth is the git tag

Each release is **two steps**: write the `CHANGELOG.md` entry, then push the tag.

```bash
# 1. Add a "## [0.1.3] — <title>" section to CHANGELOG.md (the release description).
# 2. Commit it, then:
git tag v0.1.3
git push origin v0.1.3      # ← this triggers the whole pipeline
```

On the tag push, CI does all of the following automatically:

| Step | Workflow | Version source |
|------|----------|----------------|
| Run the test gate, then `npm publish @lacneu/atrium --provenance` | `release.yml` | the tag |
| Build + push both Docker images (`{version}`, `{major}.{minor}`, `latest`) | `build-and-push.yml` | the tag |
| Create the **GitHub Release**, notes from the `CHANGELOG.md` section | `release.yml` | the tag |
| **Commit the version back to `main`** (real numbers in all 6 files) | `release.yml` | the tag |

You edit **no** version field by hand. The release **description is the `CHANGELOG.md`
section** for that version (curated, rich) — the release is even named
`Atrium <version> — <changelog title>`. If there is **no** matching `## [version]`
section, CI falls back to GitHub's auto-generated notes (near-empty here, because
the repo commits straight to `main` with no PRs) — so always write the CHANGELOG
entry first. `.github/release.yml` excludes the bot's `chore(release)` commits from
that fallback.

## How the version reaches every artifact

`scripts/set-version.mjs <semver>` stamps the one lockstep version across the root
app, the bridge, and the mcp (`package.json` **and** `package-lock.json` for each,
via `npm version`, which is surgical — it never rewrites the dependency tree). The
CI calls it:

- **before `npm ci`** in each image build, so `package.json`/lockfile stay in sync
  and the built artifact embeds the tag version (the bridge self-reports it via
  `BRIDGE_VERSION`; the mcp via its `package.json`);
- in the **commit-back** job, so the files on `main` show the real number after the
  release.

You can also run it locally if you ever want the working tree to match a version:

```bash
node scripts/set-version.mjs 0.1.3
```

## Known wart (the price of "just a tag")

The tag points at the commit **before** the version bump (the bump is committed
back to `main` *after* the tag). So `git checkout v0.1.3` shows the *previous*
number in `package.json` — only the CI-built artifacts carry the correct version
(they are stamped from the tag name at build). This is the inherent trade-off of
"one tag is the whole release"; the only way to get a perfectly version-stamped tag
tree would be to bump-then-tag manually, which defeats the purpose. Don't panic
when you see it.

## Pre-flight

- Tag format is `vMAJOR.MINOR.PATCH` (the stamp script rejects anything else).
- npm refuses to republish an existing version, so each tag must be a new version.
  `@lacneu/atrium` **0.1.0 and 0.1.1 are already published**, so the first tag under
  this model must be **`v0.1.2` or higher** (the committed baseline is `0.1.2`).
- `main` must stay unprotected for the commit-back push to succeed (or grant the
  release token bypass). If you protect `main`, switch the commit-back job to open
  a PR instead.

## npm OIDC Trusted Publishing (how `publish-npm` authenticates)

`publish-npm` uses **OIDC Trusted Publishing** — no `NODE_AUTH_TOKEN`/`NPM_TOKEN`
secret. It works only when ALL of these hold:

- the job has `permissions: id-token: write` (it does);
- npmjs.com has a **Trusted Publisher** for `@lacneu/atrium` matching this repo +
  `release.yml` + (empty environment);
- the runner's **npm CLI is >= 11.5.1** (the workflow upgrades it with `npm install -g
  npm@latest`);
- **`package.json` has a `repository.url` pointing at THIS repo** (`git+https://github.com/lacneu/atrium.git`,
  owner casing exact). npm's OIDC/provenance match keys on this — **its absence is what
  404'd the first attempts** (the OIDC token exchange returned "package not found", npm
  fell back to an anonymous PUT → the misleading `404 Not Found`);
- the publish passes **`--provenance`** — required the FIRST time a package is published
  via OIDC if earlier versions were published WITHOUT provenance (atrium's 0.1.0/0.1.1
  were manual). It can stay on afterwards.

**Debugging a `404 Not Found` on PUT** (the misleading "not found / no permission" — npm
emits this when it falls back to anonymous; see npm/cli#9088): run `npm publish --verbose`
to see the real error — the `POST /-/npm/v1/oidc/token/exchange/package/<pkg>` line reveals
the actual OIDC failure. Things that are NOT the cause (proven by diffing the working sibling
`openclaw-knowledge-plugin`): the `NODE_AUTH_TOKEN: XXXXX-...` placeholder, the `always-auth`
warning, `setup-node@v4` vs `v6`, the npm version, and the "disallow tokens" radio — the
SUCCESSFUL sibling runs show all the same. The real causes were the missing `repository.url`
+ first-publish `--provenance` (npm/cli#8730, #8678).

## If a job fails mid-release (recovery)

`npm publish` is the only irreversible step; the GitHub Release and the
version-commit-back are additive and run *after* it. So:

- **A post-publish job failed** (e.g. `version-commit-back` hit a non-fast-forward
  because `main` moved): use **"Re-run failed jobs"** on the workflow run.
  `publish-npm` keeps its cached success, so npm is **not** republished, and only the
  failed job re-runs.
- **`publish-npm` itself failed and the fix is a WORKFLOW change** (e.g. the npm
  OIDC 404 fixed by upgrading npm): "Re-run failed jobs" will NOT help — a re-run
  uses the workflow file *as it was at the tagged commit*. Commit the fix, then
  **move the tag onto the fixed commit**. This is safe ONLY while that version is
  not yet on npm:
  ```bash
  git tag -d vX.Y.Z && git push origin :vX.Y.Z   # remove the old tag
  git tag vX.Y.Z && git push origin vX.Y.Z        # recreate on the fixed commit
  ```
- **Do NOT delete + re-push a tag whose version is ALREADY on npm**: `publish-npm`
  would hit npm's "version already exists" wall. In that case bump to a new version.
  (Docker images re-push fine to the same tag; only npm is write-once.)

> Note: the first real tag under this model is also its **validation run** — the
> release jobs (auto-notes, commit-back, in-CI stamping) only execute on an actual
> tag push and cannot be exercised locally.
