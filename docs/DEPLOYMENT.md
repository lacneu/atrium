# Deployment

The canonical deployment guide lives in **[`deploy/README.md`](../deploy/README.md)**.

It covers the env-driven stack (self-hosted Convex backend + dashboard, the
static front end, and the bridge), the two deployment modes (Docker Compose and
Helm), the two-environment-scope gotcha, and the stateful/stateless lifecycle.

Quickstart (Docker Compose):

```bash
cd deploy/compose
cp .env.example .env          # fill every required value
docker compose up -d
./bootstrap-env.sh            # push the Convex-scoped vars into the deployment
```

For the environment variable reference, see [CONFIGURATION.md](CONFIGURATION.md).
