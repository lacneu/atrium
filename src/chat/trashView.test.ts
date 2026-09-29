import { describe, expect, test } from "vitest";
import { folderDeleteDescription, formatTrashDay } from "./trashView";
import { m } from "@/paraglide/messages.js";

// What deleting says. A conversation is no longer deleted at once — it waits in
// the trash for the retention period — and the confirmation must say that, with
// the period the server applies; only an EMPTY folder is deleted for good.
describe("delete confirmations", () => {
  test("a folder's conversations are announced as going to the trash, for the retention period", () => {
    const tree = folderDeleteDescription({ folders: 2, chats: 5, days: 30 });
    expect(tree).toBe(m.sidebar_delete_project_confirm_desc_tree({ folders: 2, chats: 5, days: 30 }));
    expect(tree).toContain("30");
    expect(tree).toContain("5");
    const flat = folderDeleteDescription({ folders: 0, chats: 3, days: 7 });
    expect(flat).toBe(m.sidebar_delete_project_confirm_desc({ count: 3, days: 7 }));
    expect(flat).toContain("7");
  });

  test("an empty folder has nothing to restore: its deletion stays announced as irreversible", () => {
    expect(folderDeleteDescription({ folders: 0, chats: 0, days: 30 })).toBe(
      m.sidebar_action_irreversible(),
    );
  });

  test("the conversation confirmation names the retention period, not an irreversible deletion", () => {
    const text = m.sidebar_delete_chat_confirm_desc({ days: 30 });
    expect(text).toContain("30");
    expect(text).not.toBe(m.sidebar_action_irreversible());
  });
});

describe("formatTrashDay", () => {
  test("day and month only, two digits each, in the reader's order", () => {
    const oct5 = Date.UTC(2026, 9, 5, 12);
    expect(formatTrashDay(oct5, "fr")).toBe("05/10");
    expect(formatTrashDay(oct5, "en")).toBe("10/05");
  });
});
