import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { RouterProvider } from "@tanstack/react-router";
import { m } from "@/paraglide/messages.js";
import { router } from "./router";
import { DialogsProvider } from "@/components/ConfirmDialog";
import { FeedbackProvider } from "./chat/FeedbackDialog";
import { resolveConvexUrl } from "@/lib/runtimeConfig";
import "./index.css";
import "./chat/convexChat.css";

// Router devtools, dev-only and lazy (import.meta.env.DEV is statically false in
// a production build, so the devtools package is tree-shaken out of the bundle).
const RouterDevtools = import.meta.env.DEV
  ? React.lazy(() =>
      import("@tanstack/react-router-devtools").then((m) => ({
        default: m.TanStackRouterDevtools,
      })),
    )
  : () => null;

// Minimal, dependency-free boot state (no Convex/router) so it renders even when
// config resolution fails. Theme is already applied by the inline script in
// index.html, so currentColor/inherited colors are correct in light/dark.
function BootMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        textAlign: "center",
        font: "14px system-ui, sans-serif",
        opacity: 0.6,
      }}
    >
      {children}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root")!);

// Splash immediately to avoid a blank flash while the runtime config resolves
// (a fast static fetch; see lib/runtimeConfig). Paraglide messages are
// compile-time functions on the localStorage/baseLocale strategy, so they are
// safe to call this early (no provider needed).
root.render(
  <React.StrictMode>
    <BootMessage>{m.common_loading()}</BootMessage>
  </React.StrictMode>,
);

// The Convex client is created ONCE, after the runtime config resolves, so the
// built bundle is origin-agnostic. Provider composition is unchanged
// (docs/ROUTING_RESEARCH.md §2): ConvexAuthProvider is OUTERMOST (its token
// source is mandatory for the whole auth-gated chat surface), RouterProvider
// nests inside, DialogsProvider wraps the router. The single ConvexReactClient
// keeps its WebSocket alive across client-side navigations.
resolveConvexUrl()
  .then((convexUrl) => {
    const convex = new ConvexReactClient(convexUrl);
    root.render(
      <React.StrictMode>
        <ConvexAuthProvider client={convex}>
          <DialogsProvider>
            <FeedbackProvider>
              <RouterProvider router={router} />
            </FeedbackProvider>
            <React.Suspense fallback={null}>
              {/* Dev-only. Toggle button bottom-RIGHT so it doesn't overlap the
                  sidebar's Settings button (default is bottom-left). */}
              <RouterDevtools router={router} position="bottom-right" />
            </React.Suspense>
          </DialogsProvider>
        </ConvexAuthProvider>
      </React.StrictMode>,
    );
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("Boot failed:", err);
    root.render(
      <React.StrictMode>
        <BootMessage>
          {m.boot_config_missing()}{" "}
          {err instanceof Error ? err.message : String(err)}
        </BootMessage>
      </React.StrictMode>,
    );
  });
