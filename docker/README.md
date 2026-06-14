# atrium — static frontend image

Origin-agnostic image that serves the built SPA with **Caddy** (tiny, SPA-aware,
no nginx). The Convex URL is **not baked** — it is injected at run time.

## Run

```bash
docker run -p 8080:80 -e CONVEX_URL="https://api.example.com" <image>
```

`CONVEX_URL` = the **public Convex cloud origin** the browser reaches. The
entrypoint writes `/config.json` from it; the SPA reads that at boot
(`src/lib/runtimeConfig.ts`). The entrypoint **fails fast** if `CONVEX_URL` is
unset. TLS + the public domain are handled upstream by Traefik on the NAS; this
image only serves HTTP on `:80`.

## Build

Built by `.github/workflows/release.yml` on tag `v*` and pushed to Docker Hub +
ghcr. To build locally (context = repo root):

```bash
docker build -f docker/Dockerfile -t atrium:dev .
```

> The build must NOT receive `VITE_CONVEX_URL` — otherwise Vite bakes a fallback
> and the image is no longer origin-agnostic.
