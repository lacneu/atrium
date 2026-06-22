# Deploying Atrium

Everything is **env-driven**: fill environment variables, bring your own agent
gateway (OpenClaw today; Hermes planned), and run. No code changes, no hard-coded
hosts. Three modes:

| Mode | Path | Status |
|------|------|--------|
| Docker Compose | [`compose/`](./compose/) | ✅ recommended |
| Helm (Kubernetes) | [`helm/`](./helm/) | base chart (+ AKS example), provider-portable |
| Plain Docker | run the two images manually | documented below |

The stack has four parts: **Convex** (self-hosted backend + SQLite, *stateful*),
**Convex dashboard**, the **frontend** (static), and the **bridge** (connects to
your agent gateway). You supply the gateway yourself (OpenClaw today; Hermes
planned).

> **Hitting a snag?** The problems first-time deployers actually hit — private
> GHCR images, the `pkcs8`/JWKS sign-in error, "Loading…" forever, "no agents
> discovered", the Synology volume-wipe pitfall, DNS/proxy gaps — are written up
> with diagnosis + fix in **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)**.

## Pre-flight

- **Make the images pullable.** CI publishes `ghcr.io/<owner>/atrium` and
  `atrium-bridge` to GHCR, **private by default** → make the packages **public**
  (org → Packages → each package → *visibility*) or `docker login ghcr.io` on the
  host, else the pull fails.
- **Public hosts (×3).** You need DNS + a reverse proxy (Traefik/nginx) + TLS for
  the **frontend**, the Convex **cloud** origin, **and** the Convex **site** origin
  (HTTP actions + OAuth callbacks). Forgetting the frontend host is a classic
  "site won't load" cause.
- **OAuth.** Register the redirect URI
  `https://<CONVEX_SITE_ORIGIN>/api/auth/callback/<provider>` and the authorized
  origin `https://<frontend>` in the provider console.

## Gotcha 1: the Convex backend ships EMPTY

The `ghcr.io/get-convex/convex-backend` image is a **generic, empty** backend —
it contains **none of this app's code**. A fresh backend has no queries, no
mutations, no `/bridge/ingest`, no auth callbacks, so the frontend and bridge
cannot work until **this repo's Convex functions are deployed to it** with
`npx convex deploy` (self-hosted: `CONVEX_SELF_HOSTED_URL` +
`CONVEX_SELF_HOSTED_ADMIN_KEY`). This requires a **full repo checkout + Node**
(the functions are bundled from `convex/`).

- **Compose** — `bootstrap-env.sh` does it for you (env **then** deploy).
- **Helm** — the post-install Job sets env only; deploy the functions as a
  separate operator/CI step (see the Helm section).
- **Plain Docker** — run `npx convex deploy` yourself (see below).

Re-run on **every release**: the functions change, so they must be re-pushed.

## Gotcha 2: TWO environment scopes

1. **Container env** — read by the containers; set in `.env` (compose) or the
   chart `values`.
2. **Convex *deployment* env** — read by Convex **functions** via `process.env`.
   These are **not** injected by Docker/Kubernetes; they are pushed into the
   deployment with `convex env set`. The provided **`bootstrap-env.sh`** (compose)
   / **post-install Job** (Helm) does this for you.

This split exists because Convex (self-hosted) keeps its function env in the
deployment, not in the container. The bootstrap step bridges your `.env` into it.

## Gotcha 3: configure each gateway as an instance in Convex

After deploying, add your gateway as an **instance** (Settings → Agents →
Instances): set its **gateway URL**, enter its **operator token + device identity**
under **Credentials** (stored encrypted), and **mint a per-bridge secret**. Put that
secret in the bridge's `BRIDGE_INSTANCE_SECRETS`; the bridge then resolves the
instance by its secret and self-declares it under Settings → Bridge →
Compatibility. Agents appear within ~2 min (a discovery cron) or immediately when
you send the first message.

**Multiple gateways?** Supported, two ways:

- **One bridge, many gateways.** List several per-bridge secrets in
  `BRIDGE_INSTANCE_SECRETS` (comma-separated, one per instance) and the same bridge
  serves them all — fetching each one's gateway URL + credentials from Convex.
- **One bridge per gateway.** Run a separate bridge container per gateway, each with
  its own secret, port and Convex **Bridge URL**, routing each instance's chats to
  its own bridge.

**As soon as you serve more than one instance** (either layout), give EACH instance
its own **Bridge URL** (Settings → Agents → Instances → Bridge URL) — for the
one-bridge case, point them ALL at that bridge (e.g. `http://bridge:8787`). Convex
dispatch only falls back to the env `BRIDGE_URL` for the *sole or env-named* instance
(so a second instance never silently routes to the wrong gateway in the
one-bridge-per-gateway layout); an extra instance left without a Bridge URL is
reported `not_configured` rather than dispatched. A worked one-bridge-two-instances
example (with shared-fs media) is in [SHARED_FS_MEDIA.md](./SHARED_FS_MEDIA.md).

## Gateway credentials come from Convex

Each gateway's **URL**, **version**, optional **HTTP override**, **operator token**
and **Ed25519 device identity** are configured in Convex (**Settings → Agents →
Instances**; the token + device identity under **Credentials**, stored
AES-256-GCM-encrypted in the `instanceSecrets` table, never plaintext). The bridge
reads **none** of these from its environment — it fetches them at boot. Operators
add and rotate credentials from the web UI; no secrets live in the bridge env, and
no redeploy is needed to change a token (a rotation takes effect on the **next
bridge restart**).

The irreducible env anchor is the **per-bridge secret** — one per served instance,
listed in `BRIDGE_INSTANCE_SECRETS`. This is **not** zero-ops: each served gateway
still needs its own secret in the bridge env. Decryption also requires
`ATRIUM_SECRET_KEY` on the Convex deployment (the master key that encrypts the
credentials; see `.env.example` section B). A per-bridge secret binds the bridge to
**its** instance, so it can only fetch **that** instance's credentials (it is **not**
the shared `BRIDGE_INGEST_SECRET`). If a credential is missing from Convex, or a
secret fails to resolve, the bridge fails fast with a clear error.

**Setting up an instance:**

1. Set `ATRIUM_SECRET_KEY` on the Convex deployment if not already (back it up —
   losing it makes stored credentials unrecoverable). For compose, fill it in
   `.env` section B and re-run `./bootstrap-env.sh`.
2. **Settings → Agents → Instances → (your instance)**: set its **gateway URL** (and
   version / HTTP override if needed) and its **Bridge URL** (the bridge that serves
   it). Under **Credentials**, enter the operator token and device identity. They are
   write-only (a stored value is never shown again — only “Configuré”).
3. In the same dialog, under **“Secret du bridge”**, **mint** a per-bridge secret.
   It is shown **once** — copy it.
4. In the bridge env, set **`BRIDGE_INSTANCE_SECRETS`** to that secret (or a
   comma-separated list for several instances). The bridge reads NO gateway env —
   gateway URL + version + credentials all come from Convex.
5. Recreate the bridge: `docker compose up -d --no-deps --force-recreate bridge`.
   On boot it fetches the decrypted credentials from Convex over the authenticated
   channel and connects. The boot log reports how many instances it is serving.

## Hardening

Before going live (the security model + scope are in [`SECURITY.md`](../SECURITY.md);
the SOC2 control mapping in [`compliance/`](../compliance/)):

- Set `AUTH_ALLOWED_EMAIL_DOMAINS` **before** anyone signs in — the first sign-in
  from an allowed domain becomes admin.
- Generate and **back up** the secrets you cannot regenerate: `ATRIUM_SECRET_KEY`
  (lose it and every Convex-stored credential is unrecoverable), the Convex auth
  keys (`JWT_PRIVATE_KEY`/`JWKS`), and the Convex instance secret.
- Generate strong, unique server-to-server secrets (`openssl rand -hex 32`); mint a
  **distinct per-bridge** credential-fetch secret for each served instance (in
  `BRIDGE_INSTANCE_SECRETS`), so each unlocks only its own gateway's credentials.
- Mount the gateway media directory **read-only** into the bridge.
- Terminate TLS upstream (reverse proxy / ingress) and ensure WebSocket upgrade
  support for the bridge ↔ gateway connection.
- Do **not** expose the Convex dashboard publicly (bind it to localhost or a
  LAN-only proxy).
- Scope service-account API keys to the least permission they need, and rotate any
  secret that may have leaked into logs.

## Media: file delivery & ingestion

By default the bridge moves files over HTTP (**gateway-http** mode) — no shared
filesystem, works when Atrium and the gateway are on different hosts. For
**deterministic** downloads (the agent produces a file you reliably get) and
**large** uploads (video/audio/big docs past the WebSocket frame ceiling), enable
**shared-fs** — Atrium and the gateway share the gateway's media dirs on disk. The
full setup, the four-path model, the per-instance mount convention, a worked
one-bridge-two-instances example and a deterministic install procedure are in
**[SHARED_FS_MEDIA.md](./SHARED_FS_MEDIA.md)**.

## Docker Compose

Run from a **full repo checkout** (the bootstrap step bundles the Convex
functions from `../convex`; Node is required):

```bash
cd compose
cp .env.example .env          # fill EVERY required value (see comments inside)
node generate-auth-keys.mjs   # writes jwt_private_key.pem + jwks.json (the @convex-dev/auth pair)
docker compose up -d          # convex backend+dashboard + frontend + bridge
./bootstrap-env.sh            # push Convex env, THEN deploy the Convex functions
```

The `JWT_PRIVATE_KEY` / `JWKS` pair is **multiline**, so `.env.example` exposes
only the `*_FILE` form (a dotenv line can't hold a multiline PEM — pasting one
inline is the usual cause of the `pkcs8` sign-in error). `generate-auth-keys.mjs`
writes a valid matching pair with no dependencies; the default `*_FILE` paths in
`.env.example` already point at its output.

`bootstrap-env.sh` does both halves of "make the empty backend usable": it pushes
the Convex deployment env **and** runs `npx convex deploy` (installing repo deps
on first run). Re-run it after each release.

Open the app at your frontend origin. **The first sign-in from an allowed email
domain becomes the admin** — so set `AUTH_ALLOWED_EMAIL_DOMAINS` (the bootstrap
sets it first) **before** anyone signs in.

> **No Node on the host (e.g. CI)?** Only minting the admin key needs the host;
> the env push + function deploy run from **any** machine with Node + a checkout,
> against the backend over the network:
> ```bash
> docker exec <project>-convex-backend ./generate_admin_key.sh   # on the host — copy the key
> export CONVEX_SELF_HOSTED_URL=https://convex.example.com CONVEX_SELF_HOSTED_ADMIN_KEY=<key>
> npx convex deploy                       # functions (run from the repo root)
> deploy/compose/convex-env-push.sh       # push the Convex deployment env from .env (no docker)
> ```
> In a pipeline these two commands are the deploy job; the URL + admin key are CI
> secrets. (`convex-env-push.sh` is the docker-free half of `bootstrap-env.sh`.)

### Stateful vs stateless lifecycle

Convex data lives in the named volume `convex-data` and survives container
recreation. Redeploy just the app/bridge without touching the backend:

```bash
docker compose up -d --no-deps --force-recreate frontend bridge
```

(Plain `docker compose up -d` brings up all four services — none declare a
profile.) **Never `docker compose down -v`** unless you intend to wipe the
database (back up first: `npx convex export`). On **Synology Container Manager**,
CM and a shell can disagree on the compose project name, so a CLI `down -v` may
remove the **wrong** volume (leaving your data intact under another name) — verify
the real one first:
`docker inspect <project>-convex-backend --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}'`
(details in [TROUBLESHOOTING.md](../deploy/TROUBLESHOOTING.md)).

## Helm (Kubernetes)

Convex is modeled as a **single-replica StatefulSet with a PVC** (it is not
horizontally scalable); the frontend and bridge are Deployments; the env
bootstrap runs as an ordered `post-install`/`post-upgrade` Job. Secrets come from
a Kubernetes `Secret`. `ingressClassName`, `storageClassName` and the secret
source are `values` — portable across providers. See [`helm/`](./helm/) and the
AKS example values there.

> **Deploy the Convex functions (required).** The post-install Job sets the
> Convex deployment env **only** — it does **not** push this repo's functions
> (the cluster Job has no access to the `convex/` source). After `helm install`,
> deploy the functions from your checkout against the in-cluster backend (or do
> it from CI):
>
> ```bash
> kubectl port-forward svc/<release>-convex-backend 3210:3210 &
> ADMIN_KEY=$(kubectl exec <release>-convex-backend-0 -- ./generate_admin_key.sh | tr -d '\r' | tail -n1)
> CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
> CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
>   npx convex deploy          # from the repo root, re-run each release
> ```

## Plain Docker (manual)

Run `ghcr.io/get-convex/convex-backend` + the two app images
(`${WEBCHAT_IMAGE}`, `${BRIDGE_IMAGE}`) with the same env as `compose/.env.example`,
on one network so the bridge reaches Convex by name, then run the equivalent of
`bootstrap-env.sh` — i.e. mint the admin key, `npx convex env set` the
deployment vars, **and `npx convex deploy` the functions** (from a repo checkout,
with `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY`). The Compose file
and `bootstrap-env.sh` are the reference for the exact wiring.

## Images & versions

The frontend and bridge images are **lockstep-versioned** (one repo version on
both): deploy `${WEBCHAT_TAG}` and `${BRIDGE_TAG}` at the **same** version. The
supported OpenClaw/Hermes gateway versions for a given release are listed in the
release notes.
