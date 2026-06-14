import { defineConfig } from "vitest/config";

// Standalone config for the mcp package: the unit tests are pure (injected
// fetch, no Convex), so the default node environment with global fetch/Response
// (Node >=18) is all we need. Scoped to test/ so it does not pick up the root
// app's Convex tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    root: __dirname,
  },
});
