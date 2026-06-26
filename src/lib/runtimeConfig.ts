// Resolve the Convex deployment URL at RUNTIME so the built bundle is NOT pinned
// to a single origin. This is what makes the static frontend a reusable,
// distributable artifact (npm package / Docker image) instead of one baked for a
// single deployment.
//
// Resolution order:
//   1. /config.json  — served next to the static bundle. In production the
//      static-server image writes it at container start from the CONVEX_URL env
//      (see the App's static Dockerfile entrypoint). This is the origin-agnostic
//      path: the SAME image serves any deployment.
//   2. import.meta.env.VITE_CONVEX_URL — build-time fallback for LOCAL DEV
//      (.env.local). In dev there is no /config.json (404) so this is used.
//
// Kept dependency-free and outside React so it can run before the first render.

export interface RuntimeConfig {
  convexUrl: string;
  // The HTTP-actions (`.site`) origin. REQUIRED in production when the cloud + site
  // origins are unrelated hosts (self-hosted reverse-proxy), where it cannot be derived
  // from convexUrl. Optional otherwise (managed Convex `.cloud`/`.site`, local +1 port).
  convexSiteUrl?: string;
}

// Resolved values, cached after the first resolve so the sync accessor (convexSiteUrl)
// works post-bootstrap. main.tsx resolves them before the first render.
let cachedConvexUrl: string | null = null;
let cachedConvexSiteUrl: string | null = null;

export async function resolveConvexUrl(): Promise<string> {
  // 1) Runtime config (origin-agnostic image). no-store so a redeploy is picked
  //    up immediately instead of a stale cached config trapping the old URL.
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = (await res.json()) as Partial<RuntimeConfig> | null;
      const site = cfg?.convexSiteUrl;
      if (typeof site === "string" && site.trim()) {
        cachedConvexSiteUrl = site.trim();
      }
      const url = cfg?.convexUrl;
      if (typeof url === "string" && url.trim()) {
        cachedConvexUrl = url.trim();
        return cachedConvexUrl;
      }
    }
  } catch {
    // No /config.json (local dev, or not yet written) → fall through to env.
  }

  // 2) Build-time fallback (local dev). Also usable if someone prefers a baked
  //    image for a single, fixed deployment.
  const fromEnv = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (fromEnv && fromEnv.trim()) {
    cachedConvexUrl = fromEnv.trim();
    return cachedConvexUrl;
  }

  throw new Error(
    'No Convex URL configured: serve /config.json {"convexUrl":"…"} ' +
      "(production) or set VITE_CONVEX_URL (local dev).",
  );
}

// The deployment's HTTP-actions origin (`.site`) for the convex `.cloud`/api URL.
// Convex serves httpActions (the SSE stream endpoint) at the `.site` domain, NOT the
// `.cloud` one the reactive client connects to. Cloud: `x.convex.cloud` -> `x.convex.site`.
// Local convex-local-backend: the site proxy is the api port + 1 (`--port P
// --site-proxy-port P+1`). An explicit VITE_CONVEX_SITE_URL overrides both.
export function deriveSiteUrl(convexUrl: string): string {
  try {
    const u = new URL(convexUrl);
    if (u.hostname.endsWith(".convex.cloud")) {
      u.hostname = u.hostname.replace(/\.convex\.cloud$/, ".convex.site");
      return u.origin;
    }
    if (u.port) {
      u.port = String(Number(u.port) + 1);
      return u.origin;
    }
    return convexUrl;
  } catch {
    return convexUrl;
  }
}

// Sync accessor for the `.site` origin (null until the bootstrap resolve has run).
// Resolution order: (1) the runtime config.json `convexSiteUrl` — origin-agnostic, the
// production path that also covers self-hosted UNRELATED cloud/site hosts; (2) the
// VITE_CONVEX_SITE_URL build override (local dev / a baked single-deployment image);
// (3) derive from the cloud URL (managed Convex .cloud/.site, or local +1 port).
export function convexSiteUrl(): string | null {
  if (cachedConvexSiteUrl) return cachedConvexSiteUrl;
  const override = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (override && override.trim()) return override.trim();
  return cachedConvexUrl ? deriveSiteUrl(cachedConvexUrl) : null;
}
