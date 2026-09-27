// THE EXECUTION-PERMISSIONS PICKER'S REACT WIRING — pinned on the source,
// comment-stripped (commenting a guard out is exactly how it would disappear). The
// decisions themselves are pure helpers, tested in permissionModeView.test.ts.
//
//  - the composer carries the picker, scoped to the agent the next message goes to;
//  - the header's Advanced popover carries the same choice;
//  - the header no longer carries a permission chip (the visibility chip stays);
//  - a pick goes through the view's own rule, and the digit shortcuts only exist on the
//    OPEN menu's content (never a global key handler).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf-8"));
const CHAT = read("src/chat/ConvexChat.tsx");
const PICKER = read("src/chat/PermissionModePicker.tsx");
const INSTANCES = read("src/chat/admin/InstancesTab.tsx");

function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} moved`).toBeGreaterThan(-1);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("where the picker lives", () => {
  test("in the composer bar, right after the room selector, scoped to the next target", () => {
    const composer = fn(CHAT, "Composer");
    const agent = composer.indexOf("<ComposerAgentSelect");
    const picker = composer.indexOf("<PermissionModePicker");
    expect(agent).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(agent);
    expect(composer.slice(picker, picker + 400)).toMatch(/routedAgent=\{\s*composerTarget/);
  });

  test("in the Advanced popover, beside the session knobs", () => {
    const menu = fn(CHAT, "SessionKnobsMenu");
    expect(menu).toMatch(/<SessionKnobsGroup[\s\S]*<PermissionModeSection/);
  });

  test("the header renders no permission chip any more, and keeps the visibility chip", () => {
    const header = fn(CHAT, "ChatHeader");
    expect(header).not.toMatch(/permissionChip/);
    expect(header).not.toMatch(/oc-chip--access/);
    expect(header).toMatch(/visibilityChipView\(sm\)/);
  });
});

describe("how a pick is made", () => {
  test("every pick goes through shouldSubmitChoice before the mutation", () => {
    const hook = fn(PICKER, "usePermissionControl");
    expect(hook).toMatch(/if \(shouldSubmitChoice\(value, view, choice\)\) pickRaw\(value\)/);
    expect(hook).toMatch(/useMutation\(api\.permissionMode\.setPermissionMode\)/);
  });

  test("capabilities unresolved fail CLOSED (the control appears only on a resolved snapshot)", () => {
    const hook = fn(PICKER, "usePermissionControl");
    expect(hook).toMatch(/caps\.loading \|\| !caps\.resolved\s*\?\s*"unknown"/);
    expect(hook).toMatch(/caps\.provider === "hermes"/);
    expect(hook).toMatch(/caps\.can\("permissionModes"\)/);
  });

  test("the digit shortcuts live on the OPEN menu's content only", () => {
    const picker = fn(PICKER, "PermissionModePicker");
    expect(picker).toMatch(/<DropdownMenuContent[\s\S]*onKeyDown=\{onKeyDown\}/);
    expect(picker).toMatch(/shortcutChoice\(e\.key, view\.items\)/);
    expect(PICKER).not.toMatch(/addEventListener\(\s*"keydown"/);
  });

  test("disabled options are disabled in the DOM, full carries its reason", () => {
    expect(PICKER).toMatch(/disabled=\{item\.disabled\}/);
    expect(PICKER).toMatch(/item\.disabledReason !== null/);
  });
});

describe("the per-instance admin setting", () => {
  test("OpenClaw instances get the setting, it is saved, and it defaults to off", () => {
    expect(INSTANCES).toMatch(/form\.kind === "openclaw" \? \(\s*<Field label=\{m\.settings_field_manage_permissions\(\)\}>/);
    expect(INSTANCES).toMatch(/managePermissionModes: form\.managePermissionModes/);
    expect(INSTANCES).toMatch(/managePermissionModes: false,/);
    expect(INSTANCES).toMatch(/managePermissionModes: i\.managePermissionModes === true/);
  });

  test("the picker is fed the next target's managed flag and the conversation's", () => {
    const hook = fn(PICKER, "usePermissionControl");
    expect(hook).toMatch(/managed: ctl\.managed,\s*anyManaged: ctl\.anyManaged/);
  });
});
