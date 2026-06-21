# OpenClaw version compatibility — local harness + bridge (per-version replay)

Atrium targets a bridge that works correctly on each OpenClaw version: replay
the whole local harness + file-exchange chain on every new OpenClaw release, and
add per-version handling only where the protocol actually differs. Run any
version on the fly: `OPENCLAW_VERSION=<tag> ./local-openclaw/up.sh` (image
`<your-dockerhub-user>/openclaw-docker`).

## Tested matrix

| Concern | 2026.5.19 | 2026.6.1 | 2026.6.5 | Verdict |
|---|---|---|---|---|
| codex CLI in image | 0.133.0 | 0.137.0 | 0.139.0 | — |
| Stripped instance seed validates + boots | ✅ | ✅ | ✅ | **seed compatible** across versions |
| Codex flag `--dangerously-bypass-approvals-and-sandbox` | passed AFTER `app-server` → codex 0.133 rejects → **needs reorder wrapper** | native (codex 0.137 / OpenClaw ≥2026.5.20) → **bare codex works** | native (codex 0.139) | flag reorder needed on codex <0.137 only |
| Reorder wrapper (`codex-yolo-wrapper.sh`) | required | safe / harmless (turn `wrapper-61-ok`) | safe / harmless (v3 wrapper path) | **VERSION-AGNOSTIC → always apply** |
| Codex harness turn (ChatGPT Pro) | ✅ `bonjour`/`harness ok` | ✅ `six-un-ok` | ✅ (stability 6/6, 0 approval popups) | works on all |
| WS protocol | v4 | v4 | v4 | normalizer/frame handling stable |

On 2026.6.5 a long message-tool reply arrives as a bare `stream:"item"` frame (no
inline args/result, unlike the 2026.5.19 args path), so the visible text lives only
in the session transcript; the bridge recovers it with a one-shot session-history
read (`bridge/src/providers/openclaw/history-recovery.ts`) during the existing
ack/empty-final grace. This is the kind of per-version handling the design
conclusion below refers to — added only where a frame shape actually differs.

## Current target: 2026.6.8

`2026.6.8` is the OpenClaw release the harness currently targets. Bring it up with
`OPENCLAW_VERSION=2026.6.8 ./local-openclaw/up.sh`, then run the per-version replay
checklist below. The version-agnostic harness (reorder wrapper + stripped seed)
applies unchanged; the matrix records each version's replay results — add the
2026.6.8 column from that run, and only add per-version handling where a step
reveals a real protocol difference.

## Design conclusion: the harness is already version-aware WITHOUT per-version logic
- **Wrapper**: `local-openclaw/up.sh` + the compose ALWAYS bind-mount the reorder
  wrapper and set `OPENCLAW_CODEX_APP_SERVER_BIN` to it. Because the wrapper is
  version-agnostic (it normalizes the flag to a global position; on a version that
  already passes it correctly the result is identical), no per-version branch is
  needed. If a future version BREAKS the wrapper, override
  `OPENCLAW_CODEX_APP_SERVER_BIN=/usr/local/bin/codex` (bare) for that version.
- **Seed**: `local-openclaw/seed/openclaw.json` (stripped NAS instance config)
  validates on 5.19 + 6.1 + 6.5. If a version changes the schema, re-strip from
  that version's `openclaw.json` (the `<root>: Invalid input` symptom = schema drift).
- **Codex**: harness mode reuses `~/.codex` (no per-version change).

## Per-version replay checklist (run on each new tag)
1. `OPENCLAW_VERSION=<tag> ./local-openclaw/up.sh` → gateway healthy + bridge paired.
2. Codex turn: `docker exec oc-local-gateway node /app/openclaw.mjs agent --agent <agent-id> -m "dis bonjour"` → responds (else: check the codex flag / wrapper).
3. Seed boots (no `<root>: Invalid input`) → else re-strip the seed for this version.
4. File exchange: a `MEDIA:` prompt → attachment renders byte-exact (the dedup'd
   single media part) → confirms normalizer/frame shapes unchanged.
5. Note any diff in this table.
