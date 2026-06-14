# OpenClaw version compatibility — local harness + bridge (per-version replay)

Atrium targets a bridge that works correctly on each OpenClaw version: replay
the whole local harness + file-exchange chain on every new OpenClaw release, and
add per-version handling only where the protocol actually differs. Run any
version on the fly: `OPENCLAW_VERSION=<tag> ./local-openclaw/up.sh` (image
`<your-dockerhub-user>/openclaw-docker`).

## Tested matrix

| Concern | 2026.5.19 | 2026.6.1 | Verdict |
|---|---|---|---|
| codex CLI in image | 0.133.0 | 0.137.0 | — |
| Stripped instance seed validates + boots | ✅ | ✅ | **seed compatible** across versions |
| Codex flag `--dangerously-bypass-approvals-and-sandbox` | passed AFTER `app-server` → codex 0.133 rejects → **needs reorder wrapper** | native fix (codex 0.137 / OpenClaw ≥2026.5.20) → **bare codex works** | version difference |
| Reorder wrapper (`codex-yolo-wrapper.sh`) | required | **safe / harmless** (turn `wrapper-61-ok`) | **VERSION-AGNOSTIC → always apply** |
| Codex harness turn (ChatGPT Pro) | ✅ `bonjour`/`harness ok` | ✅ `six-un-ok` | works on both |
| WS protocol | v4 | v4 | normalizer/frame handling stable |

## Design conclusion: the harness is already version-aware WITHOUT per-version logic
- **Wrapper**: `local-openclaw/up.sh` + the compose ALWAYS bind-mount the reorder
  wrapper and set `OPENCLAW_CODEX_APP_SERVER_BIN` to it. Because the wrapper is
  version-agnostic (it normalizes the flag to a global position; on a version that
  already passes it correctly the result is identical), no per-version branch is
  needed. If a future version BREAKS the wrapper, override
  `OPENCLAW_CODEX_APP_SERVER_BIN=/usr/local/bin/codex` (bare) for that version.
- **Seed**: `local-openclaw/seed/openclaw.json` (stripped NAS instance config)
  validates on 5.19 + 6.1. If a future version changes the schema, re-strip from
  that version's `openclaw.json` (the `<root>: Invalid input` symptom = schema drift).
- **Codex**: harness mode reuses `~/.codex` (no per-version change).

## Per-version replay checklist (run on each new tag)
1. `OPENCLAW_VERSION=<tag> ./local-openclaw/up.sh` → gateway healthy + bridge paired.
2. Codex turn: `docker exec oc-local-gateway node /app/openclaw.mjs agent --agent <agent-id> -m "dis bonjour"` → responds (else: check the codex flag / wrapper).
3. Seed boots (no `<root>: Invalid input`) → else re-strip the seed for this version.
4. File exchange: a `MEDIA:` prompt → attachment renders byte-exact (the dedup'd
   single media part) → confirms normalizer/frame shapes unchanged.
5. Note any diff in this table.
