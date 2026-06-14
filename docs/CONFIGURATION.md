# Configuration

Atrium is fully **environment-driven**: no hard-coded hosts, no code
changes to deploy. The single most important thing to understand is that there
are **two environment scopes**, and they are not interchangeable.

> The canonical, copy-and-fill reference is
> [`deploy/compose/.env.example`](../deploy/compose/.env.example). This page
> explains what each variable is for. The bridge's own variables are documented
> in [`bridge/.env.example`](../bridge/.env.example).

## The two scopes

1. **Container env** — read directly by the running containers (the static
   front end and the bridge). With Docker Compose these come from your `.env`;
   with Helm they come from `values`.

2. **Convex *deployment* env** — read by Convex **functions** via `process.env`.
   These are **not** injected by Docker or Kubernetes; they are pushed into the
   deployment with `convex env set`. The provided `bootstrap-env.sh` (Compose) /
   post-install Job (Helm) does this for you from the same `.env`.

This split exists because self-hosted Convex keeps its function environment in
the deployment, not in the container. The run order is: fill `.env` → bring the
stack up → run the bootstrap step.

## Container env

### Frontend image

| Variable | Required | Description |
| --- | --- | --- |
| `CONVEX_URL` | yes | Public Convex **cloud** origin the browser reaches. The image entrypoint writes it into `/config.json` at boot; the SPA reads that at runtime. The image is origin-agnostic and fails fast if this is unset. |

### Convex backend (self-hosted)

| Variable | Required | Description |
| --- | --- | --- |
| `CONVEX_INSTANCE_NAME` | yes | Backend instance name. |
| `CONVEX_INSTANCE_SECRET` | yes | Strong random secret that mints the admin keys — generate (`openssl rand -hex 32`) and **back it up**. |
| `CONVEX_CLOUD_ORIGIN` | yes | Public HTTPS origin for the cloud (queries/mutations) endpoint, as reached by the browser. |
| `CONVEX_SITE_ORIGIN` | yes | Public HTTPS origin for the site (HTTP actions / `.site`) endpoint. |

### Bridge

| Variable | Required | Description |
| --- | --- | --- |
| `OPENCLAW_GATEWAY_URL` | yes | Your OpenClaw gateway URL (`ws[s]://`; `http[s]://` is rewritten). |
| `OPENCLAW_TOKEN` | yes | Operator bearer token for the gateway. |
| `OPENCLAW_DEVICE_IDENTITY` | yes | Ed25519 device identity as inline JSON (`{"id","publicKey","privateKey":"<PEM PKCS#8>"}`). |
| `OPENCLAW_INSTANCE_NAME` | yes | The instance name this bridge serves. Must equal the Convex `instances.name` row and the Convex `BRIDGE_INSTANCE_NAME`. |
| `OPENCLAW_GATEWAY_VERSION` | recommended | Configured gateway version (`YYYY.M.P`); a fallback the bridge uses for capabilities before a live session has reported the real version. |
| `OPENCLAW_MEDIA_OUTBOUND_DIR` | yes for media | In-container path to the gateway's outbound media dir (mounted read-only). |
| `CONVEX_HTTP_ACTIONS_URL` | yes | Convex `.site` (HTTP actions) origin the bridge ingests into. Inside one Docker network this is a service-name URL. |
| `BRIDGE_INGEST_SECRET` | yes | Bearer secret the bridge presents to Convex's ingest endpoint. **Must equal** the Convex-scoped value. |
| `BRIDGE_SHARED_SECRET` | yes | Secret Convex presents to the bridge's `POST /send` (and `/patch`, `/reset`, …). **Must equal** the Convex-scoped value. |
| `BRIDGE_PORT` | optional | Bridge HTTP port (default `8787`). |
| `BRIDGE_MAX_BODY_BYTES` | optional | Max accepted `POST /send` body size (default 32 MiB). |

## Convex deployment env

Pushed by `bootstrap-env.sh` (or the Helm Job) via `convex env set`.

### Authentication

| Variable | Required | Description |
| --- | --- | --- |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | yes | Comma-separated allowed sign-in domains. **Set before anyone signs in** — the first sign-in from an allowed domain becomes admin. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | for Google | Google OAuth client credentials. |
| `AUTH_MICROSOFT_ID` / `AUTH_MICROSOFT_SECRET` / `AUTH_MICROSOFT_TENANT_ID` | optional | Microsoft Entra OAuth (leave blank to disable). |
| `JWT_PRIVATE_KEY` | yes | `@convex-dev/auth` signing key (PEM with real newlines). |
| `JWKS` | yes | `@convex-dev/auth` public JWKS (raw JSON). |
| `SITE_URL` | yes | Public site URL used for OAuth callbacks (usually the front end's public origin). |

### Bridge wiring (Convex side)

| Variable | Required | Description |
| --- | --- | --- |
| `BRIDGE_URL` | yes | Base URL Convex uses to reach the bridge worker (a service-name URL inside one Docker network). |
| `BRIDGE_INSTANCE_NAME` | yes | The instance the poller targets; must match the bridge's `OPENCLAW_INSTANCE_NAME` and the `instances.name` row. |
| `BRIDGE_INGEST_SECRET` | yes | Same value as the bridge's container env. |
| `BRIDGE_SHARED_SECRET` | yes | Same value as the bridge's container env. |

### Optional trace shipping

Leave blank to disable. Keys live in the Convex deployment env, not the bridge.

| Variable | Description |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | Langfuse trace export. |
| `OPIK_API_KEY` / `OPIK_WORKSPACE` / `OPIK_BASE_URL` | Opik trace export. |

## Secrets discipline

Generate each shared secret with `openssl rand -hex 32`. Never commit a `.env`
file, an instance secret, an auth key, or a gateway token. See
[SECURITY.md](../SECURITY.md).
