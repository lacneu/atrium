# atrium-bridge

Node/TypeScript bridge for **atrium**. It holds a persistent **operator
WebSocket** to an OpenClaw gateway, normalizes the streaming events, and feeds
them to **Convex over HTTP** — it imports nothing from the Convex app (loose
coupling via the ingest endpoints), so it versions and deploys independently.

For **outbound media** it reads agent-produced files from a read-only mount of
the gateway's `media/outbound` and streams the bytes to a Convex upload URL (no
base64).

## Run

```bash
cp .env.example .env       # fill OPENCLAW_TOKEN, OPENCLAW_DEVICE_IDENTITY, …
npm ci
npm run build
npm start
```

Key env (see `.env.example`): `OPENCLAW_GATEWAY_URL`, `OPENCLAW_TOKEN`,
`OPENCLAW_DEVICE_IDENTITY`, `CONVEX_HTTP_ACTIONS_URL`, `BRIDGE_INGEST_SECRET`,
`BRIDGE_SHARED_SECRET`, `OPENCLAW_MEDIA_OUTBOUND_DIR`. **Secrets live only in the
environment — never commit `.env`.**

## Tests

```bash
npm test          # vitest: normalizer, multiplex, media-fetcher, run-manager, write-back
```

`local-openclaw/` is a self-contained, version-pinned OpenClaw harness to test
the **bridge ↔ gateway** seam live (`local-openclaw/up.sh` boots a local gateway
and prints the overrides to run the bridge against it). A full end-to-end test
also needs a reachable Convex (run the atrium app's `npx convex dev`).

## Docker

Built by `.github/workflows/build-and-push.yml` (tag `v*` / `main`) and pushed to
Docker Hub + ghcr. Local build:

```bash
docker build -t atrium-bridge:dev .
```

## Deployment

Runs as a standalone container that pulls the published image. If it lives in a
different Docker network than Convex and the gateway, **cross-project links must
use a host address reachable from the container**, e.g.
`OPENCLAW_GATEWAY_URL=ws://<your-host>:18789`,
`CONVEX_HTTP_ACTIONS_URL=http://<your-host>:3211`.

## License

MIT — see [LICENSE](./LICENSE).
