import { useEffect, useState, type ReactNode } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { m } from "./paraglide/messages.js";
import { autheliaBrowserLogin, type AutheliaLoginState } from "./lib/autheliaLogin";

/** Resolve the login surface before any legacy provider controls can appear. */
export function LoginBoundary({ providers, children }: {
  providers: { autheliaOnly: boolean; authelia: boolean } | undefined;
  children: ReactNode;
}) {
  if (providers === undefined) return <div className="oc-boot">{m.app_loading()}</div>;
  if (providers.autheliaOnly) return <AutheliaLogin enabled={providers.authelia} />;
  return children;
}

/** A status surface, not a provider chooser. Retry is explicit after failure/logout. */
export function AutheliaLoginStatus({ state, retry }: {
  state: AutheliaLoginState;
  retry: () => void;
}) {
  return (
    <div className="oc-signin">
      <div className="oc-signin__card" role="status" aria-live="polite">
        <p className="oc-signin__subtitle">
          {state === "redirecting" ? m.app_authelia_redirecting()
            : state === "signed-out" ? m.app_authelia_signed_out()
            : state === "unavailable" ? m.app_signin_none_enabled()
            : m.app_authelia_failed()}
        </p>
        {state === "failed" || state === "signed-out" ? (
          <button type="button" className="oc-provider" onClick={retry}>
            {m.app_signin_authelia()}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function AutheliaLogin({ enabled }: { enabled: boolean }) {
  const { signIn } = useAuthActions();
  const [state, setState] = useState<AutheliaLoginState>(enabled ? "redirecting" : "unavailable");
  useEffect(() => {
    let current = true;
    if (enabled) {
      void autheliaBrowserLogin().start(signIn).then((result) => {
        if (current) setState(result);
      });
    } else setState("unavailable");
    return () => { current = false; };
  }, [enabled, signIn]);
  return <AutheliaLoginStatus state={state} retry={() => {
    setState("redirecting");
    void autheliaBrowserLogin().start(signIn, true).then(setState);
  }} />;
}
