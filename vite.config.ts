import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

// Mirrors the claude-monitor stack: Vite + React + Tailwind v4 plugin, "@" -> ./src.
export default defineConfig({
  plugins: [
    // i18n: compile the inlang catalogs (messages/{locale}.json) into tree-shaken,
    // type-safe message functions under src/paraglide (generated, git-ignored).
    // strategy ["localStorage","baseLocale"] owns first-paint with NO flash: an
    // unset locale falls back to baseLocale "fr"; a switch writes localStorage +
    // reloads. Convex stays the cross-device source that hydrates localStorage.
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      strategy: ["localStorage", "baseLocale"],
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 5174 (not 5173) so it cohabits with claude-monitor's Vite on 5173.
  server: { port: 5174, strictPort: true },
});
