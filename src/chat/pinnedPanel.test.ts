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
  getPinnedPanel,
  openPanel,
  panelIdentity,
  panelOpenHere,
  pinBelongsHere,
  setPanelPinned,
  setPinnedParams,
  releasePinnedPanel,
  shouldDropOnLeave,
  subscribePinnedPanel,
  unpinOutcome,
  whoOwns,
} from "./pinnedPanel";

const ME = "userA";

/** Open a reading AND pin it — the state most of these rules are about. Opening
 *  and pinning are two acts now, and keeping them two here is the point: what
 *  changed is that pinning no longer moves anything. */
/** What `isPinnedContent` used to answer, expressed against what the store now
 *  offers. The question survives the refactor — "is the column showing THIS very
 *  reading?" — even though nothing hands anything over any more: it is what keys
 *  the error boundary, and the identity cases below are the ones that cost the
 *  most to get right.  */
function showsExactly(
  viewer: { userId: string; chatId: string | null },
  kind: Parameters<typeof panelIdentity>[0] | null,
  params: Record<string, unknown> | null,
): boolean {
  const open = panelOpenHere(getPinnedPanel(), viewer);
  if (open === null || kind === null || params === null) return false;
  return (
    open.kind === kind &&
    panelIdentity(open.kind, open.params) === panelIdentity(kind, params)
  );
}

function pinPanel(args: Parameters<typeof openPanel>[0]) {
  const rec = openPanel(args);
  setPanelPinned(rec.pinId, true);
  return getPinnedPanel()!;
}

/** The desktop reader, in chat A. */
/** The desktop reader, in chat A, with an EMPTY column. */
const here = {
  userId: ME,
  chatId: "chatA",
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

  test("subscribers hear each act: opening, pinning, releasing", () => {
    let hits = 0;
    const off = subscribePinnedPanel(() => (hits += 1));
    const rec = openPanel(aDoc);
    expect(hits, "opening").toBe(1);
    setPanelPinned(rec.pinId, true);
    expect(hits, "pinning is its own change, on the same record").toBe(2);
    // …and setting it to what it already is changes nothing, so it says nothing:
    // a no-op that emitted would re-render every subscriber on every render.
    setPanelPinned(rec.pinId, true);
    expect(hits).toBe(2);
    setPanelPinned(rec.pinId, false);
    expect(hits, "unpinning").toBe(3);
    releasePinnedPanel();
    expect(hits, "releasing").toBe(4);
    off();
    openPanel(aDoc);
    expect(hits, "an unsubscribed listener stops hearing").toBe(4);
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
  test("no close reaches across into another conversation's reading", () => {
    // A panel pinned from ANOTHER conversation is on screen here. A chip's
    // close in THIS thread must not dismiss it — the reader never touched it.
    // Every content's `close` therefore goes through the one guarded closer.
    const src = readFileSync(
      new URL("./ConvexChat.tsx", import.meta.url),
      "utf8",
    );
    const closes = [...src.matchAll(/^\s*close: (.+),$/gm)].map((mm) => mm[1]);
    expect(closes.length, "sources, sub-agent, document, cron").toBe(4);
    expect(
      closes.filter((c) => c !== "closeIfOpenHere"),
      "a close that is not the guarded one can dismiss another conversation's reading",
    ).toEqual([]);
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
    expect(showsExactly(here, "sources", { messageId: "m1" })).toBe(
      true,
    );
    expect(showsExactly(here, "sources", { messageId: "m2" })).toBe(
      false,
    );
  });

  test("same identifier, different KIND, is not the pinned one either", () => {
    pinPanel(sourcesOf("m1"));
    expect(
      showsExactly(here, "subagent", {
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
      showsExactly(here, "document", {
        doc: { storageId: "st1", url: "https://signed/RESIGNED" },
      }),
      "a re-signed URL is the same document",
    ).toBe(true);
    expect(
      showsExactly(here, "document", {
        doc: { storageId: "st2", url: "https://signed/one" },
      }),
    ).toBe(false);
  });

  test("nothing open means nothing is pinned HERE", () => {
    pinPanel(sourcesOf("m1"));
    expect(showsExactly(here, null, null)).toBe(false);
  });
});



describe("a pinned document can move to its newer version", () => {
  test("moving to a newer version keeps ONE reading, not two", () => {
    // One surface draws a pinned document, so a version change is a change of
    // params on the same pin rather than a negotiation between two columns.
    const v1 = { doc: { storageId: "v1" } };
    const pin = pinPanel({
      kind: "document",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: v1,
    });
    expect(showsExactly(here, "document", v1)).toBe(true);
    setPinnedParams(pin.pinId, { doc: { storageId: "v2" } });
    const moved = getPinnedPanel();
    expect(moved?.pinId, "same pin, same panel, same place").toBe(pin.pinId);
    expect(
      showsExactly(here, "document", v1),
      "the version it left is no longer the pinned reading",
    ).toBe(false);
  });

  test("a version change REWRITES the reading; it never opens a second one", () => {
    // Opening anew would mint a fresh record — dropping the pin and remounting
    // the viewer, which is the unmount this whole design removes. Both entry
    // points (the conversation's provider and the column's own) must therefore
    // rewrite the record in place. Derived from the source because the defect
    // is a call that LOOKS right: `openFor` where `setPinnedParams` belongs.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const dock = readFileSync(new URL("./PinnedPanelDock.tsx", import.meta.url), "utf8");
    for (const [name, src] of [["the conversation", chat], ["the column", dock]] as const) {
      const after = src.slice(src.indexOf("openNewerVersion"));
      const body = after.slice(0, after.indexOf("close:"));
      expect(
        body.includes("setPinnedParams"),
        `${name} rewrites the open reading rather than opening a new one`,
      ).toBe(true);
    }
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
    expect(boundaries.length, "the four narrow-screen sheets").toBe(4);
    const without = [...chat.matchAll(/<PanelBodyBoundary\b(?:(?!onClose)[\s\S]){0,400}?>/g)];
    expect(
      without.length,
      "a boundary with no onClose leaves a broken panel on screen for good",
    ).toBe(0);
    expect(/<PanelBodyBoundary[^>]*onClose=/.test(dock), "the dock's too").toBe(true);
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
    // A PINNED reading is never a sheet: the column keeps it mounted and hidden
    // instead, so widening the window gives it back at the page it was on. If
    // this dropped out, the sheet and the hidden column would both be live and
    // one PDF would be parsed twice.
    expect(
      /const asSheet =\s*\n?\s*columnOpen && \(isMobile \|\| !columnFits\) && openHere\?\.pinned !== true;/.test(
        chat,
      ),
      "…the same decision for the phone and the narrow desktop, and never for a pinned reading",
    ).toBe(true);
    const sheets = [...chat.matchAll(/Open && asSheet \? \(/g)];
    expect(sheets.length, "the four contents").toBe(4);
    // …and the conversation no longer renders a column of its own AT ALL: that
    // second surface is what made pinning an unmount.
    expect(
      chat.includes('className="oc-sources-col"'),
      "the conversation must not grow a second column back",
    ).toBe(false);
  });

  test("ONE column, so no second width to budget against", () => {
    // A reading pinned elsewhere used to sit in the persistent column while the
    // conversation opened another in its own — two columns, one thread crushed
    // between them, and a whole width negotiation to keep them apart. Opening
    // now REPLACES, so the negotiation has nothing left to arbitrate.
    const chat = readFileSync(new URL("./ConvexChat.tsx", import.meta.url), "utf8");
    const room = readFileSync(new URL("./useWorkspaceRoom.ts", import.meta.url), "utf8");
    expect(
      chat.includes("minusPinnedColumn"),
      "no second column to subtract",
    ).toBe(false);
    expect(
      room.includes("minusPinnedColumn"),
      "…and the measurement stops offering the option, or it grows back by use",
    ).toBe(false);
    // The floor itself is unchanged: one column still yields to the thread.
    expect(panelFitsBeside(940, 380)).toBe(true);
    expect(panelFitsBeside(700, 380)).toBe(false);
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

describe("a pinned reading is never torn down", () => {
  // The whole point of the pin: the subtree is mounted once and stays mounted.
  // Anything that returns null instead of hiding it rebuilds a PDF from scratch
  // and lands the reader back on page one — the defect reported in production.
  test("no room means HIDDEN for a PINNED reading, never unmounted", () => {
    const dock = readFileSync(new URL("./PinnedPanelDock.tsx", import.meta.url), "utf8");
    expect(
      /const roomless = isMobile \|\| !panelFitsBeside\(available, min\);/.test(dock),
      "the roomless state is computed…",
    ).toBe(true);
    expect(
      /hidden=\{roomless\}/.test(dock),
      "…and hides the column instead of returning null",
    ).toBe(true);
    // An UNPINNED panel in that state IS unmounted here, on purpose: the
    // conversation shows it as a sheet, and two live copies would parse one PDF
    // twice. The order matters — this return must come before the render, and
    // must be conditioned on the panel not being pinned.
    expect(
      /if \(roomless && !pin\.pinned\) return null;/.test(dock),
      "the unpinned narrow case stands down for the sheet",
    ).toBe(true);
  });

  test("PINNING MOVES NOTHING — it sets a flag on the record already mounted", () => {
    // THE defect the users reported, from both ends: pinning used to hand the
    // reading from the conversation's column to the persistent one, and a
    // handover between two components is an unmount — a PDF open at page 15 came
    // back at page 1. Unpinning handed it back, except the conversation had let
    // go, so the panel vanished. Derived from the source because the mistake to
    // guard against is a call that reads perfectly well: `openPanel` where
    // `setPanelPinned` belongs.
    const dock = readFileSync(new URL("./PinnedPanelDock.tsx", import.meta.url), "utf8");
    const button = dock.slice(dock.indexOf("aria-pressed={pin.pinned}"));
    const handler = button.slice(0, button.indexOf("</button>"));
    expect(
      handler.includes("setPanelPinned(pin.pinId, true)"),
      "pinning flips the flag",
    ).toBe(true);
    expect(
      handler.includes("openPanel("),
      "…and never re-opens the reading, which would mint a new record and remount it",
    ).toBe(false);
    // The store side of the same promise: setting the flag keeps the pinId, so
    // nothing keyed on it is torn down.
    const rec = openPanel(aDoc);
    setPanelPinned(rec.pinId, true);
    expect(getPinnedPanel()?.pinId, "same record, same mount").toBe(rec.pinId);
    expect(getPinnedPanel()?.params, "same content, untouched").toBe(rec.params);
  });
});

describe("the same document in another conversation is another reading", () => {
  test("opening it there is not refused because a twin is pinned here", () => {
    // Forks share their documents. On identity alone, the other conversation's
    // column stood down — the reader clicked and nothing happened — while the
    // panel kept showing the file in the context it was pinned from, drafts and
    // version history included.
    const doc = { doc: { filename: "note.md", storageId: "shared" } };
    const pin = pinPanel({
      kind: "document",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: doc,
    });
    expect(showsExactly(here, "document", doc), "in its own chat").toBe(true);
    expect(
      showsExactly(elsewhere, "document", doc),
      "…and NOT in another one, whose column must be free to draw it",
    ).toBe(false);
  });
});

// THE TWO THINGS THE CLIENT ASKED FOR, as rules rather than as symptoms.
//
//  "when I pin, the content must not be refreshed"  -> pinning is a flag on a
//   record that is already mounted (asserted above, "PINNING MOVES NOTHING").
//  "when I unpin it should not close, unless I am not in the conversation it
//   came from" -> the two rules below.
describe("unpinning means something different depending on where you stand", () => {
  const reading = {
    kind: "document" as const,
    ownerUserId: ME,
    originChatId: "chatA",
    originLabel: "Revue budgétaire",
    params: { doc: { filename: "note.md", storageId: "st1" } },
  };

  test("AT HOME, unpinning keeps the reading on screen", () => {
    const rec = openPanel(reading);
    setPanelPinned(rec.pinId, true);
    expect(unpinOutcome(getPinnedPanel(), here)).toBe("keep");
    setPanelPinned(rec.pinId, false);
    expect(
      whoOwns(getPinnedPanel(), here),
      "still drawn: an open panel belongs beside the thread it came from",
    ).toBe("dock");
  });

  test("AWAY FROM HOME, unpinning closes it", () => {
    const rec = openPanel(reading);
    setPanelPinned(rec.pinId, true);
    expect(
      unpinOutcome(getPinnedPanel(), elsewhere),
      "unpinning from another conversation is 'I am carrying on here'",
    ).toBe("close");
    // …and merely clearing the flag would NOT be enough: the record would go
    // invisible and come back the next time the reader walked into chat A.
    setPanelPinned(rec.pinId, false);
    expect(whoOwns(getPinnedPanel(), elsewhere)).toBe("none");
    expect(
      whoOwns(getPinnedPanel(), here),
      "which is why the outcome is 'close', not 'clear the flag'",
    ).toBe("dock");
  });

  test("in Settings, with no conversation at all, unpinning closes it too", () => {
    const rec = openPanel(reading);
    setPanelPinned(rec.pinId, true);
    expect(unpinOutcome(getPinnedPanel(), nowhere)).toBe("close");
  });
});

describe("what earns the screen", () => {
  const openHereRec = () =>
    openPanel({
      kind: "sources",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: { messageId: "m1" },
    });

  test("an UNPINNED panel shows at home and nowhere else", () => {
    openHereRec();
    expect(whoOwns(getPinnedPanel(), here)).toBe("dock");
    expect(whoOwns(getPinnedPanel(), elsewhere)).toBe("none");
    expect(whoOwns(getPinnedPanel(), nowhere)).toBe("none");
  });

  test("a PINNED panel shows everywhere — that is what pinning is", () => {
    const rec = openHereRec();
    setPanelPinned(rec.pinId, true);
    expect(whoOwns(getPinnedPanel(), here)).toBe("dock");
    expect(whoOwns(getPinnedPanel(), elsewhere)).toBe("dock");
    expect(whoOwns(getPinnedPanel(), nowhere)).toBe("dock");
  });

  test("never another reader's, pinned or not", () => {
    const rec = openHereRec();
    expect(whoOwns(getPinnedPanel(), someoneElse)).toBe("none");
    setPanelPinned(rec.pinId, true);
    expect(
      whoOwns(getPinnedPanel(), someoneElse),
      "an identity boundary must not depend on a flag",
    ).toBe("none");
  });

  test("a reading with no conversation of origin is held by the pin alone", () => {
    // A scheduled task opened from Settings has no home to be at.
    const rec = openPanel({
      kind: "cron",
      ownerUserId: ME,
      originChatId: null,
      originLabel: "Tâches programmées",
      params: { instanceName: "olivier", jobId: "j1", part: {}, occurrenceId: "o1" },
    });
    expect(whoOwns(getPinnedPanel(), nowhere)).toBe("none");
    setPanelPinned(rec.pinId, true);
    expect(whoOwns(getPinnedPanel(), nowhere)).toBe("dock");
  });
});

describe("leaving a conversation closes what was only open there", () => {
  const openHereRec = () =>
    openPanel({
      kind: "sources",
      ownerUserId: ME,
      originChatId: "chatA",
      originLabel: "Revue",
      params: { messageId: "m1" },
    });

  test("an unpinned reading is DISCARDED once the reader is elsewhere", () => {
    openHereRec();
    expect(shouldDropOnLeave(getPinnedPanel(), here)).toBe(false);
    expect(
      shouldDropOnLeave(getPinnedPanel(), elsewhere),
      "otherwise it lies in the store and resurfaces on the way back in",
    ).toBe(true);
    expect(shouldDropOnLeave(getPinnedPanel(), nowhere)).toBe(true);
  });

  test("a pinned reading is never discarded — surviving that IS the pin", () => {
    const rec = openHereRec();
    setPanelPinned(rec.pinId, true);
    expect(shouldDropOnLeave(getPinnedPanel(), elsewhere)).toBe(false);
    expect(shouldDropOnLeave(getPinnedPanel(), nowhere)).toBe(false);
  });

  test("another reader's record is never discarded by MY navigation", () => {
    // The identity purge belongs to the identity swap. Doing it from a viewer
    // check would let one session's navigation delete another session's state.
    openHereRec();
    expect(shouldDropOnLeave(getPinnedPanel(), someoneElse)).toBe(false);
  });

  test("nothing open, nothing to discard", () => {
    expect(shouldDropOnLeave(null, elsewhere)).toBe(false);
  });
});

describe("opening replaces, and opens UNPINNED", () => {
  test("a fresh reading is not born pinned", () => {
    const rec = openPanel(aDoc);
    expect(rec.pinned, "pinning is a deliberate act, never a side effect").toBe(false);
  });

  test("opening while something is pinned replaces it — one column, one reading", () => {
    const first = openPanel(aDoc);
    setPanelPinned(first.pinId, true);
    const second = openPanel({ ...aDoc, params: { filename: "autre.md" } });
    expect(getPinnedPanel()?.pinId).toBe(second.pinId);
    expect(getPinnedPanel()?.pinned, "and the replacement starts unpinned").toBe(false);
  });

  test("a STALE pin toggle cannot touch the reading that replaced it", () => {
    const first = openPanel(aDoc);
    const second = openPanel({ ...aDoc, params: { filename: "autre.md" } });
    setPanelPinned(first.pinId, true);
    expect(
      getPinnedPanel()?.pinned,
      "a control captured before the replacement must not pin the new reading",
    ).toBe(false);
    expect(getPinnedPanel()?.pinId).toBe(second.pinId);
  });
});
