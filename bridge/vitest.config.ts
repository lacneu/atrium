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
    // PROCESS isolation, not threads. Vitest reuses a worker THREAD across files, and a
    // thread carries state no module isolation resets: the HTTP connection pool behind
    // `fetch`, native handles, patched globals. Tests here open real servers on ephemeral
    // ports, which the OS recycles between files — so a request could be answered by the
    // server of a previous file, which is how three route cases failed with a status their
    // own route cannot produce (404 where 200/409 was expected) and one with a reply that
    // did not parse as HTTP/1.1.
    // MEASURED on this machine, same code, same load: threads = 1 failing run out of 3
    // (a fourth file, config-changed-roster, failed the same way); threads without file
    // parallelism = 0 out of 2; forks WITH full parallelism = 0 out of 4. The failures are
    // therefore cross-FILE interference inside a worker, not CPU contention — forks keep
    // the parallelism and remove the shared surface.
    // NOT a proven single mechanism: the pooled-socket hypothesis could not be tested here
    // (no undici dependency to swap the dispatcher), and a 1-in-3 flake cannot be pinned by
    // a red test. What is measured is above; what is fixed is the sharing.
    pool: "forks",
  },
});
