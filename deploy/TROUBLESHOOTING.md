# Deployment troubleshooting

Real problems hit while standing up a first self-hosted Atrium (Docker Compose +
self-hosted Convex + bridge → an OpenClaw gateway), with how to **diagnose** and
**fix** each. Ordered roughly by the sequence you meet them.

> Mental model: the stack is **frontend (static) + Convex backend + bridge**, and
> the bridge talks to **your** agent gateway. A deploy has TWO steps that are easy
> to conflate: (1) `docker compose up` brings up the containers; (2) a one-shot
> **`convex deploy` + env push** makes the (otherwise empty) Convex backend usable.
> Many "it doesn't work" issues are really "step 2 didn't run / ran wrong".

---

## A. Images won't pull

### `docker pull` / compose says `denied` or `not found` for `ghcr.io/<owner>/atrium`
- **Cause:** images published to GHCR by CI are **private by default**.
- **Fix:** make the packages public — `github.com/orgs/<owner>/packages` → click
  `atrium` (and `atrium-bridge`) → *Package settings* → *Change visibility* →
  **Public**. (Or keep them private and `docker login ghcr.io` on the host with a
  PAT that has `read:packages`.)
- **Diagnose (anonymous pull test):**
  ```bash
  tok=$(curl -s "https://ghcr.io/token?scope=repository:<owner>/atrium:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $tok" \
    https://ghcr.io/v2/<owner>/atrium/manifests/<tag>     # 200 = public, 403 = private
  ```

---

## B. The Convex bootstrap (`convex deploy` + env)

### `bootstrap-env.sh` aborts: `convex/ source not found` / `package.json` not found
- **Cause:** `convex deploy` bundles the functions from `convex/` at the repo
  ROOT, and the `convex` CLI must run from a directory containing `package.json`.
  Running it from a folder with only `compose.yaml` + `.env` (a "flat" copy) fails.
- **Fix:** run the bootstrap from a **full repo checkout** — `git clone` the repo
  and run `deploy/compose/bootstrap-env.sh` from inside it. Even cleaner: see
  *"Deploy from any machine"* below — only the admin-key mint needs the host.

### `npx: command not found` (but `npm` exists) — common on Synology
- **Cause:** `npx` ships with npm but its symlink wasn't created by the host's Node
  install.
- **Fix:**
  ```bash
  sudo ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
  which npx     # confirms
  ```

### `bootstrap-env.sh` times out: `<backend> not healthy after 60s` — but the container IS healthy
- **Cause:** the script's health probe is `docker exec <backend> curl …` and on
  Synology a non-root user **can't talk to the Docker daemon**; the error is hidden
  by `>/dev/null`.
- **Fix:** run it as root while keeping Node on PATH:
  ```bash
  sudo env "PATH=$PATH" ./bootstrap-env.sh
  ```
- **Diagnose (un-hide the probe):**
  ```bash
  docker exec <project>-convex-backend curl -fsS http://localhost:3210/version; echo "exit=$?"
  # "permission denied … docker.sock" => it's the Docker-permission issue.
  ```

### Sign-in fails; console shows `"pkcs8" must be PKCS#8 formatted string`; app stuck on "Loading…"
- **Cause:** `JWT_PRIVATE_KEY` in the Convex env is **not a valid PEM**. Two ways
  this happens:
  1. You pasted a **multiline** PEM *inline* in `.env`. A dotenv file holds
     single-line values — the parser reads only the first line, and Docker
     Compose can't hold multiline either.
  2. A `<KEY>_FILE` pointed at a **missing file**; an old script bug then stored the
     literal `FATAL: …_FILE points to a missing file: …` string AS the value.
- **Fix:** never paste the key inline — provide it via a **file path** (the
  `.env.example` only exposes the `_FILE` form for this reason). Generate a valid
  **matching pair** with the bundled helper, then point the `_FILE` vars at it:
  ```bash
  cd deploy/compose && node generate-auth-keys.mjs   # writes jwt_private_key.pem + jwks.json (no deps)
  ```
  ```dotenv
  JWT_PRIVATE_KEY_FILE=jwt_private_key.pem     # real-newline PKCS#8 PEM, next to .env
  JWKS_FILE=jwks.json                          # the matching public half
  ```
  Re-push the env, then verify it's a real key:
  ```bash
  cd <repo-root> && npx convex env get JWT_PRIVATE_KEY | head -1   # => -----BEGIN PRIVATE KEY-----
  ```
  `JWT_PRIVATE_KEY` and `JWKS` must be a **matching pair** — `generate-auth-keys.mjs`
  emits them together, so don't mix keys from two runs.
- **Note:** `bootstrap-env.sh` / `convex-env-push.sh` now send the FATAL to stderr
  and ABORT instead of storing it, so this can't silently recur — but re-check the
  value if you hit it on an older script.

### "Loading…" forever even though my OAuth user row exists
- **Cause:** the OAuth user is created, but the **session token can't be generated
  or validated** (the `pkcs8`/JWKS issue above) OR the profile-bootstrap mutation
  throws (e.g. `AUTH_ALLOWED_EMAIL_DOMAINS` not effective → "email domain not
  allowed"). The frontend calls the bootstrap mutation **once** and does not retry
  → a single throw pins the loader.
- **Diagnose:** browser **DevTools → Console** (Convex surfaces the mutation error
  there) AND the **Convex dashboard → Logs**. Fix the offending env, then
  **hard-reload** (a fresh mount re-runs the bootstrap).

---

## C. Container Manager / volumes (Synology)

### `docker compose down -v` "succeeds" but my data is still there after restart
- **Cause:** a docker-compose project-name mismatch
  ([docker/compose#11734](https://github.com/docker/compose/issues/11734)).
  Synology Container Manager runs the stack under **its own project name** (the CM
  project name), so the data volume is e.g. `atrium_convex-data`. Your CLI in the
  project dir reads `COMPOSE_PROJECT_NAME` from `.env` (e.g. `atrium-prod`) and
  `down -v` removes a **different** volume (`atrium-prod_convex-data`) — the wrong
  one.
- **Fix:** find the volume the backend ACTUALLY mounts, then remove THAT (after
  stopping the project):
  ```bash
  docker inspect <project>-convex-backend \
    --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'   # the one at /convex/data
  # Container Manager: Stop the project, then:
  docker volume rm <that-volume>
  # Container Manager: Start the project (recreates it EMPTY).
  ```
- **Prevent:** set `COMPOSE_PROJECT_NAME` in `.env` to the **same** name as your
  Container Manager project, so CM and CLI agree on project/volume names.

### How do I reset to a pristine "first deploy"?
Wipe the Convex data volume (above), then re-run the one-shot deploy: re-mint the
admin key, `npx convex deploy`, and the env push. The first sign-in becomes admin
again. (This erases data **and** the deployed functions + env — they live in that
volume — which is exactly the point.)

---

## D. Networking (reverse proxy / DNS)

### Frontend URL returns nothing (`curl` shows HTTP `000`) while the Convex URLs work
- **Cause:** the **frontend** subdomain has no DNS record or no proxy route. It's
  easy to wire the Convex hosts and forget the app host.
- **Fix:** you need DNS + a reverse-proxy (Traefik/nginx) route + TLS for **all
  three** public hosts: the frontend, the Convex **cloud** origin, and the Convex
  **site** origin.
- **Diagnose:**
  ```bash
  dig +short atrium.example.com        # empty => no DNS record
  curl -s https://atrium.example.com/config.json   # => {"convexUrl":"https://convex.example.com"}
  ```
  HTTP `000` = connection-level failure (DNS not resolving, or TLS). A Traefik
  default `404` instead means DNS+TLS are fine but the router rule is missing.

### Sign-in bounces / OAuth error after redirect
- **Cause:** the OAuth **redirect URI** isn't registered, or doesn't point at the
  Convex **site** origin.
- **Fix:** in the provider console (Google / Entra), add redirect URI
  `https://<CONVEX_SITE_ORIGIN>/api/auth/callback/<provider>` and authorized
  origin `https://<your frontend>`. Also confirm `SITE_URL` is the frontend origin.

---

## E. Auth & first sign-in

### Sign-in refused for a legitimate email
- **Cause:** `AUTH_ALLOWED_EMAIL_DOMAINS` is unset (it **fail-closes** to a
  placeholder domain) or doesn't include your domain.
- **Fix:** set it (comma-separated, no spaces) and re-push:
  `AUTH_ALLOWED_EMAIL_DOMAINS=acme.com,team.org`. The **first** sign-in from an
  allowed domain becomes **admin**; everyone else lands **pending** (an admin
  approves them in Settings → Users).
- **Diagnose:** `npx convex env get AUTH_ALLOWED_EMAIL_DOMAINS` (from the repo
  root); the sign-in screen also logs the allowed domains to the console.

---

## F. Instances & agent discovery

### Settings → Instances shows "No agents discovered"
- **Cause #1 (most common): the instance NAME doesn't match what the bridge
  serves.** The bridge serves the single instance named by `OPENCLAW_INSTANCE_NAME`
  (it self-declares it under Settings → Bridge → Compatibility). If you create an
  instance with a different name, the discovery poll asks the bridge for a name it
  doesn't serve → zero agents.
  - **Fix:** the instance name in Settings → Instances must equal
    `OPENCLAW_INSTANCE_NAME` (and `BRIDGE_INSTANCE_NAME`). Recreate it with the
    exact name (e.g. `primary`).
- **Cause #2: the discovery hasn't run yet.** Agent discovery is a **cron that runs
  every ~2 minutes** (`agents.pollAgentDiscovery`), and the bridge connects to the
  gateway **lazily**. A freshly-added instance shows "never probed" until the next
  run. Wait ~2 min, or send a message (which solicits the bridge immediately).
- **Cause #3: the bridge can't reach the gateway, or the gateway has no agent.**
  - **Diagnose:** the bridge container logs (`<project>-bridge`) — can it reach
    `OPENCLAW_GATEWAY_URL`? Are `OPENCLAW_TOKEN` / `OPENCLAW_DEVICE_IDENTITY`
    valid? Does the gateway actually have an agent defined?

### An instance's "Gateway URL" field seems to do nothing (single-gateway deployments)
- **By design (current limitation).** This deployment is **mono-gateway**: the
  bridge reads ONE `OPENCLAW_GATEWAY_URL` from its environment and routes every
  session to it. The per-instance `gatewayUrl` in the UI is **not yet honored** by
  the bridge (multi-gateway / multi-instance is a planned phase). So today:
  - **Multi-AGENT** (many agents on one gateway) — **works**; agents are discovered
    and assigned to users.
  - **Multi-INSTANCE** (several different gateways) — **not yet**. Only the
    instance whose name matches `OPENCLAW_INSTANCE_NAME` is live; its `gatewayUrl`
    field is informational.

---

## Deploy from any machine (the CI-friendly way — no host Node needed)

Only **minting the admin key** needs the host (it runs inside the backend
container). The rest (`convex deploy`, env push) can run from any machine with Node
and a checkout, targeting the backend over the network — which is exactly what a CI
pipeline does:

```bash
# On the host, once:
docker exec <project>-convex-backend ./generate_admin_key.sh    # copy the key

# Anywhere with Node + the repo:
export CONVEX_SELF_HOSTED_URL="https://convex.example.com"       # or http://<host-ip>:3210 on the LAN
export CONVEX_SELF_HOSTED_ADMIN_KEY="<the admin key>"
npx convex deploy                                  # deploy functions (run from repo root)
deploy/compose/convex-env-push.sh                  # push the Convex deployment env from .env
```

In a real pipeline, `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY`
become CI secrets and these two commands are the deploy job.
