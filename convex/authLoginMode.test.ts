/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { autheliaOnlyLogin } from "./lib/authLoginMode";

const modules = import.meta.glob("./**/*.ts");
beforeEach(() => {
  vi.stubEnv("AUTH_LOGIN_MODE", "providers");
  vi.stubEnv("AUTH_GOOGLE_ID", "test-google-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "test-google-secret");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "test-microsoft-id");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET", "test-microsoft-secret");
  vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", "https://issuer.example.org/");
  vi.stubEnv("AUTH_AUTHELIA_ID", "test-authelia-id");
  vi.stubEnv("AUTH_AUTHELIA_SECRET", "test-authelia-secret");
  vi.stubEnv("AUTH_AUTHELIA_ISSUER", "https://auth.example.org");
  vi.stubEnv("OPENCLAW_ENABLE_ANON_AUTH", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("server-resolved login mode", () => {
  test("existing installations keep their provider chooser", async () => {
    delete process.env.AUTH_LOGIN_MODE;
    expect(autheliaOnlyLogin()).toBe(false);
    expect(await convexTest(schema, modules).query(api.me.authProviders, {})).toEqual({
      autheliaOnly: false, google: true, microsoft: true, authelia: true, anonymous: true,
    });
  });
  test("exclusive mode disables alternative sign-in even with credentials present", async () => {
    vi.stubEnv("AUTH_LOGIN_MODE", "authelia-only");
    expect(await convexTest(schema, modules).query(api.me.authProviders, {})).toEqual({
      autheliaOnly: true, google: false, microsoft: false, authelia: true, anonymous: false,
    });
  });
  test.each(["AUTH_AUTHELIA_ID", "AUTH_AUTHELIA_SECRET", "AUTH_AUTHELIA_ISSUER"])("missing %s never enables a fallback", async (key) => {
    vi.stubEnv("AUTH_LOGIN_MODE", "authelia-only");
    vi.stubEnv(key, "");
    expect(await convexTest(schema, modules).query(api.me.authProviders, {})).toEqual({
      autheliaOnly: true, google: false, microsoft: false, authelia: false, anonymous: false,
    });
  });
  test("a typo fails closed instead of selecting the default", async () => {
    vi.stubEnv("AUTH_LOGIN_MODE", "authelia-onyl");
    expect(() => autheliaOnlyLogin()).toThrow("AUTH_LOGIN_MODE");
    await expect(convexTest(schema, modules).query(api.me.authProviders, {})).rejects.toThrow("AUTH_LOGIN_MODE");
  });
});
