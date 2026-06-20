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
by instance means several per-gateway bridges never collide on a shared host and
each container's mount is self-documenting. The bridge derives it automatically
from `OPENCLAW_INSTANCE_NAME` — you set the name, the path follows.

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
| Bridge env: instance name | `OPENCLAW_INSTANCE_NAME=<I>` |
| Bridge env: run-as uid | `user: "<UID>:<GID>"` (match the gateway) |
| Bridge mount (outbound) | `<H>/media/outbound  →  /home/node/.openclaw/media/<I>/outbound  :ro` |
| Bridge mount (inbound) | `<H>/media/inbound  →  /home/node/.openclaw/media/<I>/inbound` |
| Atrium UI | Settings → Agents → Bridge → Configure `<I>` → Outbound **and** Inbound = `shared-fs` |

The bridge auto-derives its read/write dirs from `OPENCLAW_INSTANCE_NAME`, so they
**equal** the mount targets above with no extra env. (Override only if you mount
elsewhere: `OPENCLAW_MEDIA_OUTBOUND_DIR` / `OPENCLAW_INBOUND_DIR`.)

---

## Worked example — two gateways `alpha` and `beta`

A host runs two OpenClaw gateways. Each keeps its state under
`/srv/openclaw/instances/<name>/.openclaw` and runs as `1000:1000`. We run **one
bridge container per gateway** (Model M).

**Resolved paths (literal — copy these):**

| | `alpha` | `beta` |
|--|---------|--------|
| Host outbound | `/srv/openclaw/instances/alpha/.openclaw/media/outbound` | `/srv/openclaw/instances/beta/.openclaw/media/outbound` |
| Host inbound | `/srv/openclaw/instances/alpha/.openclaw/media/inbound` | `/srv/openclaw/instances/beta/.openclaw/media/inbound` |
| Bridge outbound target | `/home/node/.openclaw/media/alpha/outbound` | `/home/node/.openclaw/media/beta/outbound` |
| Bridge inbound target | `/home/node/.openclaw/media/alpha/inbound` | `/home/node/.openclaw/media/beta/inbound` |
| Bridge port | `8787` | `8788` |
| Convex `instances.bridgeUrl` | `http://<host>:8787` | `http://<host>:8788` |

**Create the host dirs first, owned by the gateway uid** (else the mount
auto-creates them root-owned and the agent can't read):

```bash
for I in alpha beta; do
  mkdir -p /srv/openclaw/instances/$I/.openclaw/media/{inbound,outbound}
  chown -R 1000:1000 /srv/openclaw/instances/$I/.openclaw/media
done
```

**Two bridge services** (one per gateway):

```yaml
services:
  bridge-alpha:
    image: ghcr.io/lacneu/atrium-bridge:0.4.2
    user: "1000:1000"                       # = the gateway uid
    ports: ["8787:8787"]
    environment:
      - OPENCLAW_GATEWAY_URL=wss://alpha.example.com
      - OPENCLAW_TOKEN=${ALPHA_TOKEN}
      - OPENCLAW_DEVICE_IDENTITY=${ALPHA_DEVICE_IDENTITY}
      - OPENCLAW_INSTANCE_NAME=alpha        # ← derives /home/node/.openclaw/media/alpha/{outbound,inbound}
      - CONVEX_HTTP_ACTIONS_URL=http://convex-backend:3211
      - BRIDGE_INGEST_SECRET=${BRIDGE_INGEST_SECRET}
      - BRIDGE_SHARED_SECRET=${BRIDGE_SHARED_SECRET}
      - BRIDGE_PORT=8787
    volumes:
      - /srv/openclaw/instances/alpha/.openclaw/media/outbound:/home/node/.openclaw/media/alpha/outbound:ro
      - /srv/openclaw/instances/alpha/.openclaw/media/inbound:/home/node/.openclaw/media/alpha/inbound

  bridge-beta:
    image: ghcr.io/lacneu/atrium-bridge:0.4.2
    user: "1000:1000"
    ports: ["8788:8787"]                    # distinct host port
    environment:
      - OPENCLAW_GATEWAY_URL=wss://beta.example.com
      - OPENCLAW_TOKEN=${BETA_TOKEN}
      - OPENCLAW_DEVICE_IDENTITY=${BETA_DEVICE_IDENTITY}
      - OPENCLAW_INSTANCE_NAME=beta
      - CONVEX_HTTP_ACTIONS_URL=http://convex-backend:3211
      - BRIDGE_INGEST_SECRET=${BRIDGE_INGEST_SECRET}
      - BRIDGE_SHARED_SECRET=${BRIDGE_SHARED_SECRET}
      - BRIDGE_PORT=8787                     # in-container port is always 8787
    volumes:
      - /srv/openclaw/instances/beta/.openclaw/media/outbound:/home/node/.openclaw/media/beta/outbound:ro
      - /srv/openclaw/instances/beta/.openclaw/media/inbound:/home/node/.openclaw/media/beta/inbound
```

Then in Atrium: **Settings → Agents → Instances** add `alpha` (bridgeUrl
`http://<host>:8787`) and `beta` (bridgeUrl `http://<host>:8788`); **Settings →
Agents → Bridge → Configure** each → Outbound + Inbound = `shared-fs`.

---

## Procedure (deterministic — for a person or an AI installer)

Per gateway you want on shared-fs, with its `<I>`, `<H>`, `<UID>:<GID>`,
`<HOSTPORT>`:

1. **Create + own the host dirs.**
   `mkdir -p <H>/media/{inbound,outbound} && chown -R <UID>:<GID> <H>/media`
2. **Run a bridge container for `<I>`** with `user: "<UID>:<GID>"`,
   `OPENCLAW_INSTANCE_NAME=<I>`, its own `<HOSTPORT>:8787`, the gateway
   URL/token/device-identity, the Convex `.site` URL + the two bridge secrets, and
   the two bind mounts:
   - `<H>/media/outbound : /home/node/.openclaw/media/<I>/outbound : ro`
   - `<H>/media/inbound  : /home/node/.openclaw/media/<I>/inbound`
3. **Register the instance in Convex** (Settings → Agents → Instances): name = `<I>`
   **exactly**, `bridgeUrl = http://<host>:<HOSTPORT>`.
4. **Recreate the bridge** (a docker mount is not hot):
   `docker compose up -d --force-recreate bridge-<I>`
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
  and the compose `${OPENCLAW_INSTANCE_NAME}` mount disagree → silent ENOENT. Plain
  names (which also match the Convex `instances.name`) avoid it.

---

## Model-M assumption (read this if you have many gateways)

This design is **one bridge container per gateway**. A bridge process serves **one**
instance’s media (`OPENCLAW_INSTANCE_NAME` is process-global), so N gateways = N
bridge containers, each with its own name, port, host dirs and Convex `bridgeUrl`.
The instance-keyed bridge path keeps their internal mounts distinct even on a shared
host. A *single* bridge serving several gateways is **not** how this works — don't
try to mount multiple instances into one bridge.
