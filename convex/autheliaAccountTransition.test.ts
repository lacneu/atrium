/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

beforeEach(() => {
  vi.stubEnv("AUTH_LOGIN_MODE", "authelia-only");
  vi.stubEnv("AUTH_AUTHELIA_ID", "fixture-atrium");
  vi.stubEnv("AUTH_AUTHELIA_SECRET", "fixture-only");
  vi.stubEnv("AUTH_AUTHELIA_ISSUER", "https://auth.example.com");
  vi.stubEnv("AUTH_ALLOWED_EMAIL_DOMAINS", "example.com");
  vi.stubEnv("OPENCLAW_ENABLE_ANON_AUTH", "0");
});
afterEach(() => vi.unstubAllEnvs());

describe("Google to Authelia account continuity through the real Convex Auth store", () => {
  test("a unique verified legacy email retains the same administrator and conversations", async () => {
    const t = convexTest(schema, modules);
    const legacy = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "owner@example.com", emailVerificationTime: 1, name: "Owner",
      });
      const profileId = await ctx.db.insert("profiles", {
        userId, role: "admin", canonical: "owner", name: "Owner", email: "owner@example.com",
      });
      await ctx.db.insert("authAccounts", { userId, provider: "google", providerAccountId: "legacy-google-owner" });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1, title: "Existing conversation" });
      const messageId = await ctx.db.insert("messages", {
        chatId, userId, role: "user", status: "complete", text: "Fixture history", updatedAt: 1,
      });
      await ctx.db.insert("authVerifiers", { signature: "fixture-verified-oauth-state" });
      return { userId, profileId, chatId, messageId };
    });

    // OAuth validates the issuer, state and verified email before reaching this store.
    await t.mutation(internal.auth.store, { args: {
      type: "userOAuth", provider: "authelia", providerAccountId: "authelia-owner",
      profile: { email: "owner@example.com", name: "Owner from Authelia" },
      signature: "fixture-verified-oauth-state",
    } });
    await t.withIdentity({ subject: `${legacy.userId}|fixture-session` }).mutation(api.me.bootstrap, {});

    await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      expect(users).toHaveLength(1);
      expect(users[0]._id).toBe(legacy.userId);
      const accounts = await ctx.db.query("authAccounts").collect();
      expect(accounts.map((account) => account.provider).sort()).toEqual(["authelia", "google"]);
      expect(accounts.every((account) => account.userId === legacy.userId)).toBe(true);
      expect(await ctx.db.get(legacy.profileId)).toMatchObject({ role: "admin", canonical: "owner" });
      expect(await ctx.db.get(legacy.chatId)).toMatchObject({ userId: legacy.userId, title: "Existing conversation" });
      expect(await ctx.db.get(legacy.messageId)).toMatchObject({ chatId: legacy.chatId, text: "Fixture history" });
    });
  });
});
