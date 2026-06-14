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

## Docker Compose

Run from a **full repo checkout** (the bootstrap step bundles the Convex
functions from `../convex`; Node is required):

```bash
cd compose
cp .env.example .env          # fill EVERY required value (see comments inside)
docker compose up -d          # convex backend+dashboard + frontend + bridge
./bootstrap-env.sh            # push Convex env, THEN deploy the Convex functions
```

`bootstrap-env.sh` does both halves of "make the empty backend usable": it pushes
the Convex deployment env **and** runs `npx convex deploy` (installing repo deps
on first run). Re-run it after each release.

Open the app at your frontend origin. **The first sign-in from an allowed email
domain becomes the admin** — so set `AUTH_ALLOWED_EMAIL_DOMAINS` (the bootstrap
sets it first) **before** anyone signs in.

### Stateful vs stateless lifecycle

Convex data lives in the named volume `convex-data` and survives container
recreation. Redeploy just the app/bridge without touching the backend:

```bash
docker compose up -d --no-deps --force-recreate frontend bridge
```

(Plain `docker compose up -d` brings up all four services — none declare a
profile.) **Never `docker compose down -v`** unless you intend to wipe the
database (back up first: `npx convex export`).

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
