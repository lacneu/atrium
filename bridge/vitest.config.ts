import { defineConfig } from "vitest/config";

// The bridge is a standalone package (its own package.json + node_modules + a
// Node runtime — it uses fs/path/url, NOT Web/edge APIs). Without this config,
// `vitest run` from bridge/ walks up and picks the ROOT config (edge-runtime +
// include convex/**,src/**), which neither matches bridge/test nor fits a Node
// worker. Scope vitest to bridge/test with the node environment so `npm test`
// runs the normalizer + run-manager suites (the bridge's correctness gate).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
