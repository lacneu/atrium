// Every sign-in provider the deployment can enable has a way to use it.
//
// THE DEFECT THIS GUARDS, found on 2026-09-12 and pre-existing: `authProviders`
// reported `microsoft`, both locales carried `app_signin_microsoft`, and the
// sign-in screen rendered no button for it. A deployment configured for Microsoft
// alone therefore showed an EMPTY card — the "no provider enabled" notice stays
// hidden precisely because a provider IS enabled — and nobody could sign in. The
// failure is silent by construction: nothing throws, nothing logs, the screen is
// just blank where the button should be.
//
// The rule is a pairing between two files that have no reason to know about each
// other, which is exactly why it drifted: the server decides what is available,
// the screen decides what is offered, and only a reader comparing them notices.
//
// `anonymous` is excluded deliberately: it is the dev-only escape hatch and has
// its own button outside the provider list, styled and placed differently.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const ME = readFileSync(path.join(ROOT, "convex/me.ts"), "utf-8");
const ROUTER = readFileSync(path.join(ROOT, "src/router.tsx"), "utf-8");

/** The provider keys `api.me.authProviders` returns to the sign-in screen. */
function reportedProviders(): string[] {
  const start = ME.indexOf("export const authProviders = query({");
  expect(start, "authProviders must still exist in convex/me.ts").toBeGreaterThan(-1);
  const end = ME.indexOf("});", start);
  const body = ME.slice(start, end);
  // The keys of the returned object literal, at its own indentation level.
  return [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
}

/**
 * Reporting key → the id the provider is REGISTERED under, where they differ.
 *
 * They differ because the key names the env trio an operator sets
 * (`AUTH_MICROSOFT_ENTRA_ID_*`) while the id comes from `@auth/core`
 * (`microsoft-entra-id`). `signIn` takes the ID: a button wired to the key throws
 * "Provider `microsoft` is not configured" and the person sees the generic
 * refusal — a button that renders and cannot work, which is worse than none.
 *
 * Written down here rather than inferred, because an earlier version of this
 * guard asserted the KEY and was therefore green on exactly that bug — and would
 * have turned red on the fix.
 */
const PROVIDER_ID: Record<string, string> = {
  microsoft: "microsoft-entra-id",
};

describe("the sign-in screen offers what the deployment enabled", () => {
  test("the extraction still finds the providers it is meant to check", () => {
    // Both assertions below compare against an EMPTY list when the extraction
    // finds nothing — so a reindentation of the handler in convex/me.ts would turn
    // this whole file green while checking nothing, reproducing the very defect it
    // exists to prevent. The anchor guard covers the block, not the keys inside it.
    const reported = reportedProviders();
    expect(reported.length).toBeGreaterThanOrEqual(3);
    expect(reported).toContain("google");
    expect(reported).toContain("authelia");
  });

  test("every reported provider has a guarded button that signs in with it", () => {
    const missing = reportedProviders()
      .filter((key) => key !== "anonymous")
      .filter(
        (key) =>
          !ROUTER.includes(`providers?.${key} ?`) ||
          !ROUTER.includes(`oauth("${PROVIDER_ID[key] ?? key}")`),
      );

    expect(
      missing,
      "these providers can be enabled but the sign-in screen renders no button for them, " +
        "so such a deployment shows an empty card and nobody can sign in",
    ).toEqual([]);
  });

  test("every reported provider counts toward the `none enabled` notice", () => {
    // Otherwise a deployment with ONLY that provider configured is told no
    // provider is enabled — the opposite of the truth, and the one message that
    // would have sent an operator looking in the right place.
    const notice = ROUTER.slice(
      ROUTER.indexOf("const noneEnabled ="),
      ROUTER.indexOf(";", ROUTER.indexOf("const noneEnabled =")),
    );
    const missing = reportedProviders().filter(
      (key) => !notice.includes(`providers.${key}`),
    );

    expect(missing, "absent from the noneEnabled computation").toEqual([]);
  });
});
