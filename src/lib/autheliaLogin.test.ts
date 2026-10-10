import { describe, expect, test, vi } from "vitest";
import { AUTHELIA_LOGIN_KEY, autheliaReturnPath, createAutheliaLogin } from "./autheliaLogin";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const signIn = vi.fn(async () => ({ signingIn: false, redirect: new URL("https://auth.example.org/") }));
  return { values, storage, signIn, login: createAutheliaLogin(storage, () => "/chat/example?view=thread") };
}

describe("automatic native Authelia sign-in", () => {
  test("starts Authelia directly and preserves the deep link", async () => {
    const { login, signIn, values } = fixture();
    expect(await login.start(signIn)).toBe("redirecting");
    expect(signIn).toHaveBeenCalledExactlyOnceWith("authelia", { redirectTo: "/chat/example?view=thread" });
    expect(values.get(AUTHELIA_LOGIN_KEY)).toBe("attempted");
  });
  test("deduplicates concurrent effects without another OAuth attempt", async () => {
    const { login, signIn } = fixture();
    const first = login.start(signIn);
    const second = login.start(signIn);
    expect(first).toBe(second);
    expect(await second).toBe("redirecting");
    expect(signIn).toHaveBeenCalledTimes(1);
  });
  test("returning unauthenticated does not start another redirect", async () => {
    const { login, signIn } = fixture();
    await login.start(signIn);
    expect(await login.start(signIn)).toBe("failed");
    expect(signIn).toHaveBeenCalledTimes(1);
  });
  test("the callback guard survives a page reload", async () => {
    const { login, storage, signIn } = fixture();
    await login.start(signIn);
    const reloaded = createAutheliaLogin(storage, () => "/");
    expect(await reloaded.start(signIn)).toBe("failed");
    expect(signIn).toHaveBeenCalledTimes(1);
  });
  test("a failed native call is explicit and does not auto-retry", async () => {
    const { login } = fixture();
    const failing = vi.fn(async () => { throw new Error("test failure"); });
    expect(await login.start(failing)).toBe("failed");
    expect(await login.start(failing)).toBe("failed");
    expect(failing).toHaveBeenCalledTimes(1);
  });
  test("a result without redirect or authentication is a failure", async () => {
    const { login } = fixture();
    expect(await login.start(async () => ({ signingIn: false }))).toBe("failed");
  });
  test("accepts an immediate sign-in handshake", async () => {
    const { login } = fixture();
    expect(await login.start(async () => ({ signingIn: true }))).toBe("redirecting");
  });
  test("only an explicit retry can restart after failure", async () => {
    const { login, signIn } = fixture();
    await login.start(async () => ({ signingIn: false }));
    expect(await login.start(signIn, true)).toBe("redirecting");
    expect(signIn).toHaveBeenCalledTimes(1);
  });
  test("sign-out pauses sign-in including after reload", async () => {
    const { login, storage, signIn } = fixture();
    login.signedOut();
    expect(await login.start(signIn)).toBe("signed-out");
    expect(await createAutheliaLogin(storage, () => "/").start(signIn)).toBe("signed-out");
    expect(signIn).not.toHaveBeenCalled();
    expect(await login.start(signIn, true)).toBe("redirecting");
  });
  test("successful authentication clears the marker for a future expired session", async () => {
    const { login, signIn, values } = fixture();
    await login.start(signIn);
    login.authenticated();
    expect(values.has(AUTHELIA_LOGIN_KEY)).toBe(false);
    expect(await login.start(signIn)).toBe("redirecting");
    expect(signIn).toHaveBeenCalledTimes(2);
  });
  test.each(["getItem", "setItem"] as const)("storage %s failure prevents automatic OAuth", async (operation) => {
    const { storage, signIn } = fixture();
    const broken = { ...storage, [operation]: () => { throw new Error("storage unavailable"); } };
    expect(await createAutheliaLogin(broken, () => "/").start(signIn)).toBe("failed");
    expect(signIn).not.toHaveBeenCalled();
  });
  test("cleanup and sign-out tolerate disabled storage", () => {
    const broken = () => { throw new Error("storage unavailable"); };
    const login = createAutheliaLogin({ getItem: broken, setItem: broken, removeItem: broken }, () => "/");
    expect(() => login.signedOut()).not.toThrow();
    expect(() => login.authenticated()).not.toThrow();
  });
  test("return-path failure stops the attempt without a native call", async () => {
    const { storage, signIn } = fixture();
    const login = createAutheliaLogin(storage, () => { throw new Error("bad path"); });
    expect(await login.start(signIn)).toBe("failed");
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("Authelia return path", () => {
  test("keeps same-origin path, query and fragment", () => {
    expect(autheliaReturnPath({ href: "https://atrium.example.org/chat/abc?tab=files#last", origin: "https://atrium.example.org" }))
      .toBe("/chat/abc?tab=files#last");
  });
  test("removes OAuth callback parameters", () => {
    expect(autheliaReturnPath({ href: "https://atrium.example.org/?code=secret&state=x&error=denied&error_description=x&tab=files", origin: "https://atrium.example.org" }))
      .toBe("/?tab=files");
  });
  test("rejects a different origin", () => {
    expect(() => autheliaReturnPath({ href: "https://evil.example.org/", origin: "https://atrium.example.org" })).toThrow("origin");
  });
});
