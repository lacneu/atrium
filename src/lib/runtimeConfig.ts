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
}

export async function resolveConvexUrl(): Promise<string> {
  // 1) Runtime config (origin-agnostic image). no-store so a redeploy is picked
  //    up immediately instead of a stale cached config trapping the old URL.
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      const cfg = (await res.json()) as Partial<RuntimeConfig> | null;
      const url = cfg?.convexUrl;
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  } catch {
    // No /config.json (local dev, or not yet written) → fall through to env.
  }

  // 2) Build-time fallback (local dev). Also usable if someone prefers a baked
  //    image for a single, fixed deployment.
  const fromEnv = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  throw new Error(
    'No Convex URL configured: serve /config.json {"convexUrl":"…"} ' +
      "(production) or set VITE_CONVEX_URL (local dev).",
  );
}
