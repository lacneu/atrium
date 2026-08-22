# Installing Atrium — which profile fits you

Atrium is **three pieces plus a gateway you bring**:

| Piece | What it is |
|---|---|
| **Convex backend** | The reactive database and server functions. Owns chats, auth, routing and observability. Ships as a container, and **ships empty**. |
| **Frontend** | A static React app. Reads Convex only; it never sees a gateway frame. |
| **Bridge** | A Node process holding the connection to your agent gateway, normalizing its version-specific event stream. The only component that ever holds gateway credentials. |
| *Your agent gateway* | **Not part of Atrium.** An OpenClaw or Hermes instance you already run. Atrium never runs a model. |

There is no bundled gateway, and neither profile below installs one.

**Two ways to run those pieces**, each with its own ordered procedure:

| Method | Procedure | Fits |
|---|---|---|
| **Docker Compose** | **[COMPOSE.md](COMPOSE.md)** | One host. The shortest path to a running stack, and what most deployments use. |
| **Helm (Kubernetes)** | **[HELM.md](HELM.md)** | An existing cluster. Same four components, shaped as a StatefulSet, three Deployments and a bootstrap Job. |

The method is independent of the profile below: both profiles work either way.
What changes between the profiles is *what you put around* the install — not the
procedure.

Working on Atrium's own code is a different activity with a different guide:
[../DEVELOPMENT.md](../DEVELOPMENT.md).

---

## Choose

| | **Discovery** | **Production** |
|---|---|---|
| **You want to** | See whether Atrium suits you | Run Atrium for a team |
| **You need** | A gateway you already run, Docker, one host | A host or a cluster, TLS, a backup destination |
| **You run** | Docker Compose, defaults | Docker Compose or Helm, hardened |
| **Data** | A named volume you can throw away | A volume you back up, and exports you have restored at least once |
| **Auth** | Whatever domain you allow first | Domain-restricted, set before anyone signs in |

Both install the same way. The difference is not the procedure — it is what you
put around it.

---

## Discovery — evaluate it against the gateway you already have

The fastest honest path, because the deployment stack contains **no gateway
image**: four containers (Convex backend, Convex dashboard, frontend, bridge)
that talk to the OpenClaw or Hermes instance you already run.

Follow **[COMPOSE.md](COMPOSE.md)** end to end — it is the shortest path, and
nothing in it is production-only. If your cluster is where you evaluate things,
**[HELM.md](HELM.md)** gets you the same result.

**What this gives you:** a working multi-user chat over your gateway, streaming
replies, file exchange, and the observability surface — on one host, with
throwaway data.

**What this does not give you:** TLS, backups, or a restricted sign-in domain.
Do not put a discovery install in front of people who are not evaluating it.

**The two things that trip up almost every first install** — both explained in
the runbook, repeated here because skipping them costs an hour:

1. **There are two environment scopes**, and they are not interchangeable: the
   variables the containers read, and the variables the *Convex deployment*
   reads. Setting one where the other is expected fails silently. See
   [`deploy/README.md`](../../deploy/README.md) → *Gotcha 2*.
2. **The Convex backend ships empty.** Bringing the image up is not deploying the
   application; `npx convex deploy` is a separate step, and re-run on every
   release.

---

## Production — run it for a team

The install is the same procedure — [COMPOSE.md](COMPOSE.md) or
[HELM.md](HELM.md). What production adds is everything *around* it. What applies
to both methods — the pre-flight, the gotchas, how gateway credentials reach the
bridge, hardening, media — is in
[`deploy/README.md`](../../deploy/README.md).

Before you go live, four facts decide whether the deployment survives:

- **`AUTH_ALLOWED_EMAIL_DOMAINS` is a one-shot door.** The first sign-in from an
  allowed domain becomes admin. Set it *before* anyone signs in, not after.
- **Three secrets cannot be regenerated.** `ATRIUM_SECRET_KEY` (lose it and every
  gateway credential stored in Convex is unrecoverable), the Convex auth keys
  (`JWT_PRIVATE_KEY` / `JWKS`), and the Convex instance secret. Back them up as
  part of the install, not as a follow-up.
- **`docker compose down -v` wipes the database.** Back up first with
  `npx convex export`. On Synology Container Manager the CLI and the UI can
  disagree about the compose project name, so a `down -v` may remove the *wrong*
  volume — verify the real one before running it
  ([`deploy/TROUBLESHOOTING.md`](../../deploy/TROUBLESHOOTING.md)).
- **On Helm, the post-install Job sets the Convex environment only** — it does not
  push this repository's functions, so a deployment that stops there comes up with
  an empty backend. And **an empty `CONVEX_INSTANCE_SECRET` fails silently**: the
  backend generates one, the Job derives a different admin key, and every
  environment write returns `401`. Both are steps in [HELM.md](HELM.md).

The full hardening list — TLS termination with WebSocket upgrade, read-only media
mounts, a distinct per-bridge credential secret per served instance, keeping the
Convex dashboard off the public internet, least-privilege API keys — is in
[`deploy/README.md`](../../deploy/README.md) under *Hardening*. The security model
and its scope are in [`SECURITY.md`](../../SECURITY.md); the SOC 2 control mapping
and the software-versus-operator boundary are in
[`compliance/`](../../compliance/).

### Backing it up

Three things have to survive a host loss, and they are backed up differently:

| What | How |
|---|---|
| **The conversations and all application data** | `npx convex export --include-file-storage --path <snapshot>.zip` against the deployment |
| **The three unregenerable secrets** | Wherever you keep secrets — they are not in the export |
| **The gateway credentials** | They live encrypted in Convex, so the export carries them, but only `ATRIUM_SECRET_KEY` can decrypt them again |

`--include-file-storage` is not the default, and without it **uploaded files are
not in the snapshot** — you get the conversations that reference them and nothing
to open. Pass it.

Against a self-hosted backend, point the CLI at it with
`CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`, the same pair the
deploy guide uses to push functions.

A snapshot you have never restored is a hypothesis. Restore one into a throwaway
deployment — a discovery install is exactly the right place — before you need it.

**What this does not give you:** horizontal scale. Convex runs as a single
replica with a persistent volume — a StatefulSet under Helm — and is not
horizontally scalable. The frontend and the bridge are ordinary Deployments and
scale normally.

**Isolation between tenants** is achieved by giving each tenant its own Convex
deployment, with separate auth and separate secrets. One deployment serves one
tenant; there is no adversarial tenant partitioning inside a single backend.

---

## Checking the install rather than assuming it

`deploy/compose/preflight.sh` reads your environment and your compose file and
reports what is wrong before you start anything. It changes nothing and exits
non-zero when it finds a problem, so it is safe to run at any point — and it is
the first thing to run when something does not work.

The runbook's own verification section tells you, per step, what proves it
worked. Where a step cannot be verified from inside the repository — your
registry access, your host actually running containers — it says so instead of
implying a guarantee.
