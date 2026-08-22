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

Putting a Convex-scope variable only in the container env is the single most
common installation mistake: the container starts, the UI loads, and the feature
that needed it fails at runtime with no startup error to point at.

## How to read this page

Every table below has the same columns, and they mean exactly this:

- **Required** — `yes` means the process **refuses to start** without it (for the
  bridge these are the four `requireEnv` reads). `no` means there is a default or
  the feature it enables simply stays off.
- **Default** — the value the code falls back to, taken from the source, not from
  prose. A blank cell means "unset, and unset is meaningful".
- **Example** — anonymised and syntactically valid. Never copy a secret from a
  document; generate your own (see *Secrets discipline*).

Placeholders used throughout: `<instance>` is an instance's literal name as
Atrium knows it, `<host>` a hostname you own, `<root>` the directory holding your
instances. Anything in `<angle brackets>` must be replaced.

**This page is checked against the code.** `bridge/test/config-reference.test.ts`
fails the build when a variable is read by the bridge and missing here, or listed
here and read nowhere. A reference that drifts is worse than no reference, so the
drift is a test failure rather than a discovery you make in production.

## Scope 1 — Container env

### Bridge — required

The bridge exits at startup if any of these is missing. That is deliberate: each
one is a wire it cannot invent.

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `BRIDGE_SHARED_SECRET` | yes | | Authenticates **Atrium → bridge** calls (send, abort, config probes). Atrium holds the same value in its Convex env; a mismatch makes every send fail with an authentication error rather than a routing one. | `openssl rand -hex 32` |
| `BRIDGE_INGEST_SECRET` | yes | | Authenticates **bridge → Convex** ingest (the reply stream, traces, sub-agent rows). Distinct from the above on purpose: the two directions are separately revocable. | `openssl rand -hex 32` |
| `CONVEX_HTTP_ACTIONS_URL` | yes | | Where the bridge posts ingest. This is the **HTTP-actions** origin (the `.site` host on Convex Cloud, the site port when self-hosted) — **not** the API origin. Pointing it at the API origin yields 404s on every ingest with an otherwise healthy stack. | `https://convex.<host>/http` |
| `OPENCLAW_GATEWAY_URL` | yes | | The gateway's WebSocket endpoint. The bridge holds one connection per served instance. | `ws://gateway:18789` |

### Bridge — optional, with the defaults the code actually uses

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `BRIDGE_PORT` | no | `8787` | Port the bridge listens on. Must match the `bridgeUrl` Atrium has for this instance. | `8787` |
| `BRIDGE_MAX_BODY_BYTES` | no | `33554432` | Largest accepted request body (32 MiB). Raise it only with the attachment limits, never alone. | `33554432` |
| `BRIDGE_CREDENTIAL_RETRY_MS` | no | `30000` | How long the bridge waits before retrying credential resolution when Convex is unreachable at boot. It starts anyway — an unavailable Convex must never make the bridge unbootable. | `30000` |
| `BRIDGE_INSTANCE_SECRETS` | no | | Comma/space-separated **per-instance** secrets. Each resolves 1:1 to one instance and unlocks only that instance's encrypted credentials. Shown once, at mint time, in the admin UI. Without at least one the bridge runs but has nothing to serve. | `<alpha-secret>,<beta-secret>` |
| `BRIDGE_INSTANCE_SECRET` | no | | Singular legacy form for a single-instance bridge. Prefer the plural above. | `<alpha-secret>` |
| `BRIDGE_PROVIDER_KIND` | no | | Pins the provider family instead of letting the bridge discover it. Leave unset unless you are bringing up a provider the discovery does not yet recognise. | `openclaw` |
| `BRIDGE_PROVIDER_TRANSPORT` | no | | Pins the transport (`ws` / `rest`). Same rule: leave unset unless you are diagnosing a transport. | `ws` |
| `OPENCLAW_GATEWAY_HTTP_URL` | no | `""` | HTTP origin of the gateway, used for media fetches in `gateway-http` mode. Unset means "derive it from the WebSocket URL". | `http://gateway:18789` |
| `OPENCLAW_GATEWAY_VERSION` | no | | Declares the gateway version instead of discovering it. Only for a gateway whose version probe is unavailable; a wrong value silently disables version-gated features. | `2026.7.1` |
| `OPENCLAW_TOKEN` | no | | Gateway operator token, when the gateway requires one and you are not using per-instance credentials from Convex. | `<gateway-token>` |
| `OPENCLAW_INSTANCE_NAME` | no | | Forces the served instance name. **Process-global** — never set it on a bridge serving several instances. | `alpha` |
| `OPENCLAW_DELTA_FLUSH_MS` | no | `150` | How often streamed text is flushed to Convex. Lower is smoother and costlier in writes. | `150` |
| `OPENCLAW_MEDIA_MAX_MB` | no | `1024` | Largest media file the bridge will move. | `1024` |
| `OPENCLAW_MEDIA_FETCH_TIMEOUT_MS` | no | `60000` | Per-file fetch timeout in `gateway-http` media mode. | `60000` |
| `OPENCLAW_INBOUND_TTL_MS` | no | `21600000` | How long a staged inbound file is kept (6 h). | `21600000` |
| `OPENCLAW_MEDIA_OUTBOUND_DIR` | no | *derived from the instance name* | **Process-global override** of the bridge's outbound media dir. Use it only when the bridge serves exactly ONE instance. With several, it collapses every instance onto one path — see *Media paths* below. | `/home/node/.openclaw/media/alpha/outbound` |
| `OPENCLAW_INBOUND_DIR` | no | *derived from the instance name* | Same, for inbound. Same single-instance restriction. | `/home/node/.openclaw/media/alpha/inbound` |
| `OPENCLAW_MEDIA_OUTBOUND_AGENT_MOUNT` | no | the gateway standard | The **agent-visible** outbound path — where the agent is told to write, which is a different mount point from where the bridge reads the same file. Set it only when bridge and gateway mount the shared volume at different paths (a host bridge beside a containerised gateway, typically). | `/home/node/.openclaw/media/outbound` |
| `OPENCLAW_INBOUND_AGENT_MOUNT` | no | the gateway standard | The agent-visible inbound path, quoted to the agent in the received-files block. Same rule as above. | `/home/node/.openclaw/media/inbound` |
| `OPENCLAW_DEVICE_IDENTITY` | no | | Inline device identity (JSON) for gateways that authenticate the bridge as a paired device. Generate with `node deploy/compose/generate-device-identity.mjs`. Prefer a file or a mounted secret over an inline value in `.env`. | `{"id":"…","publicKey":"…","privateKey":"…"}` |

### Front end — build-time, not runtime

`VITE_*` variables are **baked into the bundle at build time**. Changing them on
a running container does nothing; you must rebuild the image. In local
development `npx convex dev` writes them into `.env.local` for you.

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `VITE_CONVEX_URL` | yes (build) | | Convex **API** origin the browser client talks to. | `https://convex.<host>` |
| `VITE_CONVEX_SITE_URL` | no | *derived* | Convex **HTTP-actions** origin, when it cannot be derived from the API origin. Self-hosted deployments generally need it explicitly. | `https://convex.<host>/http` |

### Compose-only — images, ports, paths, identity

Consumed by `docker-compose.yml`, never by application code. They are how the
stack is placed on a host, not how Atrium behaves.

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `COMPOSE_PROJECT_NAME` | no | directory name | Isolates this stack's containers, volumes and network from another on the same host. | `atrium` |
| `WEBCHAT_IMAGE` / `WEBCHAT_TAG` | no | `ghcr.io/lacneu/atrium` / `latest` | Front-end image and tag. Pin the tag in production; `latest` makes a redeploy non-reproducible. | `ghcr.io/lacneu/atrium` / `0.74.4` |
| `BRIDGE_IMAGE` / `BRIDGE_TAG` | no | `ghcr.io/lacneu/atrium-bridge` / `latest` | Bridge image and tag. Keep it in lockstep with the front end — Atrium ships as one version across all artifacts. | `ghcr.io/lacneu/atrium-bridge` / `0.74.4` |
| `WEBCHAT_PORT` | no | | Host port for the front end. | `8080` |
| `CONVEX_CLOUD_PORT` / `CONVEX_SITE_PORT` | no | | Host ports for the Convex **API** and **HTTP-actions** origins. The second is what `CONVEX_HTTP_ACTIONS_URL` must point at. | `3210` / `3211` |
| `CONVEX_DASHBOARD_PORT` / `CONVEX_DASHBOARD_BIND` | no | | Convex dashboard port, and the interface it binds to. Bind it to loopback unless you have put an authenticating proxy in front. | `6791` / `127.0.0.1` |
| `CONVEX_INSTANCE_NAME` / `CONVEX_INSTANCE_SECRET` | yes (self-hosted) | | Identity of the self-hosted Convex deployment. | `atrium` / `openssl rand -hex 32` |
| `CONVEX_CLOUD_ORIGIN` / `CONVEX_SITE_ORIGIN` | yes (self-hosted) | | The origins the backend advertises. They must match what browsers and the bridge actually reach, proxies included. | `https://convex.<host>` |
| `CONVEX_RUST_LOG` | no | | Backend log level. | `info` |
| `BRIDGE_RUN_AS_UID` | no | | `uid:gid` the bridge container runs as. Must match the gateway's, or inbound files the bridge writes are unreadable by the agent. A bridge process has ONE uid, so every served gateway must share it. | `1000:1000` |
| `OPENCLAW_MEDIA_OUTBOUND_HOST_DIR` | no | | Host path of the gateway's outbound media dir. **Read by nothing until you uncomment the matching mount** (CASE A in `docker-compose.yml`). | `<root>/instances/alpha/.openclaw/media/outbound` |
| `OPENCLAW_INBOUND_HOST_DIR` | no | | Same, for inbound, with the same caveat. | `<root>/instances/alpha/.openclaw/media/inbound` |

## Scope 2 — Convex deployment env

Pushed from the same `.env` by `deploy/compose/bootstrap-env.sh` →
`convex-env-push.sh`. Setting them in the container instead has no effect: Convex
functions read the **deployment** environment.

### Authentication

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `SITE_URL` | yes | | Public origin of the front end. OAuth redirects are built from it, so a wrong value produces a successful login that lands nowhere. | `https://atrium.<host>` |
| `JWT_PRIVATE_KEY` | yes | | PKCS#8 private key signing session JWTs. Generate with `node deploy/compose/generate-auth-keys.mjs`. | *(PEM block)* |
| `JWKS` | yes | | Public JWKS matching the key above. Generated by the same script — the pair must come from one run. | *(JSON)* |
| `JWT_PRIVATE_KEY_FILE` | no | | Path to a file holding the private key, for operators who keep it out of `.env`. Read by the bootstrap step, which resolves it before pushing. | `/run/secrets/jwt-private-key` |
| `JWKS_FILE` | no | | Same, for the JWKS. Use both file forms together or neither — a mismatched pair fails every sign-in. | `/run/secrets/jwks.json` |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | yes in practice | `example.com` | Domains allowed to sign in. **The default is a placeholder that lets nobody in and everybody past review**: set it explicitly or your first real user is refused. | `<your-domain>.com` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | no | | Google OAuth client. Omit both to disable the provider. | `<client-id>` / `<client-secret>` |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | no | | Microsoft Entra ID application (client) id. Omit the whole trio to disable the provider. | `<client-id>` |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | no | | Its client secret. | `<client-secret>` |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | no | | Issuer URL for a single-tenant app. | `https://login.microsoftonline.com/<tenant>/v2.0` |

### Environment labelling and credential encryption

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `ATRIUM_ENV_LABEL` | no | | Short label shown in the UI and stamped on identifiers, so a production identifier is never mistaken for a staging one. | `prod` |
| `ATRIUM_SECRET_KEY` | yes | | Encrypts per-instance gateway credentials at rest. **Rotating it makes every stored credential unreadable** — re-enter them after a rotation. | `openssl rand -hex 32` |

### Bridge wiring, Convex side

The same two secrets as the bridge's, plus where to reach it. They must match the
bridge's values exactly; that is the whole handshake.

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `BRIDGE_URL` | yes | | Where Convex reaches the bridge. Also settable per instance in the admin UI, which wins. | `http://bridge:8787` |
| `BRIDGE_INSTANCE_NAME` | no | | Default instance name for single-instance deployments. | `alpha` |
| `BRIDGE_SHARED_SECRET` | yes | | Must equal the bridge's. | *(same value)* |
| `BRIDGE_INGEST_SECRET` | yes | | Must equal the bridge's. | *(same value)* |

### Provisioning keys — declarative, and that matters

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `ATRIUM_PROVISION_KEYS` | no | | Declares which hosts may provision instances via the API. **Declarative, not additive**: an empty value is a REVOCATION of everything, and the key being absent from `.env` means "leave Convex alone". The push script distinguishes the two — do not hand-edit it in the Convex dashboard while also declaring it here. | `<host-id>:<key>` |
| `ATRIUM_PROVISION_KEYS_FILE` | no | | Path to a file holding the value, for operators who keep it out of `.env`. | `/run/secrets/provision-keys` |

### Signed operator announcements (optional)

Off unless configured. Every variable below is inert on its own; the feature
needs the coherent set.

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `SIGNED_ANNOUNCEMENTS_URL` | no | | Endpoint publishing signed announcements. | `https://announce.<host>/feed` |
| `SIGNED_ANNOUNCEMENTS_TOKEN` | no | | Bearer token for that endpoint. | `<token>` |
| `SIGNED_ANNOUNCEMENTS_PUBLIC_KEY` | no | | Key verifying the signature. An announcement that fails verification is dropped, never displayed. | *(base64)* |
| `SIGNED_ANNOUNCEMENTS_KEY_MAP` | no | | Several public keys by id, for rotation without a gap. | *(JSON)* |
| `SIGNED_ANNOUNCEMENTS_DOMAIN` | no | | Domain the announcement must claim. | `<host>` |
| `SIGNED_ANNOUNCEMENTS_RECIPIENT_ID` | no | | Which recipient this deployment is. | `<deployment-id>` |
| `SIGNED_ANNOUNCEMENTS_RECIPIENT_FIELD` | no | | Which field of the announcement carries that recipient id. | `recipient` |

### Trace shipping (optional)

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | no | | Ships traces to Langfuse. All three or none. | `pk-...` / `sk-...` / `https://cloud.langfuse.com` |
| `OPIK_API_KEY` / `OPIK_WORKSPACE` / `OPIK_BASE_URL` | no | | Ships traces to Opik. | `<key>` / `<workspace>` / `https://www.comet.com/opik/api` |
| `OPIK_PROJECT_NAME` / `OPIK_OPENCLAW_PROJECT` | no | | Project names for Atrium's own traces and for the gateway's. | `atrium` / `openclaw` |

### Retention

| Variable | Required | Default | What it is, and why it exists | Example |
|---|---|---|---|---|
| `TRACE_RETENTION_DAYS` | no | | How long trace events are kept before the retention cron deletes them. | `30` |
| `ACCESS_LOG_RETENTION_DAYS` | no | | How long SOC2 access-log rows are kept. Check your own obligations before shortening it. | `365` |

## Media paths — the one place a wrong value fails silently

Four paths are in play and only one of them may be keyed by instance. Getting it
wrong does not raise an error: files are written, and nobody ever sees them.

- the **agent** reads and writes the FLAT gateway path
  `/home/node/.openclaw/media/{outbound,inbound}` — **never key it**, the
  instance's own `openclaw.json` whitelists that literal path;
- the **bridge** reads and writes
  `/home/node/.openclaw/media/<instance>/{outbound,inbound}` — **always keyed**,
  and derived automatically from the instance name it resolves from Convex;
- **both bind the same host directory**, which is what makes the file the bridge
  writes the file the agent reads.

`deploy/SHARED_FS_MEDIA.md` works this through end to end, with a two-instance
example and a verification procedure. Read it before touching a media path.

## Per-instance settings — admin UI, not env

Gateway URL, credentials, per-bridge secret, media mode and enablement are held
**per instance in Convex**, set through Settings → Agents, not in `.env`. That is
deliberate: they differ per instance, and a bridge serving several gateways
cannot express them as process-global variables.

One consequence worth knowing before you install: **enabling an agent is what
exposes it**. Visibility is authorisation by default; attribution is not a second
lock.

## Secrets discipline

Generate each shared secret with `openssl rand -hex 32`. Never commit a `.env`
file, an instance secret, an auth key, or a gateway token. See
[SECURITY.md](../SECURITY.md).

Secrets that must MATCH across scopes: `BRIDGE_SHARED_SECRET` and
`BRIDGE_INGEST_SECRET` (bridge env ↔ Convex env). Secrets that must be DISTINCT:
those two from each other, and every per-instance secret from every other.
