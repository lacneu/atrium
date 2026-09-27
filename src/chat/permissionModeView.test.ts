/// <reference types="vite/client" />
//
// The conversation's execution-permissions picker, every branch (permissionModeView.ts):
// the upstream order, names and shortcuts; who may pick; full for administrators only;
// Hermes; pending; the recorded outcome.

import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  PERMISSION_CHOICES,
  PERMISSION_MODES_DOCS_URL,
  choiceLabel,
  permissionControlView,
  shortcutChoice,
  shouldSubmitChoice,
  type PermissionControlInput,
} from "./permissionModeView";

const base: PermissionControlInput = {
  viewerRole: "owner",
  viewerIsAdmin: false,
  choice: null,
  apply: null,
  sessionMode: null,
  sessionModePending: false,
  sessionRoot: null,
  agentDefault: null,
  target: "openclaw",
  multiAgent: false,
  managed: true,
  anyManaged: true,
};
const view = (over: Partial<PermissionControlInput>) => permissionControlView({ ...base, ...over });
const item = (v: ReturnType<typeof view>, value: string) => v.items.find((i) => i.value === value)!;

describe("the options, as the Control UI shows them", () => {
  test("five options in the upstream order, shortcuts 1-5, the docs link", () => {
    expect(PERMISSION_CHOICES).toEqual(["default", "read-only", "guarded", "workspace", "full"]);
    const v = view({});
    expect(v.items.map((i) => [i.value, i.shortcut])).toEqual([
      ["default", 1],
      ["read-only", 2],
      ["guarded", 3],
      ["workspace", 4],
      ["full", 5],
    ]);
    expect(PERMISSION_MODES_DOCS_URL).toBe("https://docs.openclaw.ai/gateway/permission-modes");
    expect(v.items.map((i) => i.description)).toEqual([
      m.chat_perm_default_desc(),
      m.chat_perm_mode_read_only_desc(),
      m.chat_perm_mode_guarded_desc(),
      m.chat_perm_mode_workspace_desc(),
      m.chat_perm_mode_full_desc(),
    ]);
    expect(v.items.map((i) => i.icon)).toEqual(["check", "ellipsis", "lock", "cog", "alert"]);
  });

  test("'Default (<agent's mode>)' when the agent's mode is stated, plain 'Default' otherwise", () => {
    expect(choiceLabel("default", "full")).toBe(m.chat_perm_default_with_mode({ mode: m.chat_perm_mode_full() }));
    expect(choiceLabel("default", null)).toBe(m.chat_perm_default());
    expect(view({ agentDefault: "guarded" }).label).toBe(
      m.chat_perm_default_with_mode({ mode: m.chat_perm_mode_guarded() }),
    );
    // A value outside the vocabulary is not guessed at.
    expect(view({ agentDefault: "yolo" }).label).toBe(m.chat_perm_default());
  });

  test("managed: the conversation's choice IS the mode — nothing chosen means Default, enforced", () => {
    // A mode set behind Atrium's back (the Control UI) is not what the button shows:
    // it is cleared before the next turn.
    expect(view({ sessionMode: "workspace" }).current).toBe("default");
    expect(view({ sessionMode: "workspace", choice: "read-only" }).current).toBe("read-only");
    expect(view({ sessionMode: undefined }).current).toBe("default");
    expect(item(view({ choice: "guarded" }), "guarded").selected).toBe(true);
  });

  test("full access is an alert — chosen, or the default resolving to it", () => {
    expect(view({ choice: "full", viewerIsAdmin: true }).alert).toBe(true);
    expect(view({ agentDefault: "full" }).alert).toBe(true);
    expect(view({ agentDefault: "guarded" }).alert).toBe(false);
    expect(view({ choice: "full", viewerIsAdmin: true }).title.split("\n")).toContain(m.chat_perm_full_warning());
  });
});

describe("who may pick", () => {
  test("a participant sees the mode, every option disabled, and why", () => {
    const v = view({ viewerRole: "participant", choice: "guarded" });
    expect(v.hidden).toBe(false);
    expect(v.current).toBe("guarded");
    expect(v.items.every((i) => i.disabled)).toBe(true);
    expect(v.locked).toBe(true);
    expect(v.lockReason).toBe(m.chat_perm_owner_only());
  });

  test("the owner picks everything but full; full is for an Atrium administrator", () => {
    const v = view({});
    expect(v.items.filter((i) => i.disabled).map((i) => i.value)).toEqual(["full"]);
    expect(item(v, "full").disabledReason).toBe(m.chat_perm_full_requires_admin());
    const admin = view({ viewerIsAdmin: true });
    expect(admin.items.some((i) => i.disabled)).toBe(false);
  });

  test("an owner who chose full and is no longer an administrator is told the turns are refused", () => {
    const v = view({ choice: "full", viewerIsAdmin: false });
    expect(v.status).toBe(m.chat_perm_full_revoked());
    expect(v.statusIsError).toBe(true);
  });
});

describe("where the next message goes", () => {
  // Codex pass 2 (2026-09-27): unresolved capabilities used to HIDE the control — and
  // with the header chip gone, the reader lost the mode their next send is guarded with.
  test("capabilities unknown: the described mode is SHOWN, read-only, with the reason", () => {
    const v = view({ target: "unknown", managed: false, anyManaged: true, sessionMode: "guarded" });
    expect(v.hidden).toBe(false);
    expect(v.current).toBe("guarded");
    expect(v.locked).toBe(true);
    expect(v.lockReason).toBe(m.chat_perm_checking());
    expect(v.items.every((i) => i.disabled)).toBe(true);
    // A session that states it sets no mode is something to show too ("Default").
    expect(view({ target: "unknown", sessionMode: null }).hidden).toBe(false);
    // An OFF instance keeps its own reason (known without capabilities).
    expect(view({ target: "unknown", managed: false, anyManaged: false, sessionMode: "full" }).lockReason).toBe(
      m.chat_perm_operator_managed(),
    );
  });

  test("hidden only when there is genuinely nothing to show", () => {
    // Unknown capabilities, nothing reported, nothing chosen (a Hermes chat's meta).
    expect(view({ target: "unknown", sessionMode: undefined }).hidden).toBe(true);
    expect(view({ viewerRole: undefined }).hidden).toBe(true);
  });

  test("a Hermes-only conversation with nothing chosen: hidden; with a choice: shown, locked, said", () => {
    expect(view({ target: "hermes" }).hidden).toBe(true);
    const v = view({ target: "hermes", choice: "guarded" });
    expect(v.hidden).toBe(false);
    expect(v.locked).toBe(true);
    expect(v.lockReason).toBe(m.chat_perm_hermes());
  });

  test("a room whose next message goes to Hermes: the choice stays the conversation's, and it is said", () => {
    const v = view({ target: "hermes", multiAgent: true });
    expect(v.hidden).toBe(false);
    expect(v.locked).toBe(false);
    expect(v.note).toBe(m.chat_perm_next_hermes());
    expect(v.title.split("\n")).toContain(m.chat_perm_conversation_note());
  });

  test("a gateway older than the modes: locked, with the reason", () => {
    const v = view({ target: "unsupported" });
    expect(v.locked).toBe(true);
    expect(v.lockReason).toBe(m.chat_perm_unsupported());
  });
});

describe("an instance whose gateway operator manages permissions", () => {
  test("shown as the session holds it, locked for everyone — the owner and admins included — with the reason", () => {
    const v = view({ managed: false, anyManaged: false, sessionMode: "guarded", choice: "read-only", viewerIsAdmin: true });
    expect(v.hidden).toBe(false);
    expect(v.current).toBe("guarded");
    expect(v.locked).toBe(true);
    expect(v.lockReason).toBe(m.chat_perm_operator_managed());
    expect(v.items.every((i) => i.disabled)).toBe(true);
    // "Default (X)" still reads the agent's configured mode.
    expect(view({ managed: false, anyManaged: false, sessionMode: null, agentDefault: "full" }).label).toBe(
      m.chat_perm_default_with_mode({ mode: m.chat_perm_mode_full() }),
    );
  });

  test("a mixed room whose NEXT target is not managed: the owner still chooses, and is told it will not apply there", () => {
    const v = view({ managed: false, anyManaged: true, multiAgent: true, sessionMode: "workspace", choice: "guarded" });
    expect(v.locked).toBe(false);
    expect(v.current).toBe("workspace");
    expect(v.note).toBe(m.chat_perm_next_not_managed());
  });

  test("repeated re-applies that did not settle are named, not called a gateway refusal", () => {
    const v = view({ choice: "read-only", apply: { mode: "read-only", status: "failed", reason: "reapply_exhausted" } });
    expect(v.status).toBe(m.chat_perm_failed({ reason: m.chat_perm_reason_reapply_exhausted() }));
    expect(v.status).not.toBe(m.chat_perm_failed({ reason: m.chat_perm_reason_other() }));
  });

  test("the not_managed outcome is named", () => {
    const v = view({ choice: "guarded", apply: { mode: "guarded", status: "failed", reason: "not_managed" } });
    expect(v.status).toBe(m.chat_perm_failed({ reason: m.chat_perm_reason_not_managed() }));
  });
});

describe("pending and outcomes", () => {
  test("a change being applied (ours, or the gateway's flag) takes no other pick", () => {
    const ours = view({ choice: "guarded", apply: { mode: "guarded", status: "pending" } });
    expect(ours.pending).toBe(true);
    expect(ours.items.every((i) => i.disabled)).toBe(true);
    expect(ours.note).toBe(m.chat_perm_pending());
    expect(view({ sessionModePending: true }).pending).toBe(true);
    // An outcome of ANOTHER choice says nothing about this one.
    expect(view({ choice: "guarded", apply: { mode: "read-only", status: "pending" } }).pending).toBe(false);
  });

  test("a failure is shown with its reason, in the closed vocabulary", () => {
    const v = view({ choice: "read-only", apply: { mode: "read-only", status: "failed", reason: "active_run" } });
    expect(v.status).toBe(m.chat_perm_failed({ reason: m.chat_perm_reason_active_run() }));
    expect(v.statusIsError).toBe(true);
    const odd = view({ choice: "read-only", apply: { mode: "read-only", status: "failed", reason: "<gateway prose>" } });
    expect(odd.status).toBe(m.chat_perm_failed({ reason: m.chat_perm_reason_other() }));
  });

  test("deferred and saved-but-not-applied are told, not as errors", () => {
    const d = view({ choice: "guarded", apply: { mode: "guarded", status: "deferred" } });
    expect([d.status, d.statusIsError]).toEqual([m.chat_perm_deferred(), false]);
    const s = view({ choice: "guarded", apply: { mode: "guarded", status: "applied", reason: "saved_not_applied" } });
    expect(s.status).toBe(m.chat_perm_saved_not_applied());
    expect(view({ choice: "guarded", apply: { mode: "guarded", status: "applied" } }).status).toBeNull();
  });
});

describe("picking", () => {
  test("digits 1-5 pick an ENABLED option; anything else is left to the menu", () => {
    const v = view({});
    expect(shortcutChoice("3", v.items)).toBe("guarded");
    expect(shortcutChoice("1", v.items)).toBe("default");
    expect(shortcutChoice("5", v.items)).toBeNull(); // full: not an administrator
    expect(shortcutChoice("6", v.items)).toBeNull();
    expect(shortcutChoice("a", v.items)).toBeNull();
  });

  test("only an enabled option that is not already the stored choice reaches the server", () => {
    const v = view({ choice: "guarded" });
    expect(shouldSubmitChoice("guarded", v, "guarded")).toBe(false);
    expect(shouldSubmitChoice("read-only", v, "guarded")).toBe(true);
    expect(shouldSubmitChoice("full", v, "guarded")).toBe(false);
    // Never chosen: picking what is shown still records the choice.
    const fresh = view({ sessionMode: "workspace" });
    expect(shouldSubmitChoice("default", fresh, null)).toBe(true);
    const guest = view({ viewerRole: "participant" });
    expect(shouldSubmitChoice("read-only", guest, null)).toBe(false);
  });
});
