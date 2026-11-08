// "Reply to a block…" and "Bookmark a block…" list a reply's blocks (quoteBlocks.ts):
// what each row offers and which anchor it points back to — across every bubble of
// a delegation's answer, whose only ⋯ is its last bubble's (lot 21).
import { describe, expect, test } from "vitest";
import type { BlockFace } from "./bookmarkView";
import { displayGroupPlaces, type GroupedMessage } from "./displayGroups";
import { QUOTE_EXCERPT_CLIENT_MAX } from "./pendingQuote";
import {
  blockChoices,
  blockKey,
  blockOffer,
  listSources,
  pickerFocusOrder,
  type BlockChoice,
  type BlockListKind,
} from "./quoteBlocks";

const text = (t: string): BlockFace => ({ text: t, alt: "", media: false });
const image = (alt: string): BlockFace => ({ text: "", alt, media: true });
const rule: BlockFace = { text: "", alt: "", media: false };
const one = (faces: BlockFace[], kind: BlockListKind = "quote") =>
  blockChoices([{ messageId: "r", faces }], kind);

describe("the blocks a reply offers", () => {
  test("one choice per block with text, in reading order", () => {
    expect(one([text("Premier."), text("Deuxième."), text("Troisième.")])).toEqual([
      { messageId: "r", blockIndex: 0, excerpt: "Premier.", label: "Premier." },
      { messageId: "r", blockIndex: 1, excerpt: "Deuxième.", label: "Deuxième." },
      { messageId: "r", blockIndex: 2, excerpt: "Troisième.", label: "Troisième." },
    ]);
  });

  test("a block without text is skipped from the quotes, NOT renumbered: the index is its anchor", () => {
    expect(one([text("Avant."), text("   \n "), text("Après.")]).map((c) => [c.blockIndex, c.excerpt])).toEqual([
      [0, "Avant."],
      [2, "Après."],
    ]);
  });

  test("the excerpt is the gutter's own: whitespace collapsed, cut at a word", () => {
    const long = Array.from({ length: 80 }, (_, i) => `mot${i}`).join("  \n ");
    const [choice] = one([text(long)]);
    expect(choice.excerpt.endsWith("…")).toBe(true);
    expect(Array.from(choice.excerpt).length).toBeLessThanOrEqual(QUOTE_EXCERPT_CLIENT_MAX + 1);
    expect(choice.excerpt).not.toMatch(/\s{2,}/);
  });

  test("a bookmark goes on any block that shows something: an image by its alt text, or by a generic label; a rule offers nothing", () => {
    const faces = [text("Avant."), image("Schéma du scénario B"), rule, image(""), text("Après.")];
    expect(one(faces, "bookmark").map((c) => [c.blockIndex, c.excerpt, c.label])).toEqual([
      [0, "Avant.", "Avant."],
      [1, "", "Schéma du scénario B"],
      [3, "", ""],
      [4, "Après.", "Après."],
    ]);
    expect(one(faces, "quote").map((c) => c.blockIndex)).toEqual([0, 4]);
  });

  test("the gutter offers through the same rule: what it offers is exactly what the lists hold", () => {
    const faces = [text("Avant."), image("Schéma"), rule, image(""), text(" "), text("Après.")];
    const gutter = faces.map(blockOffer);
    expect(one(faces, "bookmark").map((c) => c.blockIndex)).toEqual(
      gutter.flatMap((offer, i) => (offer === null ? [] : [i])),
    );
    expect(one(faces, "quote").map((c) => c.blockIndex)).toEqual(
      gutter.flatMap((offer, i) => (offer !== null && offer.quote !== "" ? [i] : [])),
    );
  });
});

describe("a delegation's answer: its one ⋯ lists every bubble's blocks (lot 21)", () => {
  // The answer Codex named — three bubbles, only the last with a ⋯ — after a reply alone.
  const transcript: GroupedMessage[] = [
    { _id: "u1", role: "user", text: "Helios ?" },
    { _id: "alone", role: "assistant", text: "Le déploiement d'Helios…" },
    { _id: "u2", role: "user", text: "Fais analyser les scénarios." },
    { _id: "f1", role: "assistant", text: "Je délègue.", displayGroupId: "g" },
    { _id: "f2", role: "assistant", text: "Résultat détaillé.", displayGroupId: "g" },
    { _id: "f3", role: "assistant", text: "Terminé.", displayGroupId: "g" },
  ];
  const faces: Record<string, BlockFace[]> = {
    alone: [text("Le déploiement d'Helios se fait en trois étapes.")],
    f1: [text("Je délègue l'analyse à l'agent Recherche."), text("Il compare le coût, le délai et le risque.")],
    f2: [
      text("Résultat détaillé"),
      text("Le scénario B réduit le coût de 12 %."),
      text("Délai : trois semaines"),
      image("Schéma du scénario B"),
      rule,
      text("Budget : 48 k€"),
    ],
    f3: [text("Terminé : je recommande le scénario B."), text("Dis-moi si tu veux le détail.")],
  };

  /** Each assistant bubble that has a ⋯ — a bubble continued below has none
   *  (ConvexChat: `groupContinues`) — and what its two lists hold. */
  function menus(live: ReadonlySet<string> = new Set()) {
    const places = displayGroupPlaces(
      transcript.map((m) => ({ ...m, status: live.has(m._id) ? "streaming" : "complete" })),
    );
    const out = new Map<string, Record<BlockListKind, BlockChoice[]>>();
    for (const m of transcript) {
      if (m.role !== "assistant") continue;
      const place = places.get(m._id) ?? null;
      if (place?.continues === true) continue;
      const bubbles = listSources(m._id, live.has(m._id), place?.members ?? null).map((id) => ({
        messageId: id,
        faces: faces[id] ?? [],
      }));
      out.set(m._id, { quote: blockChoices(bubbles, "quote"), bookmark: blockChoices(bubbles, "bookmark") });
    }
    return out;
  }
  const keys = (choices: readonly BlockChoice[]) => choices.map((c) => blockKey(c.messageId, c.blockIndex));
  /** What every bubble's gutter offers a mouse: a bookmark on any block showing
   *  something, a quote on any block with text. */
  const gutter = (quote: boolean) =>
    Object.entries(faces).flatMap(([id, fs]) =>
      fs.flatMap((face, i) => {
        const offer = blockOffer(face);
        return offer === null || (quote && offer.quote === "") ? [] : [blockKey(id, i)];
      }),
    );

  test("every block a gutter offers is held by the list of a ⋯ — exactly once, naming its own bubble", () => {
    for (const kind of ["bookmark", "quote"] as const) {
      const held = [...menus().values()].flatMap((lists) => keys(lists[kind]));
      expect(new Set(held).size, kind).toBe(held.length);
      expect([...held].sort(), kind).toEqual([...gutter(kind === "quote")].sort());
    }
  });

  test("only the answer's last bubble has a ⋯: its lists hold the three bubbles' blocks, in reading order", () => {
    const all = menus();
    expect([...all.keys()]).toEqual(["alone", "f3"]);
    expect(keys(all.get("f3")!.bookmark)).toEqual([
      "f1#0", "f1#1", "f2#0", "f2#1", "f2#2", "f2#3", "f2#5", "f3#0", "f3#1",
    ]);
    expect(keys(all.get("f3")!.quote)).toEqual(["f1#0", "f1#1", "f2#0", "f2#1", "f2#2", "f2#5", "f3#0", "f3#1"]);
    expect(keys(all.get("alone")!.quote)).toEqual(["alone#0"]);
  });

  test("a pick of an earlier bubble's block names THAT bubble, never the last", () => {
    const lists = menus().get("f3")!;
    expect(lists.quote.find((c) => c.excerpt.startsWith("Délai"))).toMatchObject({ messageId: "f2", blockIndex: 2 });
    expect(lists.bookmark.find((c) => c.label === "Schéma du scénario B")).toMatchObject({ messageId: "f2", blockIndex: 3 });
    expect(lists.quote.find((c) => c.excerpt.startsWith("Je délègue"))).toMatchObject({ messageId: "f1", blockIndex: 0 });
  });

  test("while the last bubble is written, the settled ones stay listed; a reply alone being written lists nothing", () => {
    const writing = menus(new Set(["f3"])).get("f3")!;
    expect(new Set(writing.bookmark.map((c) => c.messageId))).toEqual(new Set(["f1", "f2"]));
    expect(menus(new Set(["alone"])).get("alone")!.quote).toEqual([]);
  });

  test("listSources: itself alone and settled, nothing while written, the group's settled members in order", () => {
    expect(listSources("r", false, null)).toEqual(["r"]);
    expect(listSources("r", true, null)).toEqual([]);
    const members = [
      { id: "f1", live: false },
      { id: "f2", live: true },
      { id: "f3", live: false },
    ];
    expect(listSources("f3", false, members)).toEqual(["f1", "f3"]);
  });
});

describe("the one fallback both block pickers give the focus back by (lot 12)", () => {
  test("the reply's ⋯, the reply itself, then the composer", () => {
    expect(pickerFocusOrder(false)).toEqual(["trigger", "message", "composer"]);
  });

  test("a quote picked asks the composer first, then the same fallback", () => {
    expect(pickerFocusOrder(true)).toEqual(["composer", ...pickerFocusOrder(false)]);
  });

  test("the reply before the composer: a composer can be disabled, the reply cannot", () => {
    const order = pickerFocusOrder(false);
    expect(order.indexOf("message")).toBeLessThan(order.indexOf("composer"));
  });
});
