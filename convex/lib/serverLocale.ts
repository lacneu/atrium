// Server-side locale resolution helpers — the ONE place Convex functions read
// "which language" from the database, on top of the pure chains in
// lib/locales.ts.
//
// Two DISTINCT locales exist by design:
//  - UI locale (per USER): what the recipient reads notifications/UI in —
//    profiles.locale -> appMeta.defaultLocale -> BASE_LOCALE (localeForUser).
//  - CONTENT locale (per INSTANCE): the language of server-GENERATED,
//    agent-facing material (prompt injections, rehydration framing, briefs) —
//    instance.config.contentLocale -> appMeta.defaultLocale -> BASE_LOCALE
//    (contentLocaleForInstance). Anchored on the instance, not the reader: a
//    prompt is instance configuration and must match the Settings preview.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  resolveContentLocale,
  resolveLocale,
  type Locale,
} from "./locales";
import type { InstanceConfig } from "./instanceConfig";

// Mirror of the appMeta singleton key used by me.ts/admin.ts (module-private
// there; the row is a singleton so the literal is stable).
const APP_META_KEY = "singleton";

async function readAdminDefaultLocale(
  ctx: QueryCtx | MutationCtx,
): Promise<string | undefined> {
  const meta = await ctx.db
    .query("appMeta")
    .withIndex("by_key", (q) => q.eq("key", APP_META_KEY))
    .unique();
  return meta?.defaultLocale ?? undefined;
}

/** The UI language a given user reads — for anything the server renders FOR a
 *  specific recipient (write-time fallbacks; prefer key+params rendered at read
 *  where possible). */
export async function localeForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Locale> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return resolveLocale(profile?.locale, await readAdminDefaultLocale(ctx));
}

/** The CONTENT language for agent-facing material generated on behalf of an
 *  instance (prompt injections, rehydration framing, curation briefs). */
export async function contentLocaleForInstance(
  ctx: QueryCtx | MutationCtx,
  instanceConfig: InstanceConfig | undefined,
): Promise<Locale> {
  return resolveContentLocale(
    instanceConfig?.contentLocale,
    await readAdminDefaultLocale(ctx),
  );
}
