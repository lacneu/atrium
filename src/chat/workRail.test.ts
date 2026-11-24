/// <reference types="vite/client" />
//
// The turn's work on ONE rail (convexChat.css `.oc-work`): the wiring a render shows and no
// behavioural test reaches. Like mediaLayout.test.ts, a syntactic tripwire — it reads the
// sources, renders nothing — for the points whose loss would bring back what the lot
// removed: a box around every action, a "Réflexion" header on every thought, an answer
// stuck to the rail.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), "src/chat", file), "utf-8");
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
const CSS = read("convexChat.css").replace(/\/\*[\s\S]*?\*\//g, " ");

/** The declarations of the FIRST rule whose selector list is exactly `selector`. */
function block(selector: string): string {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&").replace(/\s+/g, "\\s+")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(CSS);
  expect(m, `no rule for ${selector}`).not.toBeNull();
  return m![2];
}

describe("every kind of work hangs on the rail, out of the bookmark blocks", () => {
  test.each([
    ["ReasoningBlocks.tsx", "oc-thinking"],
    ["ReasoningBlocks.tsx", "oc-msg__note"],
    ["InlineTurnActivity.tsx", "oc-flowact"],
    ["WorkZone.tsx", "oc-workhead"],
  ])("%s: %s", (file, cls) => {
    expect(code(file)).toContain(`className="oc-msg__meta oc-work ${cls}"`);
  });
});

describe("one label per zone, none per thought", () => {
  test("a thought has no icon, no header row and no state of its own", () => {
    const src = code("ReasoningBlocks.tsx");
    expect(src).not.toMatch(/lucide-react|ActivityRow|useState/);
  });

  test("the header is the zone's: the brain, and the control that folds it", () => {
    const src = code("WorkZone.tsx");
    expect(src).toMatch(/<Brain /);
    expect(src).toMatch(/ariaExpanded=\{open\}/);
    expect(src).toMatch(/chooseZone\(zone\.key, !open\)/);
  });

  test("each kind of work asks its zone for the header and the fold", () => {
    expect(code("ReasoningBlocks.tsx").match(/useWorkZone\(/g)).toHaveLength(2);
    expect(code("InlineTurnActivity.tsx")).toMatch(/useWorkZone\(/);
  });
});

describe("the rail's look", () => {
  test("no box, no background at rest — over the meta block's card", () => {
    // The card rule (`.oc-msg__meta:has(.oc-actrow, …)`) comes later in the sheet: only a
    // heavier selector undoes it, hence the doubled list.
    const rules = block(".oc-msg__meta.oc-work, .oc-msg__meta.oc-work:has(.oc-actrow)");
    expect(rules).toMatch(/border:\s*0/);
    expect(rules).toMatch(/background:\s*transparent/);
    expect(rules).toMatch(/margin:\s*0/);
    expect(rules).toMatch(/color:\s*var\(--muted-foreground\)/);
  });

  test("the rail is drawn by each item over its whole box", () => {
    const rail = block(".oc-work::before");
    expect(rail).toMatch(/top:\s*0/);
    expect(rail).toMatch(/bottom:\s*0/);
  });

  test("the answer is set apart from the end of the rail", () => {
    expect(block(".oc-work + :not(.oc-work)")).toMatch(/margin-top:\s*1rem/);
  });

  test("a line of work is quiet: regular weight, muted", () => {
    const label = block(".oc-work > .oc-actrow .oc-actrow__label");
    expect(label).toMatch(/font-weight:\s*400/);
    expect(label).toMatch(/color:\s*var\(--muted-foreground\)/);
  });
});
