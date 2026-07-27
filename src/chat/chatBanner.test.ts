/// <reference types="vite/client" />
//
// The composer-area notice: which one, and in which order (W10 / G7).
//
// Extracted from a JSX ternary chain precisely so the ORDER is assertable. The new
// beyond-validated notice is the one whose placement is a judgement — it is a standing
// condition, not an incident, and a person whose send is blocked right now does not
// need to hear about version validation. That reasoning is only worth writing down if
// something fails when it is violated.

import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { chatBannerKind, type ChatBannerKind } from "./chatBanner";

const state = (over: Partial<Parameters<typeof chatBannerKind>[0]> = {}) => ({
  readOnly: false,
  unavailable: false,
  degraded: false,
  beyondValidated: false,
  ...over,
});

describe("chatBannerKind", () => {
  test("nothing wrong: no banner", () => {
    expect(chatBannerKind(state())).toBeNull();
  });

  test("each condition alone shows its own banner", () => {
    expect(chatBannerKind(state({ readOnly: true }))).toBe("read_only");
    expect(chatBannerKind(state({ unavailable: true }))).toBe("unavailable");
    expect(chatBannerKind(state({ degraded: true }))).toBe("degraded");
    expect(chatBannerKind(state({ beyondValidated: true }))).toBe(
      "beyond_validated",
    );
  });

  test("the version notice YIELDS to every blocking condition", () => {
    // The placement decision, stated as a test. An unvalidated gateway version is
    // still true tomorrow; a blocked send is about right now.
    for (const blocker of ["readOnly", "unavailable", "degraded"] as const) {
      const kind = chatBannerKind(state({ [blocker]: true, beyondValidated: true }));
      expect(kind, blocker).not.toBe("beyond_validated");
    }
  });

  test("the order is read_only > unavailable > degraded > beyond_validated", () => {
    // All four at once: the most urgent wins, and removing them one at a time walks
    // down the ladder. Pins the WHOLE order, not just the new entry's place in it.
    const all = state({
      readOnly: true,
      unavailable: true,
      degraded: true,
      beyondValidated: true,
    });
    const walked: ChatBannerKind[] = [
      chatBannerKind(all),
      chatBannerKind({ ...all, readOnly: false }),
      chatBannerKind({ ...all, readOnly: false, unavailable: false }),
      chatBannerKind({
        ...all,
        readOnly: false,
        unavailable: false,
        degraded: false,
      }),
    ];
    expect(walked).toEqual([
      "read_only",
      "unavailable",
      "degraded",
      "beyond_validated",
    ]);
  });
});

describe("the beyond-validated notice says the honest thing", () => {
  const messagesFor = (file: string): Record<string, string> =>
    JSON.parse(
      readFileSync(new URL(`../../messages/${file}`, import.meta.url), "utf-8"),
    ) as Record<string, string>;

  const locales = readdirSync(new URL("../../messages/", import.meta.url)).filter(
    (f) => f.endsWith(".json"),
  );

  test("both variants exist in EVERY locale, version-bearing and not", () => {
    // The version can be unknown (a bridge that reports the flag without the string),
    // so there are two texts and both must be translated everywhere. Reads the message
    // FILES, not the compiled accessor, which resolves one locale only.
    expect(locales.length).toBeGreaterThan(1);
    for (const f of locales) {
      const m = messagesFor(f);
      expect(m.chat_beyond_validated_banner, f).toBeTruthy();
      expect(m.chat_beyond_validated_banner_unknown, f).toBeTruthy();
      expect(m.chat_beyond_validated_banner, f).toContain("{version}");
      expect(m.chat_beyond_validated_banner_unknown, f).not.toContain("{version}");
    }
  });

  test("it does not claim anything is broken", () => {
    // Capabilities are FROZEN at the validated profile, so every control on screen has
    // been exercised. Telling the reader their gateway is failing would be false, and
    // scaring people is not the same as informing them.
    for (const f of locales) {
      const m = messagesFor(f);
      for (const key of [
        "chat_beyond_validated_banner",
        "chat_beyond_validated_banner_unknown",
      ]) {
        const text = (m[key] ?? "").toLowerCase();
        expect(text, `${key} in ${f}`).not.toMatch(
          /error|erreur|fail|échou|broken|cassé|indisponible|unavailable/,
        );
      }
    }
  });
});
