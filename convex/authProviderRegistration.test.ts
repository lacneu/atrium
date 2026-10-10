import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const capture = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@convex-dev/auth/server", () => ({
  convexAuth: (config: { providers: Array<{ id: string }> }) => {
    capture.ids = config.providers.map((provider) => provider.id);
    return {};
  },
}));
beforeEach(() => {
  vi.resetModules();
  for (const key of ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET", "AUTH_AUTHELIA_ID", "AUTH_AUTHELIA_SECRET"]) vi.stubEnv(key, "test-only");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", "https://issuer.example.org");
  vi.stubEnv("AUTH_AUTHELIA_ISSUER", "https://auth.example.org");
  vi.stubEnv("OPENCLAW_ENABLE_ANON_AUTH", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("actual provider registration passed to Convex Auth", () => {
  test("exclusive mode registers only Authelia, not hidden Google or anonymous providers", async () => {
    vi.stubEnv("AUTH_LOGIN_MODE", "authelia-only");
    await import("./auth");
    expect(capture.ids).toEqual(["authelia"]);
  });
  test("default mode preserves providers on other installations", async () => {
    vi.stubEnv("AUTH_LOGIN_MODE", "providers");
    await import("./auth");
    // Anonymous uses a credentials factory; Convex Auth normalizes its options.id later.
    expect(capture.ids).toEqual(["google", "microsoft-entra-id", "authelia", "credentials"]);
  });
  test("exclusive mode with incomplete Authelia registers no fallback", async () => {
    vi.stubEnv("AUTH_LOGIN_MODE", "authelia-only");
    vi.stubEnv("AUTH_AUTHELIA_SECRET", "");
    await import("./auth");
    expect(capture.ids).toEqual([]);
  });
});
