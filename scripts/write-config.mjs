// Build-time generator for the static `/config.json` consumed by the
// origin-agnostic bundle (src/lib/runtimeConfig.ts).
//
// Two hosting paths produce the SAME /config.json, by design:
//   - Self-hosted: the static-server container writes it at runtime from
//     CONVEX_URL (Docker entrypoint). UNCHANGED by this script.
//   - Static CDN (Vercel): there is no runtime entrypoint, so we write it at
//     BUILD time here. Run BEFORE `vite build` so Vite copies public/ -> dist/.
//
// The Convex URL is provided by `convex deploy --cmd-url-env-var-name
// VITE_CONVEX_URL --cmd '...'`, which sets VITE_CONVEX_URL to the deployment it
// just pushed to (Dev key in Vercel Preview, Prod key in Production) -> the
// right URL per environment, with no per-env code.
//
// public/config.json is gitignored AND dockerignored, so a CDN build artifact
// never leaks into the committed tree or the self-hosted image.
import { mkdirSync, writeFileSync } from "node:fs";

const convexUrl = process.env.VITE_CONVEX_URL?.trim();
if (!convexUrl) {
  throw new Error(
    "VITE_CONVEX_URL is not set. Expected `convex deploy " +
      "--cmd-url-env-var-name VITE_CONVEX_URL --cmd '...'` to provide it.",
  );
}

// convexSiteUrl is OPTIONAL on managed Convex Cloud: the client derives the
// `.site` origin from the `.cloud` URL (deriveSiteUrl). Only emit it when an
// explicit override is present (e.g. self-hosted unrelated cloud/site hosts).
const config = { convexUrl };
const siteUrl = process.env.VITE_CONVEX_SITE_URL?.trim();
if (siteUrl) config.convexSiteUrl = siteUrl;

mkdirSync("public", { recursive: true });
writeFileSync("public/config.json", `${JSON.stringify(config)}\n`);
console.log(`[write-config] public/config.json -> ${convexUrl}`);
