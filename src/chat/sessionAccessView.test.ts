/// <reference types="vite/client" />
//
// The access chip of the conversation header (the session's visibility) — every branch,
// parameterized messages included (GC-P5 lesson: a branch nobody renders in a test ships
// broken). The permission mode moved to the composer (permissionModeView.ts).

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import { visibilityChipView } from "./sessionAccessView";

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
