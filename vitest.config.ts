/// <reference types="vitest/config" />
import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

// convex-test runs Convex functions in-process against an in-memory backend.
// It requires the edge-runtime environment (Web APIs like crypto.subtle, which
// our API-key hashing depends on) and convex-test inlined so its ESM is
// transformed. See convex/_generated/ai/guidelines.md "Testing guidelines".
//
// The `src/**/*.test.ts` glob also picks up the routing search-schema tests.
// Those are PURE (only zod + the framework-free filters/types.ts), so they run
// fine under edge-runtime and keep the Convex tests green. The `@` alias mirrors
// vite.config.ts so `@/...` imports resolve in tests too.
//
// The guard that drives a browser in REAL time (frames, transitions, real input:
// src/chat/queueReserve.test.ts, lot 30) runs in a group of its own, after every other
// file (sequence.groupOrder): its experiments act within a window of 100 to 300 ms, which
// the 400-odd other files would otherwise crowd. The guards that lay the app out in
// VIRTUAL time stay with the rest: their outcome does not depend on the machine's load.
const REAL_TIME = ["src/chat/queueReserve.test.ts"];

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
    // deploy/gc: the physical storage collector (plain Node; its tests opt into
    // the node environment per file). The REAL-TIME browser probe runs after all the
    // rest, alone (see REAL_TIME).
    projects: [
      {
        extends: true,
        test: {
          name: "suite",
          include: ["convex/**/*.test.ts", "src/**/*.test.ts", "deploy/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...REAL_TIME],
        },
      },
      {
        extends: true,
        test: {
          name: "real-time",
          include: REAL_TIME,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
