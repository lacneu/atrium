/// <reference types="vite/client" />
//
// Pinning what you are reading (2026-07-31, client request).
//
// The right-hand column is mounted per chat: switching conversation re-scopes it
// and opening Settings unmounts it, so a reader who wanted to check something
// elsewhere lost their reading. The pin moves ownership into a module store that
// survives that churn — the same answer, and the same shape, as the composer's
// detach next door.
//
// What is asserted here is the pair of rules that make a pin honest rather than
// merely persistent: the ORIGIN travels with it (a panel read from another
// conversation must still know, and say, whose it is), and EXACTLY ONE surface
// renders it (back home the in-chat column takes over, or the same content draws
// twice).

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test } from "vitest";

import {
  __resetPinnedPanelForTests,
  fittedPanelWidth,
  panelFitsBeside,
  clearShownColumn,
  getPinnedPanel,
  getShownColumn,
  isPinnedContent,
  panelIdentity,
  pinBelongsHere,
  setPinnedParams,
  setShownColumn,
  pinPanel,
  releasePinnedPanel,
  shouldRestoreInChat,
  subscribePinnedPanel,
  whoOwns,
} from "./pinnedPanel";

const ME = "userA";
/** The desktop reader, in chat A. */
/** The desktop reader, in chat A, with an EMPTY column. */
const here = {
  userId: ME,
  chatId: "chatA",
  shownIdentity: null as string | null,
};
const elsewhere = { ...here, chatId: "chatB" };
const nowhere = { ...here, chatId: null };
const onMobile = { ...here };
const someoneElse = { ...here, userId: "userB" };

const aDoc = {
  kind: "document" as const,
  ownerUserId: ME,
  originChatId: "chatA",
  originLabel: "Revue budgétaire",
  params: { filename: "note.md" },
};

beforeEach(() => __resetPinnedPanelForTests());

describe("a pin survives navigation, and says where it came from", () => {
  test("the origin conversation is kept, not the one navigated to", () => {
    // `SourcesPanelContent` takes only a messageId — the origin is NOT
    // recoverable from the content's props, so losing it here loses it forever.
    pinPanel(aDoc);
    expect(getPinnedPanel()?.originChatId).toBe("chatA");
    expect(getPinnedPanel()?.originLabel).toBe("Revue budgétaire");
  });

  test("navigating anywhere else leaves the pin untouched", () => {
    pinPanel(aDoc);
    const before = getPinnedPanel();
    expect(whoOwns(before, elsewhere)).toBe("dock");
    expect(whoOwns(before, nowhere)).toBe("dock");
    expect(getPinnedPanel(), "reading it must not consume it").toBe(before);
  });
});

describe("exactly one surface renders the panel", () => {
  test("back in the origin conversation, the in-chat column takes over", () => {
    // The column is wider, resizable and sits beside the thread it belongs to;
    // the floating panel yields rather than drawing the same content twice —
    // but only once the column has PUBLISHED that it is showing the pin.
    const pin = pinPanel(aDoc);
    const showing = { ...here, shownIdentity: panelIdentity("document", aDoc.params) };
    expect(whoOwns(pin, here), "not yet: the column is still empty").toBe("dock");
    expect(whoOwns(pin, showing)).toBe("inchat");
  });

  test("the handover is ACKNOWLEDGED — the reading never blinks out", () => {
    // Coming home, the column restores in a later effect. Handing over on
    // "empty" left a frame with the dock gone and no column body yet.
    const pin = pinPanel(aDoc);
    expect(whoOwns(pin, here), "dock still draws it…").toBe("dock");
    expect(shouldRestoreInChat(pin, here, false), "…and the column fills").toBe(
      true,
    );
    const showing = { ...here, shownIdentity: panelIdentity("document", aDoc.params) };
    expect(whoOwns(pin, showing), "now the dock yields").toBe("inchat");
  });

  test("a panel with NO origin chat is owned by the dock everywhere", () => {
    // A scheduled task opened from Settings has no in-chat home to return to.
    const pin = pinPanel({ ...aDoc, kind: "cron", originChatId: null });
    expect(whoOwns(pin, here)).toBe("dock");
    expect(whoOwns(pin, nowhere)).toBe("dock");
  });

  test("no pin means nobody renders the floating panel", () => {
    expect(whoOwns(null, here)).toBe("none");
  });
});

describe("the pin's lifecycle", () => {
  test("pinning again REPLACES — a second pin is not a second panel", () => {
    const first = pinPanel(aDoc);
    const second = pinPanel({ ...aDoc, kind: "subagent", params: { childKey: "k" } });
    expect(getPinnedPanel()?.pinId).toBe(second.pinId);
    expect(second.pinId).not.toBe(first.pinId);
    expect(getPinnedPanel()?.kind).toBe("subagent");
  });

  test("a STALE close cannot dismiss the pin that replaced it", () => {
    // A control captured before the replacement (an async confirm, a late click)
    // must only ever touch the pin it was made for — the composer hold's holdId
    // rule, for the same reason.
    const first = pinPanel(aDoc);
    const second = pinPanel({ ...aDoc, kind: "sources", params: { messageId: "m" } });
    releasePinnedPanel(first.pinId);
    expect(getPinnedPanel()?.pinId, "the live pin survives a stale close").toBe(
      second.pinId,
    );
    releasePinnedPanel(second.pinId);
    expect(getPinnedPanel()).toBeNull();
  });

  test("an unqualified release always closes (the visible X)", () => {
    pinPanel(aDoc);
    releasePinnedPanel();
    expect(getPinnedPanel()).toBeNull();
  });

  test("subscribers are notified on pin and release", () => {
    let hits = 0;
    const off = subscribePinnedPanel(() => (hits += 1));
    pinPanel(aDoc);
    releasePinnedPanel();
    expect(hits).toBe(2);
    off();
    pinPanel(aDoc);
    expect(hits, "an unsubscribed listener stops hearing").toBe(2);
  });
});

describe("coming home to the origin conversation", () => {
  test("an empty column refills itself from the pin", () => {
    // ConvexChat remounts on navigation with empty local state; the reading is
    // still pinned here, so the column fills itself rather than making the
    // reader click again.
    pinPanel(aDoc);
    expect(shouldRestoreInChat(getPinnedPanel(), here, false)).toBe(true);
  });

  test("a column already showing something is NOT overwritten", () => {
    pinPanel(aDoc);
    expect(shouldRestoreInChat(getPinnedPanel(), here, true)).toBe(false);
  });

  test("closing ANOTHER conversation's column leaves the pin alone", () => {
    // The reader pinned from chat A and is now in chat B. What B's column shows
    // is B's own; the dock is drawing A's pin. Closing B must not reach across.
    const pin = pinPanel(aDoc);
    expect(whoOwns(pin, elsewhere), "the dock draws it, not B's column").toBe(
      "dock",
    );
    // (The column only releases when it OWNS the pin — see ConvexChat's
    // `closingColumn`, guarded on `pinnedHere`.)
    expect(shouldRestoreInChat(getPinnedPanel(), elsewhere, false)).toBe(false);
    expect(getPinnedPanel()?.pinId).toBe(pin.pinId);
  });

  test("closing the reading ends the pin — the column must not reopen it", () => {
    // Without the release, the close is undone on the very next render and the
    // X looks broken: the restore condition is true again the instant the column
    // goes empty.
    const pin = pinPanel(aDoc);
    releasePinnedPanel(pin.pinId);
    expect(shouldRestoreInChat(getPinnedPanel(), here, false)).toBe(false);
  });

  test("elsewhere, nothing is restored into the column at all", () => {
    pinPanel(aDoc);
    expect(shouldRestoreInChat(getPinnedPanel(), elsewhere, false)).toBe(false);
    expect(shouldRestoreInChat(getPinnedPanel(), nowhere, false)).toBe(false);
  });
});

describe("every way to close the reading releases the pin", () => {
  // DERIVED FROM THE SOURCE, not from a list kept by hand. The restore fires on
  // an empty column, so ANY close that leaves the pin standing is undone on the
  // next render — the reader clicks the X and the panel comes straight back.
  // The rule is therefore about all the closes, including the ones added later:
  // the four column contents, and the four mobile sheets that show the same
  // things. `closingColumn` is the single door, so nothing may call `close`
  // directly.
  test("no close bypasses closingColumn in ConvexChat", () => {
    const src = readFileSync(
      new URL("./ConvexChat.tsx", import.meta.url),
      "utf8",
    );
    const closers = [...src.matchAll(/\b(\w+Api)\.close\b/g)];
    expect(closers.length, "the four contents, column + sheet").toBeGreaterThan(
      7,
    );
    const bypassed = closers.filter((mm) => {
      const before = src.slice(Math.max(0, mm.index - 24), mm.index);
      return !before.includes("closingColumn(");
    });
    expect(
      bypassed.map((mm) => mm[0]),
      "a close that skips closingColumn leaves the pin standing, and the restore undoes it",
    ).toEqual([]);
  });
});

describe("the pin does not outlive the identity that made it", () => {
  test("another identity sees NOTHING — not even the origin title", () => {
    // The store outlives React, so an impersonation swap can render the new
    // identity's tree before the old one's cleanup effect has run. The check
    // therefore fails CLOSED on every read rather than waiting for a purge:
    // the header chip carries a conversation TITLE, which is the leak.
    const pin = pinPanel(aDoc);
    expect(whoOwns(pin, someoneElse)).toBe("none");
    expect(whoOwns(pin, { ...someoneElse, chatId: "chatB" })).toBe("none");
    expect(shouldRestoreInChat(pin, someoneElse, false)).toBe(false);
    expect(
      isPinnedContent(pin, someoneElse, "document", aDoc.params),
    ).toBe(false);
    expect(
      whoOwns(pin, { ...here, shownIdentity: panelIdentity("document", aDoc.params) }),
      "and the owner still sees it",
    ).toBe("inchat");
  });

  // The store is module-level: it survives React on its own. The dock is
  // mounted INSIDE the identity-keyed tree, so an impersonation swap remounts
  // it — and only a mount-scoped cleanup turns that remount into a purge.
  // Without it, one person's reading, and the conversation TITLE shown in the
  // panel's header, would carry into another's session.
  test("the dock releases the pin in a mount-scoped cleanup", () => {
    const src = readFileSync(
      new URL("./PinnedPanelDock.tsx", import.meta.url),
      "utf8",
    );
    expect(
      /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*releasePinnedPanel\(\),\s*\[\]\s*\)/.test(
        src,
      ),
      "no unmount release: an identity swap would carry the pin across sessions",
    ).toBe(true);
  });
});

describe("the pin belongs to a CONTENT, not to a conversation", () => {
  const sourcesOf = (messageId: string) => ({
    kind: "sources" as const,
    ownerUserId: ME,
    originChatId: "chatA",
    originLabel: "Revue budgétaire",
    params: { messageId },
  });

  test("another message's sources, in the same chat, are NOT the pinned one", () => {
    // Comparing chats alone made the pin button claim the second message was
    // pinned — and made closing it destroy the first, a reading never touched.
    pinPanel(sourcesOf("m1"));
    const pin = getPinnedPanel();
    expect(isPinnedContent(pin, here, "sources", { messageId: "m1" })).toBe(
      true,
    );
    expect(isPinnedContent(pin, here, "sources", { messageId: "m2" })).toBe(
      false,
    );
  });

  test("same identifier, different KIND, is not the pinned one either", () => {
    pinPanel(sourcesOf("m1"));
    expect(
      isPinnedContent(getPinnedPanel(), here, "subagent", {
        childKey: "m1",
      }),
    ).toBe(false);
  });

  test("the same blob under two names is two documents", () => {
    // The server validates storageId and filename separately: one blob can be
    // sent under two names. On the blob alone, pinning `rapport.md` then
    // opening `copie.md` made the copy pass for the pinned reading — closing it
    // unpinned the report, and its "newer version" rewrote the report's pin.
    const asName = (filename: string) =>
      panelIdentity("document", { doc: { filename, storageId: "same-blob" } });
    expect(asName("rapport.md")).not.toBe(asName("copie.md"));
    // …and a version change, which keeps the name and moves the blob, is still
    // seen as a move of the SAME document rather than a different one.
    const v1 = panelIdentity("document", { doc: { filename: "r.md", storageId: "v1" } });
    const v2 = panelIdentity("document", { doc: { filename: "r.md", storageId: "v2" } });
    expect(v1).not.toBe(v2);
    expect(v1).toBe(
      panelIdentity("document", { doc: { filename: "r.md", storageId: "v1" } }),
    );
  });

  test("a document is identified by its storage id, not its rotating URL", () => {
    pinPanel({
      kind: "document",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: { doc: { storageId: "st1", url: "https://signed/one" } },
    });
    const pin = getPinnedPanel();
    expect(
      isPinnedContent(pin, here, "document", {
        doc: { storageId: "st1", url: "https://signed/RESIGNED" },
      }),
      "a re-signed URL is the same document",
    ).toBe(true);
    expect(
      isPinnedContent(pin, here, "document", {
        doc: { storageId: "st2", url: "https://signed/one" },
      }),
    ).toBe(false);
  });

  test("nothing open means nothing is pinned HERE", () => {
    pinPanel(sourcesOf("m1"));
    expect(isPinnedContent(getPinnedPanel(), here, null, null)).toBe(false);
  });
});

describe("a phone changes the presentation, not the rules", () => {
  test("coming home restores the reading — as a sheet, but it is THERE", () => {
    // Refusing to restore where no column fits left the pin in the store and on
    // no surface at all: pin in A, go to B, come back to A on a phone, and the
    // reading was gone for good. Whether it comes back as a column or a sheet is
    // decided downstream; both are surfaces.
    pinPanel(aDoc);
    expect(shouldRestoreInChat(getPinnedPanel(), onMobile, false)).toBe(true);
    expect(shouldRestoreInChat(getPinnedPanel(), here, false)).toBe(true);
  });

  test("and a column already showing something is still not overwritten", () => {
    pinPanel(aDoc);
    expect(shouldRestoreInChat(getPinnedPanel(), onMobile, true)).toBe(false);
  });

  test("elsewhere on a phone nothing draws it — it waits, and it comes back", () => {
    const pin = pinPanel(aDoc);
    expect(whoOwns(pin, { ...onMobile, chatId: "chatB" })).toBe("dock");
    // …the persistent column renders nothing on a phone, so the reading is not
    // on screen there; the test above is what makes that a WAIT and not a loss.
    expect(shouldRestoreInChat(pin, { ...onMobile, chatId: "chatB" }, false)).toBe(
      false,
    );
  });
});

describe("exactly one surface, whatever the column is showing", () => {
  const idOf = (messageId: string) =>
    panelIdentity("sources", { messageId });

  test("a SECOND panel opened at home leaves the pin to the dock", () => {
    // Pin m1's sources, then open m2's in the same conversation. The column now
    // shows m2 and refuses to restore m1 (it is not empty) — so if it still
    // claimed ownership, m1 would be drawn on NEITHER surface.
    pinPanel({
      kind: "sources",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: { messageId: "m1" },
    });
    const pin = getPinnedPanel();
    expect(whoOwns(pin, { ...here, shownIdentity: idOf("m2") })).toBe("dock");
    expect(whoOwns(pin, { ...here, shownIdentity: idOf("m1") })).toBe("inchat");
    expect(
      whoOwns(pin, here),
      "empty column: the dock KEEPS it until the column acknowledges",
    ).toBe("dock");
  });


  test("the column publishes what it shows, and clears it", () => {
    setShownColumn("chatA", "sources:m1");
    expect(getShownColumn()).toEqual({ chatId: "chatA", identity: "sources:m1" });
    clearShownColumn("chatA");
    expect(getShownColumn()).toEqual({ chatId: null, identity: null });
  });

  test("a LATE clear from the conversation you left erases nothing", () => {
    // Leaving A for B, A's cleanup can land after B has already published. An
    // unconditional clear would erase a true fact, and the dock and B's column
    // would then draw the same reading at once.
    setShownColumn("chatA", "sources:m1");
    setShownColumn("chatB", "sources:m9");
    clearShownColumn("chatA");
    expect(getShownColumn(), "B's column still speaks for itself").toEqual({
      chatId: "chatB",
      identity: "sources:m9",
    });
  });
});

describe("a pinned document can move to its newer version", () => {
  test("the pin and the column never end up on two versions at once", () => {
    // Whichever surface moves, the other follows within the SAME pin. Left
    // unsynchronised, the two hold different versions of the same file, each
    // claims a different identity, and BOTH get drawn — two live copies.
    const v1 = { doc: { storageId: "v1" } };
    const v2 = { doc: { storageId: "v2" } };
    const pin = pinPanel({
      kind: "document",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: v1,
    });
    const showing = (params: Record<string, unknown>) => ({
      ...here,
      shownIdentity: panelIdentity("document", params),
    });
    expect(whoOwns(pin, showing(v1))).toBe("inchat");
    // The dock moves the pin to v2. A column left on v1 would be a second live
    // copy, which is why the follow-up happens during the render — the state
    // below is never painted.
    setPinnedParams(pin.pinId, v2);
    const moved = getPinnedPanel();
    expect(whoOwns(moved, showing(v1)), "column left behind → two copies").toBe(
      "dock",
    );
    expect(whoOwns(moved, showing(v2)), "once it follows, one copy").toBe(
      "inchat",
    );
  });


  test("BOTH surfaces carry the pin — neither direction is left out", () => {
    // The pure rule above says two versions must never coexist; these are the
    // two places that keep it. Column-initiated: `openFor` writes the pin.
    // Dock-initiated: the chat follows the pin's params. Losing either one
    // reopens the two-live-copies state.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    expect(
      /openFor:[\s\S]{0,1600}?setPinnedParams\(pin\.pinId/.test(chat),
      "the column's version change must carry the pin",
    ).toBe(true);
    expect(
      /if \(pinDocIdentity === null\)[\s\S]{0,1400}?setActiveDoc\(pinnedPanel!\.params\.doc/.test(
        chat,
      ),
      "the dock's version change must be followed DURING the render, not after",
    ).toBe(true);
  });

  test("the params are rewritten in place, and a stale write is refused", () => {
    // From the dock the viewer's "open the newer version" had no context to
    // write to: the control was visible and did nothing.
    const pin = pinPanel(aDoc);
    setPinnedParams(pin.pinId, { doc: { storageId: "v2" } });
    expect(
      (getPinnedPanel()?.params.doc as { storageId: string }).storageId,
    ).toBe("v2");
    expect(getPinnedPanel()?.pinId, "same pin, same place").toBe(pin.pinId);
    setPinnedParams(pin.pinId + 99, { doc: { storageId: "v3" } });
    expect(
      (getPinnedPanel()?.params.doc as { storageId: string }).storageId,
      "a late click cannot retarget another pin",
    ).toBe("v2");
  });
});

describe("a broken panel never traps the reader", () => {
  // Derived from the source: the boundary swallows the failing content INCLUDING
  // its own close button, so without an escape of its own the column sits there,
  // unclosable, until the reader navigates away.
  test("every boundary offers a way out", () => {
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const dock = readFileSync(new URL("./PinnedPanelDock.tsx", import.meta.url), "utf8");
    const boundaries = [...chat.matchAll(/<PanelBodyBoundary\b/g)];
    expect(boundaries.length, "the column and the four sheets").toBe(5);
    const without = [...chat.matchAll(/<PanelBodyBoundary\b(?:(?!onClose)[\s\S]){0,400}?>/g)];
    expect(
      without.length,
      "a boundary with no onClose leaves a broken panel on screen for good",
    ).toBe(0);
    expect(/<PanelBodyBoundary[^>]*onClose=/.test(dock), "the dock's too").toBe(true);
  });

  test("the transfer is atomic — nothing is deferred to a post-paint effect", () => {
    // The column used to be emptied by an effect on [chatId] and the mirror
    // published by a plain effect: both land AFTER the frame is on screen, so
    // chat B briefly showed chat A's reading while the dock drew it as well.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    expect(
      /if \(panelChat !== chatId\) \{[\s\S]{0,400}?setActiveCron\(null\)/.test(chat),
      "the column must empty DURING the render",
    ).toBe(true);
    expect(
      /useLayoutEffect\(\(\) => \{[\s\S]{0,300}?setShownColumn\(mine, shownIdentity\)/.test(
        chat,
      ),
      "the mirror must be published BEFORE paint",
    ).toBe(true);
  });
});

describe("two readings must not collide on one identity", () => {
  test("two degraded crons, no job id, are told apart", () => {
    // The bridge does emit a CronPart with no jobId. Keyed on the instance
    // alone they all collided: pinning one and opening another made the column
    // look like it still held the pin — the first reading vanished from both
    // surfaces, and closing the second could delete its pin.
    const a = { instanceName: "lacneu", jobId: null, part: { name: "matin", schedule: "0 8 * * *" } };
    const b = { instanceName: "lacneu", jobId: null, part: { name: "soir", schedule: "0 20 * * *" } };
    // …including jobs that differ ONLY in a field the first cut left out.
    const base = { instanceName: "lacneu", jobId: null, part: { name: "x", schedule: "0 8 * * *" } };
    expect(
      panelIdentity("cron", { ...base, part: { ...base.part, message: "un" } }),
    ).not.toBe(
      panelIdentity("cron", { ...base, part: { ...base.part, message: "deux" } }),
    );
    expect(
      panelIdentity("cron", { ...base, part: { ...base.part, deliveryMode: "chat" } }),
    ).not.toBe(
      panelIdentity("cron", { ...base, part: { ...base.part, deliveryMode: "silent" } }),
    );
    expect(
      panelIdentity("cron", { ...base, part: { ...base.part, enabled: true } }),
    ).not.toBe(
      panelIdentity("cron", { ...base, part: { ...base.part, enabled: false } }),
    );
    // …and a value containing the old separator does not fabricate a match.
    expect(
      panelIdentity("cron", { ...base, part: { name: "a|b", schedule: "" } }),
    ).not.toBe(
      panelIdentity("cron", { ...base, part: { name: "a", schedule: "b" } }),
    );
    expect(panelIdentity("cron", a)).not.toBe(panelIdentity("cron", b));
    expect(
      panelIdentity("cron", a),
      "and the same part is still the same reading",
    ).toBe(panelIdentity("cron", { ...a, part: { ...a.part } }));
    // Two cards that even the SNAPSHOT cannot tell apart — two updates of one
    // job producing identical values — are still two readings: closing one
    // must not release the other's pin.
    const twin = { instanceName: "l", jobId: "j1", part: { op: "updated" } };
    expect(panelIdentity("cron", { ...twin, occurrenceId: "m1#0" })).not.toBe(
      panelIdentity("cron", { ...twin, occurrenceId: "m1#1" }),
    );
    expect(
      panelIdentity("cron", { ...twin, occurrenceId: "m1#0" }),
      "and the same card is still the same reading",
    ).toBe(panelIdentity("cron", { ...twin, occurrenceId: "m1#0" }));
    // Two cards of the SAME job are not the same reading: a job is created,
    // updated then removed across a conversation, and the panel renders each
    // differently. Pinning one and opening another used to collide.
    expect(
      panelIdentity("cron", { instanceName: "l", jobId: "j1", part: { op: "created" } }),
    ).not.toBe(
      panelIdentity("cron", { instanceName: "l", jobId: "j1", part: { op: "removed" } }),
    );
    // A job id, when there is one, still wins…
    const withJob = panelIdentity("cron", { instanceName: "l", jobId: "j1", part: {} });
    expect(withJob).not.toBe(panelIdentity("cron", { instanceName: "l", jobId: "j2", part: {} }));
    // …and a job id CANNOT be spelled like the fallback. Job ids are opaque
    // strings: a prefix is not a discriminant, a serialised variant tag is.
    expect(
      panelIdentity("cron", {
        instanceName: "l",
        jobId: '~["created",null,null,null,null,null,null,null,null]',
        part: {},
      }),
    ).not.toBe(
      panelIdentity("cron", { instanceName: "l", jobId: null, part: { op: "created" } }),
    );
  });

  test("a shared storage id does not let one conversation rewrite another's pin", () => {
    // Forks reuse the same storage id: identity alone would let a document
    // pinned in A be rewritten from B, and the reader of B act on a version
    // belonging to a thread they are not in.
    const pin = pinPanel({
      kind: "document",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: { doc: { storageId: "shared" } },
    });
    expect(pinBelongsHere(pin, here)).toBe(true);
    expect(pinBelongsHere(pin, elsewhere), "same document, other chat").toBe(false);
    expect(pinBelongsHere(pin, someoneElse), "same chat, other reader").toBe(false);
    expect(pinBelongsHere(pin, nowhere), "no conversation at all").toBe(false);
  });

  test("only the VERSION action carries the pin — not every file chip", () => {
    // `openFor` is what every FileChip calls. Wired to the pin, previewing an
    // unrelated file silently replaced the pinned reading with it.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const openForBody = chat.slice(
      chat.indexOf("openFor: (doc) => {"),
      chat.indexOf("openNewerVersion: (doc) => {"),
    );
    expect(
      openForBody.includes("setPinnedParams"),
      "a plain open must leave the pin alone",
    ).toBe(false);
    expect(
      /openNewerVersion: \(doc\) => \{[\s\S]{0,1600}?setPinnedParams\(pin\.pinId/.test(
        chat,
      ),
      "and the version change must carry it",
    ).toBe(true);
    const viewer = readFileSync(new URL("./DocumentViewer.tsx", import.meta.url), "utf8");
    expect(
      viewer.includes("viewer.openNewerVersion({"),
      "the version button must use the distinct act",
    ).toBe(true);
  });

  test("both document sync directions carry the belongs-here guard", () => {
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const guards = [...chat.matchAll(/pinBelongsHere\(/g)];
    expect(
      guards.length,
      "the render-phase follow AND openNewerVersion — losing either reopens it",
    ).toBe(2);
  });
});

describe("the conversation keeps a floor the panel cannot cross", () => {
  const MIN_SOURCES = 300;

  test("a wide remembered column yields rather than crushing the thread", () => {
    // The sidebar and this column both sit OUTSIDE the thread's box, so just
    // above the phone threshold a remembered 680px panel left the conversation
    // with nothing — and `.oc-main` has `min-width: 0`, so it simply vanished.
    expect(fittedPanelWidth(680, 1600, MIN_SOURCES)).toBe(680);
    expect(fittedPanelWidth(680, 900, MIN_SOURCES)).toBe(480);
  });

  test("when both cannot be honoured, the CONVERSATION wins", () => {
    // A panel that leaves the thread a sliver helps nobody, and `.oc-main` has
    // no minimum of its own — it simply vanished. The column waits instead, the
    // same answer as on a phone, and comes back as soon as there is room.
    expect(panelFitsBeside(1600, MIN_SOURCES)).toBe(true);
    expect(panelFitsBeside(720, MIN_SOURCES)).toBe(true);
    expect(panelFitsBeside(640, MIN_SOURCES), "900px window, sidebar open").toBe(
      false,
    );
    expect(panelFitsBeside(600, MIN_SOURCES)).toBe(false);
    // …and collapsing the sidebar hands back its whole width, so it fits again.
    expect(panelFitsBeside(640 + 260, MIN_SOURCES)).toBe(true);
  });

  test("the rule is the SAME for both columns — persistent and in-chat", () => {
    // They are one column at two levels of the tree. Applying the floor only to
    // the persistent one meant coming home restored a remembered 680px panel
    // into 640px of room, which is exactly the crush the rule exists to stop.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const dock = readFileSync(new URL("./PinnedPanelDock.tsx", import.meta.url), "utf8");
    expect(
      /style=\{\{ width: drawnColumnWidth/.test(chat),
      "the in-chat column draws a FITTED width",
    ).toBe(true);
    expect(
      /const asSheet = isMobile \|\| !columnFits;/.test(chat),
      "…and where no column fits, BOTH the explicit open and the restore land in a sheet",
    ).toBe(true);
    // BEFORE PAINT: a passive restore leaves the first frame of the remounted
    // conversation showing the pinned reading nowhere, wherever the persistent
    // column does not render.
    expect(
      /shouldRestoreInChat[\s\S]{0,80}?return;/.test(chat) &&
        chat.indexOf("useLayoutEffect", chat.indexOf("COMING HOME")) <
          chat.indexOf("shouldRestoreInChat", chat.indexOf("COMING HOME")),
      "the restore runs in a layout effect",
    ).toBe(true);
    expect(
      dock.includes("panelFitsBeside(available, min)"),
      "the persistent one asks the same question",
    ).toBe(true);
    expect(
      chat.includes("useWorkspaceRoom(") && dock.includes("useWorkspaceRoom("),
      "…measured the same way, from the workspace",
    ).toBe(true);
    // AND during the drag, not only at render: the separator's first move used
    // to repaint the raw remembered width, which is how the thread vanished.
    const fits = [...chat.matchAll(/fit: fitFor\(/g)];
    expect(
      fits.length,
      "the three in-chat widths each resize against the shared room",
    ).toBe(3);
    expect(
      [...dock.matchAll(/fit: fitFor\(/g)].length,
      "and so do the persistent one's",
    ).toBe(3);
  });

  test("too narrow for a column: the panel becomes a sheet, not a sliver", () => {
    // An explicit open must always show something — nobody clicks a source chip
    // to watch nothing happen. But a 380px document column in 508px of shared
    // room left the conversation at ~128px, and `.oc-main` has no minimum: with
    // a wide sidebar it reached zero. Below the floor the panel takes the
    // presentation it already has on a phone.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    expect(
      /const columnFits = openKind === null \|\| panelFitsBeside\(room, columnMin\);/.test(
        chat,
      ),
    ).toBe(true);
    expect(
      /const asSheet = isMobile \|\| !columnFits;/.test(chat),
      "…and it is the SAME decision for the phone and the narrow desktop",
    ).toBe(true);
    const sheets = [...chat.matchAll(/Open && asSheet \? \(/g)];
    expect(sheets.length, "the four contents").toBe(4);
    expect(
      chat.includes("cronOpen) && !asSheet ? ("),
      "and the column renders only when it fits",
    ).toBe(true);
  });

  test("two columns at once share ONE budget, not two", () => {
    // A reading pinned in one conversation stays in the persistent column while
    // a different one is opened in the conversation you are now in. Each
    // measuring the full room meant each believed the other's width was free,
    // and the thread between them was crushed by the pair.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const room = readFileSync(new URL("./useWorkspaceRoom.ts", import.meta.url), "utf8");
    expect(
      chat.includes("useWorkspaceRoom({ minusPinnedColumn: true })"),
      "the in-chat column takes what the persistent one leaves",
    ).toBe(true);
    expect(
      room.includes('row.querySelector(".oc-pinpanel")'),
      "…which means measuring it, and watching it come and go",
    ).toBe(true);
    // 940 shared, a pinned document at 520: what is left is 420, which cannot
    // hold another 380 column beside a 420 thread — so the second one is a sheet.
    expect(panelFitsBeside(940 - 520, 380)).toBe(false);
    expect(panelFitsBeside(940, 380), "…whereas the full room would have said yes").toBe(
      true,
    );
  });

  test("a narrow window never destroys the width the reader chose", () => {
    // The viewport ceiling used to be written back into the stored value: a
    // 1200px document column became 720px in a small window and STAYED 720px
    // once the window grew again. The persistent column mounts these widths even
    // with nothing pinned, so merely opening the app on a small screen was
    // enough to lose the preference.
    const hook = readFileSync(
      new URL("../lib/useSidebarLayout.ts", import.meta.url),
      "utf8",
    );
    expect(
      /localStorage\.setItem\(storageKey, String\(wanted\)\)/.test(hook),
      "what is persisted is the PREFERENCE, not the drawn width",
    ).toBe(true);
    expect(
      /const width = fit\(clamp\(/.test(hook),
      "…and the window's ceiling applies to what is DRAWN",
    ).toBe(true);
    expect(
      /setWidth\(\(w\) => clamp\(w\)\)/.test(hook),
      "no automatic write-back of a viewport-shrunk width",
    ).toBe(false);
    // …nor through the drag: a one-pixel move against a limit the room already
    // imposes changes nothing visible, and must not replace the preference with
    // whatever the window happens to allow.
    expect(
      /const next = clampStored\(startW \+ sign \* \(ev\.clientX - startX\)\);/.test(hook),
      "the dragged value is bounded by the column's own limits only",
    ).toBe(true);
    expect(
      /if \(drawnFor\(next\) !== drawnFor\(latest\)\) visiblyMoved = true;/.test(hook),
      "visibility is judged AT THE MOVE, both sides under the same constraints",
    ).toBe(true);
    expect(
      /const asked = visiblyMoved && latest !== startW;/.test(hook),
      "…and a separator brought back to where it began asked for NOTHING",
    ).toBe(true);
    expect(/if \(!asked\) return;/.test(hook), "nothing committed without it").toBe(
      true,
    );
    // And the settle is SYNCHRONOUS: a gesture can end because the component is
    // going away, and `setWidth` on a component React will never render again
    // never reaches the persist effect — the width was dropped, the twin column
    // kept the old one, and the panel snapped back at the next mount.
    expect(
      /const commitWidth = useCallback\([\s\S]{0,240}?localStorage\.setItem\(storageKey, String\(w\)\);[\s\S]{0,160}?publishWidth\(storageKey, w[\s\S]{0,80}?setWidth\(w\);/.test(
        hook,
      ),
      "state, storage and broadcast settle in one synchronous act",
    ).toBe(true);
    expect(/commitWidth\(latest\);/.test(hook), "…and the drag uses it").toBe(true);
    // ONE POINTER AT A TIME. A second pointerdown installed a second gesture over
    // the first: both fed on every move from different origins, and whichever
    // came up first settled a width computed from the other.
    expect(
      /if \(stopRef\.current !== null\) return;/.test(hook),
      "a second gesture cannot start while one is live",
    ).toBe(true);
    expect(
      /if \(!draggingRef\.current \|\| ev\.pointerId !== pointerId\) return;/.test(hook),
      "…and only the owning pointer moves it",
    ).toBe(true);
    expect(
      /if \(ev instanceof PointerEvent && ev\.pointerId !== pointerId\) return;/.test(
        hook,
      ),
      "…or ends it — while a blur or an unmount, which carry no pointer, always do",
    ).toBe(true);
    // …and the owning pointer is CAPTURED, or a release outside the viewport is
    // never heard: the gesture stays live, the cursor stays forced, and — one
    // gesture at a time — every later resize of that column is refused.
    expect(
      /grabber\.setPointerCapture\(pointerId\);/.test(hook),
      "the gesture captures its pointer",
    ).toBe(true);
    expect(
      /document\.addEventListener\("lostpointercapture", onUp\);/.test(hook) &&
        /grabber\.releasePointerCapture\(pointerId\);/.test(hook),
      "…losing it ends the gesture — heard on `document`, where the spec fires it "
        + "once the handle has been detached — and ending it releases the capture",
    ).toBe(true);
    expect(
      /const settled = asked \? latest : wantedRef\.current;/.test(hook),
      "a gesture that asked for nothing puts the DOM back on the PREFERENCE",
    ).toBe(true);
    // …and the DOM is repainted in BOTH cases: a commit equal to the current
    // state re-renders nothing, so the last width the drag painted would stay on
    // screen while React and storage say something else.
    expect(
      /const back = columnRef\.current;\s*\n\s*if \(back\) \{[\s\S]{0,200}?\}\s*\n\s*if \(!asked\) return;/.test(
        hook,
      ),
      "the final repaint happens before the early return, not inside it",
    ).toBe(true);
    // A column can vanish mid-gesture (the room crossing the threshold, the
    // panel becoming a sheet). The refless path must paint through a transient
    // value, never through the stored preference.
    expect(
      /setProposed\(latest\); *\n/.test(hook) &&
        !/setWidth\(latest\); \/\/ no bound column/.test(hook),
      "the ref-less drag proposes, it does not persist",
    ).toBe(true);
    expect(
      /const width = fit\(clamp\(proposed \?\? wanted\)\);/.test(hook),
      "…and the proposal is what gets drawn while it lasts",
    ).toBe(true);
  });

  test("where it does fit, the thread keeps its floor", () => {
    expect(1600 - fittedPanelWidth(680, 1600, MIN_SOURCES)).toBeGreaterThanOrEqual(
      420,
    );
    expect(900 - fittedPanelWidth(680, 900, MIN_SOURCES)).toBeGreaterThanOrEqual(
      420,
    );
  });

  test("the remembered width is untouched — only what is DRAWN yields", () => {
    // Widening the window must give the reader back exactly the column they set,
    // which it cannot do if the fit has overwritten it.
    const remembered = 680;
    expect(fittedPanelWidth(remembered, 900, MIN_SOURCES)).toBeLessThan(remembered);
    expect(fittedPanelWidth(remembered, 1600, MIN_SOURCES)).toBe(remembered);
  });
});
