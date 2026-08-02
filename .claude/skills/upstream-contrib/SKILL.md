---
name: upstream-contrib
description: >-
  Gate, open, and track Atrium's contributions to its providers' upstreams
  (openclaw/openclaw, NousResearch/hermes-agent): four proof gates before
  anything is opened, a machine-readable ledger
  (bridge/protocol/contrib/registry.json), and a gh-based sync that reports
  which issues/PRs originated from our findings, and which are open, merged,
  rejected or closed. Triggers: "/upstream-contrib", "/upstream-contrib sync",
  "contribution amont", "ouvre une issue OpenClaw/Hermes", "sync des issues",
  "état des contributions amont".
---

# upstream-contrib — contribute upstream through gates, then track it

## Authorization boundary (recorded 2026-07-31, granted by the maintainer)

- Opening **issues and PRs** on `openclaw/openclaw` and
  `NousResearch/hermes-agent` is DELEGATED — autonomous once the four gates
  below pass, every action recorded in the ledger where the maintainer audits
  it.
- `git push` is allowed **only to contribution forks under the maintainer's own
  GitHub account, created for these PRs** — an explicit, scoped lift of the
  otherwise absolute no-push rule. Pushing to the Atrium repo, or any other
  repo, stays forbidden; committing in the Atrium working tree stays forbidden.
- A repro must NEVER contain client data, conversational content, instance
  names, tokens, or private paths. Counts, field names, minimal synthetic
  payloads only. When a real frame is needed, rebuild it synthetically.
- New target repo = a decision by the maintainer, not a drift: the allowed list
  is enforced by `bridge/test/contrib-registry.test.ts`.

## The four gates (all of them, in order, before anything is opened)

1. **G1 — minimal repro at the pinned tag.** Reproduce against the exact
   upstream SHA from `PROVENANCE.json` (or the validated Hermes tag). A defect
   that only exists in our reading of the source is our defect.
2. **G2 — check the latest beta.** Fetch the newest upstream tag
   (`git ls-remote --tags`) and re-check: already fixed upstream means "adopt
   later", not "report".
3. **G3 — duplicate search.** `gh search issues -R <repo> "<terms>"` and
   `gh issue list -R <repo> -S "<terms>"`. A duplicate gets a 👍/comment at
   most, never a new issue; link the EXISTING item in the ledger with
   `origin: "upstream-change"`.
4. **G4 — the write-up.** English; states the pinned version, the exact repro
   steps, expected vs observed, and (for a PR) the minimal patch with its test.
   No Atrium-internal vocabulary without a one-line gloss.

## Opening

- Issue: `gh issue create -R <repo> --title … --body-file …`.
- PR: `gh repo fork <repo> --clone` (fork under the maintainer's account) →
  branch → commits IN THE FORK → `git push` to the fork → `gh pr create`.
- Immediately add the ledger entry: `{id (oc-/hm- + counter), repo, kind, url,
  title, origin, frames[], atriumLots[], openedAt, state: "open",
  resolution: null}`. Run the registry test.

## Sync and report

- `node bridge/scripts/contrib-sync.mjs` — refreshes every entry's state via
  `gh` (read-only), stamps `lastSyncAt`, prints the report table (id, repo,
  state/resolution, origin, frames, title).
- Cadence: at the start of EVERY frame-discovery run, and on demand.
- What each terminal state triggers for us:
  - **merged / accepted** → plan adoption at the next version onboarding; the
    frame's manifest entry gains the new fact.
  - **rejected / wontfix** → decide and DOCUMENT the permanent workaround in the
    frame's manifest entry (`note`/`why` naming the refusal), never silence.
  - **closed without verdict** → record `resolution` by reading the thread; ask
    the maintainer only if the verdict is genuinely ambiguous.

## Never

- Never open anything that has not passed all four gates.
- Never edit, close, or comment on upstream items during a sync (sync is
  read-only by construction — see contrib-sync.mjs).
- Never let the ledger drift: the entry is written in the same action as the
  `gh` create, and the registry test runs before reporting done.
