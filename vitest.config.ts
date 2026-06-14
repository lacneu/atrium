/// <reference types="vitest/config" />
import path from "path";
import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-process against an in-memory backend.
// It requires the edge-runtime environment (Web APIs like crypto.subtle, which
// our API-key hashing depends on) and convex-test inlined so its ESM is
// transformed. See convex/_generated/ai/guidelines.md "Testing guidelines".
//
// The `src/**/*.test.ts` glob also picks up the routing search-schema tests.
// Those are PURE (only zod + the framework-free filters/types.ts), so they run
// fine under edge-runtime and keep the Convex tests green. The `@` alias mirrors
// vite.config.ts so `@/...` imports resolve in tests too.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "edge-runtime",
    // Stub localStorage so tests importing Paraglide message fns (`m.*`) resolve
    // to the baseLocale instead of crashing (see vitest.setup.ts).
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
    include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
  },
});
