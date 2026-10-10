export const AUTHELIA_LOGIN_KEY = "atrium.authelia-login";
export type AutheliaLoginState = "redirecting" | "failed" | "signed-out" | "unavailable";
type LoginStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type NativeSignIn = (
  provider: string,
  params: { redirectTo: string },
) => Promise<{ signingIn: boolean; redirect?: URL }>;

/** Preserve deep links, but never forward OAuth response parameters or another origin. */
export function autheliaReturnPath(location: Pick<Location, "href" | "origin">): string {
  const url = new URL(location.href);
  if (url.origin !== location.origin) throw new Error("Invalid login return origin.");
  for (const key of ["code", "state", "error", "error_description"]) {
    url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** One automatic attempt per tab; failures and deliberate sign-out require a click. */
export function createAutheliaLogin(storage: LoginStorage, returnPath: () => string) {
  let pending: Promise<AutheliaLoginState> | undefined;
  return {
    start(signIn: NativeSignIn, manual = false): Promise<AutheliaLoginState> {
      if (pending) return pending;
      try {
        const previous = storage.getItem(AUTHELIA_LOGIN_KEY);
        if (!manual && previous !== null) {
          return Promise.resolve(previous === "signed-out" ? "signed-out" : "failed");
        }
        storage.setItem(AUTHELIA_LOGIN_KEY, "attempted");
      } catch {
        // Without persistent attempt state, a callback failure could redirect forever.
        return Promise.resolve("failed");
      }
      pending = (async (): Promise<AutheliaLoginState> => {
        try {
          const result = await signIn("authelia", { redirectTo: returnPath() });
          return result.redirect || result.signingIn ? "redirecting" : "failed";
        } catch {
          return "failed";
        }
      })().finally(() => { pending = undefined; });
      return pending;
    },
    signedOut() {
      try { storage.setItem(AUTHELIA_LOGIN_KEY, "signed-out"); } catch { /* No automatic retry without storage. */ }
    },
    authenticated() {
      try { storage.removeItem(AUTHELIA_LOGIN_KEY); } catch { /* Authentication already succeeded. */ }
    },
  };
}

let browserLogin: ReturnType<typeof createAutheliaLogin> | undefined;
export function autheliaBrowserLogin() {
  // Resolve sessionStorage lazily: disabled browser storage is handled by the controller.
  browserLogin ??= createAutheliaLogin({
    getItem: (key) => window.sessionStorage.getItem(key),
    setItem: (key, value) => window.sessionStorage.setItem(key, value),
    removeItem: (key) => window.sessionStorage.removeItem(key),
  }, () => autheliaReturnPath(window.location));
  return browserLogin;
}
