# Installing Atrium with Docker Compose — the ordered runbook

This page is written to be followed **literally**, by a person or by an agent.
Every step states its precondition, the exact command, and how you know it
worked. Where a step cannot be verified from inside the repository — your
registry access, your host actually running containers — this page says so
rather than implying success; everything it CAN pin, it pins with a test.

For *what each variable means*, see [CONFIGURATION.md](../CONFIGURATION.md). This
page is the **order**; that one is the **reference**. Do not read them in the
other direction: filling `.env` without understanding the two scopes is the
mistake that costs the most time.

---

## What you are installing, and why it has three pieces

Atrium is not one process. Understanding the split takes two minutes and saves
an afternoon:

| Piece | What it does | Fails how, when misconfigured |
|---|---|---|
| **Convex** (self-hosted backend + dashboard) | Holds every conversation, message, trace and instance. Runs the server functions. | The UI loads and stays empty, or writes are refused. |
| **Front end** (static image) | The web client. Talks only to Convex. | A blank page, or a client that cannot reach its backend. |
| **Bridge** | The only piece that talks to a gateway. Sends turns out, streams replies back into Convex. | Everything looks healthy and **sending does nothing**. |

The bridge is where installation mistakes hide, because it fails *late*: the
stack comes up, the UI works, and the first message goes nowhere.

**A gateway is not installed here.** Atrium connects to an OpenClaw (or Hermes)
gateway you already run. If you have none, install that first — Atrium has
nothing to talk to without it.

---

## Step 0 — Preconditions

```bash
docker compose version && node -v && openssl version
```

**Expected:** Compose **v2** (`docker-compose` v1 is not supported), Node ≥ 20 for
the local scripts (the images build on Node 24), and any OpenSSL.

*What no document can check for you: that your Docker may pull the release
images. That depends on your registry access and is exercised at Step 4.*

---

## Step 1 — Get the files and choose your version

```bash
git clone https://github.com/lacneu/atrium.git && cd atrium
git checkout v0.74.4          # or the release you intend to run
```

Every artifact of a release carries **the same version** — front end, bridge and
the two npm packages move in lockstep. Pin one tag across all of them; mixing a
`latest` front end with a pinned bridge is a supported-looking configuration that
nobody tests.

---

## Step 2 — Prepare the environment file

```bash
cd deploy/compose && cp .env.example .env
```

Now fill it. Two rules decide almost everything:

1. **There are two scopes.** Some variables are read by the containers, others by
   Convex *functions* — and the second group is not injected by Docker at all.
   `bootstrap-env.sh` pushes them in Step 5. Skipping that step produces a stack
   that starts and then fails at runtime.
2. **`CONVEX_HTTP_ACTIONS_URL` is the HTTP-actions origin, not the API origin.**
   They differ by port when self-hosted. Getting this wrong makes every ingest
   404 while everything else looks fine.

Generate the secrets rather than inventing them:

```bash
openssl rand -hex 32
```

Generate the auth key pair in one run — the private key and the JWKS must match:

```bash
node deploy/compose/generate-auth-keys.mjs
```

**Why a script rather than two pasted values.** `JWT_PRIVATE_KEY` and `JWKS` are
**multiline**, and a dotenv line cannot hold a multiline PEM. Pasting one inline is
the usual cause of the `pkcs8` error at sign-in. That is why `.env.example` exposes
only the `*_FILE` form, and its default paths already point at this script's
output.

---

## Step 3 — Preflight

```bash
./preflight.sh
```

Read-only. It checks the tooling, every required variable of **both** scopes, and
the coherence traps that fail silently — including the media-mount trap, where
host directories are declared in `.env` while the matching volumes are still
commented out in `docker-compose.yml`.

**Expected:** `0 failure(s)` and exit code `0`. Anything else is a stop, not a
warning to note and move past.

*The script's four outcome paths — missing file, incomplete env, clean env, and
the media trap — are pinned by `bridge/test/preflight.test.ts`, so its verdicts
cannot silently rot as the stack evolves.*

---

## Step 4 — Bring the stack up

```bash
docker compose up -d
```

**Expected:** the Convex backend, the dashboard, the front end and the bridge all
`Up`. Check with `docker compose ps`.

*The compose file's syntax is machine-checkable (`docker compose config -q`);
whether the containers come up depends on your host, and only `docker compose ps`
answers that.*

---

## Step 5 — Push the Convex-scope variables

```bash
./bootstrap-env.sh
```

This is the step people skip. It reconciles the deployment environment from the
same `.env`. It is idempotent: re-run it after any change to a Convex-scope
variable.

One behaviour to know before running it: `ATRIUM_PROVISION_KEYS` is
**declarative**. Present-but-empty means *revoke every declared provisioner*;
absent means *leave Convex alone*. Those are opposite intentions and the script
treats them as such.

---

## Step 6 — Deploy the Convex functions

```bash
npx convex deploy
```

The code and the environment are **separate deployments**. Pushing variables does
not ship functions, and shipping functions does not push variables. A release that
adds an index or a schema field needs this before the images that write to it.

### No Node on the host — steps 5 and 6 from a pipeline

Only minting the admin key needs the host. The env push and the function deploy
run from **any** machine with Node and a checkout, against the backend over the
network:

```bash
docker exec <project>-convex-backend ./generate_admin_key.sh   # on the host — copy the key
export CONVEX_SELF_HOSTED_URL=https://convex.example.com CONVEX_SELF_HOSTED_ADMIN_KEY=<key>
npx convex deploy                       # step 6, from the repo root
deploy/compose/convex-env-push.sh       # step 5, without docker
```

In a pipeline those two commands are the deploy job, and the URL plus the admin
key are CI secrets. `convex-env-push.sh` is the docker-free half of
`bootstrap-env.sh`.

---

## Step 7 — First sign-in

Open the front end. Sign in with an address in `AUTH_ALLOWED_EMAIL_DOMAINS`.

If you are refused: that variable still holds its placeholder default. It is the
single most common Step-7 failure, and the preflight fails on it for that reason.

---

## Step 8 — Connect a gateway

In the UI: **Settings → Agents → Instances**. Add the instance, set its gateway
URL and credentials, and **mint its per-bridge secret** — it is shown once. Put it
in `BRIDGE_INSTANCE_SECRETS` and recreate the bridge:

```bash
docker compose up -d --force-recreate bridge
```

Then enable the agents you want. **Enabling an agent is what exposes it**:
visibility is authorisation by default, and attribution is not a second lock.

---

## Step 9 — Media, only if you share a filesystem

Skip this unless Atrium and the gateway share a disk. If they do, read
[`deploy/SHARED_FS_MEDIA.md`](../../deploy/SHARED_FS_MEDIA.md) **in full** before
setting anything. Four paths are in play, exactly one may be keyed by instance,
and a wrong value does not raise an error — the files are written and nobody ever
sees them.

The short version: the agent's path stays **flat**, the bridge's is **keyed by
instance**, and both bind the **same host directory**.

---

## Verifying the install, rather than assuming it

Send one message to a connected agent and watch the reply stream. That single
round trip exercises the front end, Convex, both secrets, the bridge and the
gateway. Nothing short of it proves the install.

Then, for the parts a message does not cover:

```bash
docker compose logs --tail=50 bridge
```

A healthy bridge logs its served instances at boot. If it logs none, its
per-instance secret never resolved — which is Step 8, not Step 4.

---

## Lifecycle — what is stateful and what is not

Convex data lives in the named volume `convex-data` and survives container
recreation. Redeploy the stateless tier without touching the backend:

```bash
docker compose up -d --no-deps --force-recreate frontend bridge
```

A plain `docker compose up -d` brings up all four services — none declares a
profile.

**Never `docker compose down -v`** unless you intend to wipe the database. Back up
first with `npx convex export --include-file-storage --path <snapshot>.zip`.

On **Synology Container Manager**, the UI and a shell can disagree about the
compose project name, so a CLI `down -v` may remove the **wrong** volume — leaving
your data intact under another name while destroying something else. Verify which
volume is really attached before running it:

```bash
docker inspect <project>-convex-backend --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}'
```

---

## Without Compose

The same four containers run by hand: `ghcr.io/get-convex/convex-backend` plus the
two application images, on one network so the bridge reaches Convex by name, with
the same environment as `deploy/compose/.env.example`. Then do what
`bootstrap-env.sh` does — mint the admin key, `npx convex env set` the deployment
variables, **and `npx convex deploy` the functions** from a checkout with
`CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`.

The compose file and `bootstrap-env.sh` are the reference for the exact wiring;
there is no separate specification to follow.

---

## If something is wrong

[`deploy/TROUBLESHOOTING.md`](../../deploy/TROUBLESHOOTING.md) is organised by
symptom. Start there rather than by re-reading this page: the failures worth
naming are the ones where the stack looks healthy.
