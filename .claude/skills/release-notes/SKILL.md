---
name: release-notes
description: >-
  Draft the CHANGELOG.md entry for the next Atrium version from the commits AND
  diffs since the last release tag, in the repo's established style, then hand off
  for review + tag. The CHANGELOG section IS the GitHub Release body (release.yml
  extracts it). Use when cutting a release / writing release notes / a changelog
  entry. Triggers: "/release-notes", "release notes", "draft the release",
  "changelog entry", "notes de release", "rédige le changelog".
---

# release-notes — draft the next release's CHANGELOG entry

Atrium's release pipeline is **CHANGELOG-driven**: `release.yml` publishes the
`## [<version>]` section of `CHANGELOG.md` as the GitHub Release body (and names the
release `Atrium <version> — <title>`). This skill writes that section for you from
the actual changes, so you never hand-author it — you review, then tag.

This skill **drafts and inserts** the entry. It NEVER commits, tags, or pushes —
the human does that after review (and the tag is what triggers the release).

## Inputs

- Optional target version as an argument (e.g. `/release-notes 0.1.3`).
- Optional free-text guidance (e.g. "emphasize the sidebar fix, downplay CI churn").
  Honor it when shaping the draft.

## Steps

1. **Find the range.** Last released tag:
   `git tag --list 'v*' --sort=-v:refname | head -1` (fall back to the root commit
   if there are no tags). The range is `<lasttag>..HEAD`.

2. **Decide the target version.**
   - If the user gave one, use it.
   - Otherwise infer a SemVer bump from the changes (breaking → major, new
     user-facing feature → minor, fixes/internal only → patch) and **state your
     proposed version + reasoning, then ask the user to confirm** before writing.
   - Reject a version that already has a `## [<version>]` section in CHANGELOG.md
     (don't duplicate) — surface it instead.

3. **Gather the material — read DIFFS, not just commit subjects** (this is what
   makes the notes accurate when commit messages are terse):
   - `git log <range> --no-merges --pretty='- %s%n%b'` for subjects + bodies.
   - `git diff <range> --stat` for the file footprint.
   - Then actually read the diffs of **user-facing** areas to understand impact:
     `src/`, `convex/`, `bridge/src/`, `mcp/src/`, `deploy/` docs, `README.md`,
     top-level config. Skip `*-lock.json`, `_generated/`, `src/paraglide/`, and
     pure test files (use them only to confirm a fix is real).

4. **Filter to user-facing changes.** EXCLUDE from the notes: `ci:`/`build:`/
   `chore:`/`test:` commits, dependency bumps, the bot's `chore(release)` commits,
   version-stamp churn, and pure internal refactors with no observable effect.
   KEEP: new/changed features, bug fixes users feel, security, deployment/ops
   changes that a self-hoster acts on (new scripts/docs/env), and notable
   reliability fixes (e.g. a query bound that fixes a prod failure). When in doubt
   about whether something is user-facing, read the diff and decide on impact, not
   on the commit verb.

5. **Write the section in the repo's STYLE** (open `CHANGELOG.md` and mirror the
   existing entries — currently English, narrative):
   - Heading: `## [<version>] — <short descriptive title>` (em-dash, like the
     existing entries).
   - One framing line (what kind of release: e.g. "Reliability and operability
     release. No breaking changes.").
   - Then bullets, each leading with a **bold** what-changed phrase, written for a
     user/operator (the *effect*, not the implementation). Group related changes;
     keep it tight (the 0.1.0/0.1.1 entries are the reference for tone + length).
   - Match the file's language (English) even if the chat is in another language.

6. **Insert** the new section into `CHANGELOG.md` at the TOP of the version list —
   immediately above the most recent `## [` heading, below the file's intro block.
   Leave the rest of the file untouched.

7. **Hand off.** Show the drafted section, then tell the user (do NOT do these):
   - review/edit the wording in `CHANGELOG.md`;
   - bump nothing by hand — the tag drives the lockstep version
     (`scripts/set-version.mjs` runs in CI; see `RELEASE.md`);
   - then `git commit` the CHANGELOG, `git tag v<version> && git push origin v<version>`
     to publish (CI turns this section into the GitHub Release).

## Guardrails

- Do not invent changes. Every bullet must trace to a real commit/diff in the
  range. If the range is empty or only contains excluded noise, say so and propose
  either skipping the release or a minimal "maintenance" entry — don't pad.
- Do not commit, tag, push, or run `set-version.mjs` — leave all git mutations to
  the user (repo convention).
- Keep secrets/PII out of notes (they're public). Describe behavior, not internal
  hostnames/keys.
- If `CHANGELOG.md` is missing, create it mirroring the format documented in
  `RELEASE.md` before adding the entry.
