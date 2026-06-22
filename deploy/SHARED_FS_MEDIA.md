# Shared-fs media — deterministic file delivery & big-file ingestion

Atrium moves files **to** the agent (a user uploads a doc) and **from** the agent
(the agent produces a file you download) over its bridge. There are two transport
modes; this page is the unambiguous setup for the second one.

| Mode | Needs a shared filesystem? | Outbound (agent → user) | Inbound (user → agent) |
|------|----------------------------|-------------------------|------------------------|
| **gateway-http** (default) | **No** | Best-effort — depends on the agent emitting a path the gateway surfaces | Capped by the WebSocket frame ceiling (~25 MiB) |
| **shared-fs** (opt-in) | **Yes** — Atrium and the gateway share the gateway's media dirs on disk | **Deterministic** — the bridge scans the dir after every turn and hosts every file the agent wrote, with or without a `MEDIA:` line | **Any size** — the bridge streams big files to the dir and hands the agent a path |

Use **gateway-http** when Atrium and the gateway run on different hosts. Use
**shared-fs** when they share a host (or NFS) and you want reliable downloads and
large (video/audio/big-doc) uploads.

> This is the **only** way to deliver agent-produced files deterministically: a
> bare file write surfaces *nothing* over the gateway protocol (no `mediaUrls`, no
> artifacts) — the gateway signals a file only if the LLM cooperates. shared-fs
> sidesteps the LLM by reading the dir directly.

---

## The one rule: **bridge path keyed by instance, agent path flat**

Four paths are in play. Get this table right and everything works; get it wrong
and files vanish silently.

| # | Path | Lives in | Value | Keyed by instance? |
|---|------|----------|-------|--------------------|
| 1 | Host media dirs | the host filesystem | `<H>/media/{outbound,inbound}` | yes — the host is already per-instance |
| 2 | **Agent** writes/reads | the **gateway** container | `/home/node/.openclaw/media/{outbound,inbound}` | **NO — must stay flat** |
| 3 | **Bridge** reads/writes | the **bridge** container | `/home/node/.openclaw/media/<instance>/{outbound,inbound}` | **YES** |

`<H>` = the gateway's state dir on the host (its `.openclaw` mount), e.g.
`<root>/instances/<instance>/.openclaw`.

**Why path 2 (agent) stays flat — this is forced, not a style choice.** Each
gateway container mounts `<H> → /home/node/.openclaw`, so its agent always sees
its media at the flat `/home/node/.openclaw/media/{outbound,inbound}`. That exact
flat path is also what the instance's `openclaw.json`
`file-transfer.allowReadPaths` whitelists. Keying it would make the agent unable
to read its own files unless you also edited every `openclaw.json`. So **never key
the agent path.**

**Why path 3 (bridge) is keyed.** The bridge's own mount point is free. Keying it
by instance means several bridges (or one bridge serving several gateways) never
collide and each mount is self-documenting. The bridge derives it automatically
from each served instance's **name** — which it resolves from Convex via that
instance's per-bridge secret (there is no `OPENCLAW_INSTANCE_NAME` env any more), so
the path follows the name.

Paths 2 and 3 bind the **same host dir** (path 1) at different container paths —
that co-location is what makes the file the bridge writes the same file the agent
reads.

---

## The convention (fill in the blanks)

For an instance named **`<I>`** whose gateway keeps state at host dir **`<H>`**
and runs as uid **`<UID>:<GID>`**:

| What | Value |
|------|-------|
| Host outbound dir | `<H>/media/outbound` |
| Host inbound dir | `<H>/media/inbound` |
| Bridge env: per-bridge secret | `BRIDGE_INSTANCE_SECRETS` includes `<I>`'s secret |
| Bridge env: run-as uid | `user: "<UID>:<GID>"` (match the gateway) |
| Bridge mount (outbound) | `<H>/media/outbound  →  /home/node/.openclaw/media/<I>/outbound  :ro` |
| Bridge mount (inbound) | `<H>/media/inbound  →  /home/node/.openclaw/media/<I>/inbound` |
| Atrium UI | Settings → Agents → Instances: set `<I>`'s gateway URL + credentials, mint its secret; Settings → Agents → Bridge → Configure `<I>` → Outbound **and** Inbound = `shared-fs` |

The bridge auto-derives its read/write dirs from the instance **name** it resolves
from Convex (via `<I>`'s per-bridge secret), so they **equal** the literal mount
targets above with no extra env. Override only when a bridge serves a **single**
instance (the overrides are process-global): `OPENCLAW_MEDIA_OUTBOUND_DIR` /
`OPENCLAW_INBOUND_DIR`.

---

## Worked example — one bridge, two gateways `alpha` and `beta`

A host runs two OpenClaw gateways. Each keeps its state under
`/srv/openclaw/instances/<name>/.openclaw` and runs as `1000:1000`. We serve **both
from a single bridge container** by listing both per-bridge secrets in
`BRIDGE_INSTANCE_SECRETS` and mounting both instances' dirs. (Running one bridge
container per gateway also works — give each its own secret, port, host dirs and
Convex `bridgeUrl`.)

> A bridge process has **one** `user:`. Serving several gateways from one bridge
> therefore requires they share a uid:gid (the case here, both `1000:1000`) — or a
> default ACL `setfacl -d -m o::rX` on the host dirs. If two gateways run as
> different uids and you can't ACL, run one bridge per gateway instead.

**Resolved paths (literal — copy these):**

| | `alpha` | `beta` |
|--|---------|--------|
| Host outbound | `/srv/openclaw/instances/alpha/.openclaw/media/outbound` | `/srv/openclaw/instances/beta/.openclaw/media/outbound` |
| Host inbound | `/srv/openclaw/instances/alpha/.openclaw/media/inbound` | `/srv/openclaw/instances/beta/.openclaw/media/inbound` |
| Bridge outbound target | `/home/node/.openclaw/media/alpha/outbound` | `/home/node/.openclaw/media/beta/outbound` |
| Bridge inbound target | `/home/node/.openclaw/media/alpha/inbound` | `/home/node/.openclaw/media/beta/inbound` |
| Convex `instances.bridgeUrl` | `http://<host>:8787` | `http://<host>:8787` (same bridge) |

**Create the host dirs first, owned by the gateway uid** (else the mount
auto-creates them root-owned and the agent can't read):

```bash
for I in alpha beta; do
  mkdir -p /srv/openclaw/instances/$I/.openclaw/media/{inbound,outbound}
  chown -R 1000:1000 /srv/openclaw/instances/$I/.openclaw/media
done
```

**One bridge service serving both gateways:**

```yaml
services:
  bridge:
    image: ghcr.io/lacneu/atrium-bridge:0.6.0
    user: "1000:1000"                       # = the shared gateway uid
    ports: ["8787:8787"]
    environment:
      # One secret per served instance, minted in each instance's Credentials dialog.
      # Each unlocks ONLY its instance's encrypted gateway URL + creds (fetched from
      # Convex at boot). The instance NAMES below — alpha, beta — are what the bridge
      # resolves from those secrets, and what keys the mount targets.
      - BRIDGE_INSTANCE_SECRETS=${ALPHA_BRIDGE_SECRET},${BETA_BRIDGE_SECRET}
      - CONVEX_HTTP_ACTIONS_URL=http://convex-backend:3211
      - BRIDGE_INGEST_SECRET=${BRIDGE_INGEST_SECRET}
      - BRIDGE_SHARED_SECRET=${BRIDGE_SHARED_SECRET}
      - BRIDGE_PORT=8787
    volumes:
      - /srv/openclaw/instances/alpha/.openclaw/media/outbound:/home/node/.openclaw/media/alpha/outbound:ro
      - /srv/openclaw/instances/alpha/.openclaw/media/inbound:/home/node/.openclaw/media/alpha/inbound
      - /srv/openclaw/instances/beta/.openclaw/media/outbound:/home/node/.openclaw/media/beta/outbound:ro
      - /srv/openclaw/instances/beta/.openclaw/media/inbound:/home/node/.openclaw/media/beta/inbound
```

Then in Atrium: **Settings → Agents → Instances** add `alpha` and `beta`, set each
one's **gateway URL + credentials**, mint each one's **per-bridge secret** (used
above), and set both `bridgeUrl` to this bridge (`http://<host>:8787`); **Settings →
Agents → Bridge → Configure** each → Outbound + Inbound = `shared-fs`.

---

## Procedure (deterministic — for a person or an AI installer)

Per gateway you want on shared-fs, with its `<I>`, `<H>`, `<UID>:<GID>` and the
bridge's `<HOSTPORT>`:

1. **Create + own the host dirs.**
   `mkdir -p <H>/media/{inbound,outbound} && chown -R <UID>:<GID> <H>/media`
2. **Register the instance in Convex** (Settings → Agents → Instances): name = `<I>`
   **exactly**, set its **gateway URL + credentials**, mint its **per-bridge
   secret**, and `bridgeUrl = http://<host>:<HOSTPORT>`.
3. **Add `<I>` to the bridge** serving it: include its per-bridge secret in
   `BRIDGE_INSTANCE_SECRETS`, set `user: "<UID>:<GID>"`, and add the two bind mounts
   (literal `<I>` in the target):
   - `<H>/media/outbound : /home/node/.openclaw/media/<I>/outbound : ro`
   - `<H>/media/inbound  : /home/node/.openclaw/media/<I>/inbound`
   (One bridge can carry several instances — list several secrets and several mount
   pairs; or run a dedicated bridge per gateway on its own `<HOSTPORT>:8787`.)
4. **Recreate the bridge** (a docker mount is not hot):
   `docker compose up -d --force-recreate bridge`
5. **Flip the modes** (hot, no restart): Settings → Agents → Bridge → Configure
   `<I>` → Outbound = `shared-fs`, Inbound = `shared-fs`, set `mediaMaxMb` high
   enough for your largest file.
6. **Verify the paths**: click **“Vérifier les chemins”** in that modal → both legs
   must report OK (it round-trips the bridge's own read/write of its dirs).
7. **Teach the agent the outbound convention** (see Gotchas) and **live-test** both
   directions.

---

## Verify it actually works (don't assume)

- **“Vérifier les chemins”** confirms the bridge can read its outbound dir and
  write its inbound dir. It can only check the **bridge** side (there is no gateway
  filesystem API), so it catches the common misconfig (volume not mounted / wrong
  uid) but not the agent side — that needs a live turn.
- **Outbound live test:** trigger the *real* way your agents produce files (e.g.
  native generation, not just a hand-written `echo`), and confirm the download chip
  appears. This is the discriminating test — the failure mode that motivated
  shared-fs is the agent writing a file that the gateway never signalled.
- **Inbound live test:** upload a file **larger than ~25 MiB** (a video / big doc).
  It must reach the agent by path (not die on the WS frame ceiling) — that is the
  shared-fs reason-to-exist.

---

## Gotchas

- **uid match is load-bearing.** The bridge *writes* inbound files; the gateway's
  agent (its uid) must *read* them. `user:` on the bridge must equal the gateway's
  uid:gid, or inbound fails silently “permission denied”. (Alternative: a default
  ACL `setfacl -d -m o::rX` on the host dirs.)
- **Create the host dirs before recreating.** A bind mount of a missing host dir
  auto-creates it **root-owned** → the agent can't read it. Step 1 prevents this.
- **A docker mount is not hot.** Modes flip live in the UI, but adding the mount /
  `user:` needs `--force-recreate`.
- **The agent must write to `/home/node/.openclaw/media/outbound`.** The dir-scan is
  deterministic only for files that land in the scanned dir. If your agent (e.g.
  codex native image generation) writes to its *workspace* instead, the scan misses
  it. Add to the agent's `AGENTS.md`: *“To deliver a file to the user, write it to
  `/home/node/.openclaw/media/outbound/`.”* (With the dir-scan you no longer need a
  `MEDIA:` line.)
- **Never key the agent path / never edit `allowReadPaths` to a keyed path.** Path 2
  stays flat by design (see “the one rule”).
- **Use simple instance names (`[A-Za-z0-9._-]`).** The bridge sanitizes the name
  into one path segment; a `/` or odd character would make the bridge's derived dir
  and your literal compose mount target disagree → silent ENOENT. Plain names (which
  match the Convex `instances.name` the bridge resolves) avoid it.

---

## One bridge or many? (read this if you have several gateways)

A bridge can serve **one or many** gateways. Each served instance is keyed by its
name (resolved from Convex via its per-bridge secret), so a single bridge keeps every
instance's media in a distinct `/home/node/.openclaw/media/<instance>/{outbound,inbound}`
subtree — list one secret and one mount pair per instance.

Two practical limits push you toward **one bridge per gateway** in some setups:

- **`user:` is per-process.** All instances on one bridge share its uid:gid (fine
  when the gateways do too, or with a default ACL on the host dirs). Gateways on
  different uids that you can't ACL need separate bridges.
- **`OPENCLAW_MEDIA_OUTBOUND_DIR` / `OPENCLAW_INBOUND_DIR` are process-global.** They
  only make sense for a single-instance bridge; with several instances rely on the
  auto-derived keyed paths and don't set them.

When you do run one bridge per gateway, give each its own per-bridge secret, host
dirs, port (`<HOSTPORT>:8787`) and Convex `bridgeUrl`.
