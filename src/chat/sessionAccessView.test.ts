/// <reference types="vite/client" />
//
// The two access chips of the conversation header — every branch, parameterized
// messages included (GC-P5 lesson: a branch nobody renders in a test ships broken).

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { permissionChipView, visibilityChipView } from "./sessionAccessView";

describe("permissionChipView — the EFFECTIVE mode, and where it comes from", () => {
  test("nothing known renders nothing: no meta, no mode reported, an unknown value", () => {
    expect(permissionChipView(null, "full")).toBeNull();
    expect(permissionChipView(undefined, null)).toBeNull();
    // A Hermes chat, or a gateway that does not project modes: the key is absent.
    expect(permissionChipView({ model: "m" } as never, "guarded")).toBeNull();
    // A future mode is not guessed at.
    expect(permissionChipView({ permissionMode: "yolo" }, null)).toBeNull();
  });

  test("a mode set on the session wins over the agent's default", () => {
    const v = permissionChipView({ permissionMode: "guarded" }, "full")!;
    expect([v.mode, v.source, v.alert, v.hint]).toEqual(["guarded", "session", false, null]);
    expect(v.label).toBe(m.chat_access_mode_guarded());
    expect(v.text).toBe(m.chat_access_mode_chip({ mode: m.chat_access_mode_guarded() }));
    expect(v.title).toBe(m.chat_access_mode_title_session({ mode: m.chat_access_mode_guarded() }));
  });

  test("every mode has its own name", () => {
    expect(permissionChipView({ permissionMode: "read-only" }, null)!.label).toBe(m.chat_access_mode_read_only());
    expect(permissionChipView({ permissionMode: "workspace" }, null)!.label).toBe(m.chat_access_mode_workspace());
    expect(permissionChipView({ permissionMode: "full" }, null)!.label).toBe(m.chat_access_mode_full());
  });

  test("FULL access is an alert, and its title says what it means", () => {
    const v = permissionChipView({ permissionMode: "full" }, null)!;
    expect(v.alert).toBe(true);
    expect(v.title.split("\n")).toContain(m.chat_access_mode_full_warning());
  });

  test("none set on the session: the agent's default, named as such", () => {
    const v = permissionChipView({ permissionMode: null }, "workspace")!;
    expect([v.mode, v.source, v.alert]).toEqual(["workspace", "agent", false]);
    expect(v.hint).toBe(m.chat_access_mode_agent_hint());
    expect(v.title).toBe(m.chat_access_mode_title_agent({ mode: m.chat_access_mode_workspace() }));
    // …and an agent defaulting to full access is still an alert.
    const full = permissionChipView({ permissionMode: null }, "full")!;
    expect([full.source, full.alert]).toEqual(["agent", true]);
  });

  test("none set and no agent default stated: \"Default\", with the full-access warning", () => {
    for (const agentDefault of [null, undefined, "yolo"]) {
      const v = permissionChipView({ permissionMode: null }, agentDefault)!;
      expect([v.mode, v.source, v.alert, v.hint], String(agentDefault)).toEqual([null, "unknown", true, null]);
      expect(v.label).toBe(m.chat_access_mode_default());
      expect(v.title).toBe(m.chat_access_mode_title_unknown());
    }
  });

  test("a change being applied takes the hint slot, and the working root is named", () => {
    const v = permissionChipView(
      { permissionMode: null, permissionModePending: true, sessionRoot: "/srv/w" },
      "guarded",
    )!;
    expect(v.pending).toBe(true);
    expect(v.hint).toBe(m.chat_access_mode_pending_hint());
    expect(v.title.split("\n")).toEqual([
      m.chat_access_mode_title_agent({ mode: m.chat_access_mode_guarded() }),
      m.chat_access_mode_pending(),
      m.chat_access_mode_root({ root: "/srv/w" }),
    ]);
  });
});

describe("visibilityChipView — only when the session is not plainly shared", () => {
  test("shared, absent or unknown: no chip", () => {
    expect(visibilityChipView(null)).toBeNull();
    expect(visibilityChipView({})).toBeNull();
    expect(visibilityChipView({ visibility: "shared", sharingRole: "owner" })).toBeNull();
    expect(visibilityChipView({ visibility: "private" })).toBeNull();
  });

  test("each restricted visibility has its label and its explanation", () => {
    const cases = [
      ["read-only", m.chat_access_visibility_read_only(), m.chat_access_visibility_read_only_desc()],
      ["suggest", m.chat_access_visibility_suggest(), m.chat_access_visibility_suggest_desc()],
      ["draft", m.chat_access_visibility_draft(), m.chat_access_visibility_draft_desc()],
    ] as const;
    for (const [visibility, label, desc] of cases) {
      const v = visibilityChipView({ visibility })!;
      expect([v.visibility, v.label, v.title, v.role], visibility).toEqual([visibility, label, desc, null]);
    }
  });

  test("the title names the role Atrium's connection holds, when reported", () => {
    const roles = [
      ["admin", m.chat_access_role_admin()],
      ["owner", m.chat_access_role_owner()],
      ["member", m.chat_access_role_member()],
      ["viewer", m.chat_access_role_viewer()],
    ] as const;
    for (const [role, name] of roles) {
      const v = visibilityChipView({ visibility: "draft", sharingRole: role })!;
      expect(v.role, role).toBe(role);
      expect(v.title.split("\n"), role).toEqual([
        m.chat_access_visibility_draft_desc(),
        m.chat_access_visibility_role({ role: name }),
      ]);
    }
    // An unknown role is not named.
    expect(visibilityChipView({ visibility: "draft", sharingRole: "boss" })!.role).toBeNull();
  });
});
