/// <reference types="vite/client" />
//
// What a hover reveals, a finger must find in place (lot 4, 2026-11).
//
// THE DEFECT. A dozen controls were shown only while their row was hovered —
// conversation and folder menus, a table row's actions, the copy of a tool's
// output, a reply's bookmark and reply buttons, the "make default" star — written
// each time anew, in Tailwind (`opacity-0 group-hover/row:opacity-100`) or in CSS
// (`.row:hover .x { opacity: 1 }`), and almost never with a fallback: on a phone
// they were invisible, reachable only by tapping blindly where they had to be.
//
// THE FIX is one class, `.oc-reveal` (convexChat.css), whose touch fallback uses
// the same query as the JS side (TOUCH_REVEAL_QUERY). These tests hold the two in
// step, and DERIVE the ratchet from the sources: no live control may be revealed on
// hover without the fallback — whichever way it is written.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TOUCH_REVEAL_QUERY } from "@/lib/useMediaQuery";
import { composerAutoFocus, messageActionsAutohide } from "./touchReveal";

const SRC = join(process.cwd(), "src");

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "paraglide" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

type Rule = { selector: string; body: string; media: string | null };

/** The style rules of a stylesheet, with the @media they sit in (one level). */
function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const parse = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) parse(body, head.slice(6).trim());
      else if (!head.startsWith("@")) out.push({ selector: head, body, media });
      i = j;
    }
  };
  parse(src, null);
  return out;
}

const STYLESHEETS = walk(SRC, ".css");
const ALL_RULES = STYLESHEETS.flatMap((f) => rules(readFileSync(f, "utf-8")));
const TSX = walk(SRC, ".tsx").map((f) => ({ f, src: readFileSync(f, "utf-8") }));

/** A class some component actually renders (dead CSS does not count). */
function isLive(cls: string): boolean {
  const name = cls.slice(1);
  return TSX.some(({ src }) => new RegExp(`["'\`\\s]${name}["'\`\\s$]`).test(src));
}

const isTouchQuery = (media: string | null) =>
  media !== null && /hover:\s*none|any-pointer:\s*coarse/.test(media);

describe("one reveal class, with the touch fallback", () => {
  test("its fallback is the query the JS side uses (TOUCH_REVEAL_QUERY)", () => {
    const fallback = ALL_RULES.find(
      (r) => r.selector === ".oc-reveal" && /opacity:\s*1/.test(r.body) && r.media !== null,
    );
    expect(fallback, "no touch fallback for .oc-reveal").toBeDefined();
    expect(fallback!.media).toBe(TOUCH_REVEAL_QUERY);
  });

  test("hidden at rest, shown while its NEAREST host is hovered or focused", () => {
    const base = ALL_RULES.find((r) => r.selector === ".oc-reveal" && r.media === null);
    expect(base?.body).toMatch(/opacity:\s*0/);
    const shown = ALL_RULES.find(
      (r) => r.selector.includes(".oc-reveal-host:hover") && /opacity:\s*1/.test(r.body),
    );
    expect(shown, "no hover rule for .oc-reveal").toBeDefined();
    // A host nested in another (a tool card in a message) keeps its controls to
    // itself: the outer host's hover must not reveal them.
    expect(shown!.selector).toContain(":not(.oc-reveal-host:not(:hover) .oc-reveal)");
    expect(shown!.selector).toContain(".oc-reveal-host:focus-within");
    expect(shown!.selector).toContain('[aria-expanded="true"]');
  });
});

describe("no control is revealed on hover without the fallback (derived)", () => {
  test("Tailwind: no class list hides a control and shows it on a group hover", () => {
    const offenders: string[] = [];
    for (const { f, src } of TSX) {
      for (const m of src.matchAll(/["'`]([^"'`]*\bopacity-0\b[^"'`]*)["'`]/g)) {
        if (/group-hover\/[\w-]+:opacity-100/.test(m[1])) {
          offenders.push(`${f.slice(SRC.length + 1)}: ${m[1].slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the derivation sees the pattern: the thumbnails' controls, with their own fallback", () => {
    const thumb = hoverRevealed().find((c) => c.cls === ".oc-attach__remove");
    expect(thumb, "the derivation no longer finds a hover-revealed control").toBeDefined();
    expect(thumb!.fallback).toBe(true);
  });

  test("CSS: every live control hidden at rest and shown on hover has a touch fallback", () => {
    expect(hoverRevealed().filter((c) => !c.fallback).map((c) => c.cls)).toEqual([]);
  });
});

/** Live classes hidden at rest (opacity 0, outside any @media) and shown on a hover,
 *  each with whether a touch query shows them too. */
function hoverRevealed(): { cls: string; fallback: boolean }[] {
  const lastCompound = (sel: string) => sel.trim().split(/\s+/).pop() ?? "";
  const hidden = new Set<string>();
  for (const r of ALL_RULES) {
    if (r.media !== null || !/(^|;)\s*opacity:\s*0\s*(;|$)/.test(r.body)) continue;
    for (const sel of r.selector.split(",")) {
      const last = lastCompound(sel);
      const cls = last.match(/^\.[\w-]+/)?.[0];
      if (cls && cls !== ".oc-reveal" && !/:hover|::/.test(last)) hidden.add(cls);
    }
  }
  const out: { cls: string; fallback: boolean }[] = [];
  for (const cls of hidden) {
    if (!isLive(cls)) continue;
    const shownBy = (r: Rule, hover: boolean) =>
      /opacity:\s*1/.test(r.body) &&
      r.selector
        .split(",")
        .some((s) => (!hover || s.includes(":hover")) && lastCompound(s).startsWith(cls));
    if (!ALL_RULES.some((r) => shownBy(r, true))) continue;
    out.push({ cls, fallback: ALL_RULES.some((r) => isTouchQuery(r.media) && shownBy(r, false)) });
  }
  return out;
}

describe("message action bars", () => {
  test("hover-revealed under a mouse, always there where a finger is used", () => {
    expect(messageActionsAutohide(false)).toBe("not-last");
    expect(messageActionsAutohide(true)).toBe("never");
  });
});

describe("the composer's own focus (lot 8, G14)", () => {
  test("taken under a mouse, never under a finger (it would raise the keyboard)", () => {
    expect(composerAutoFocus(false)).toBe(true);
    expect(composerAutoFocus(true)).toBe(false);
  });
});
