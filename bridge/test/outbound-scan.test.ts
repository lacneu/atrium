// Deterministic outbound media: the finalize-time scan hosts NEW outbound files
// the agent produced this turn — independent of MEDIA:. Pins the gates that keep
// it from over-hosting (mode off, prior-turn files, subdirs, dotfiles, already
// delivered, oversize) and that it DOES host a fresh space-named file (the bug).

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAndHostOutbound } from "../src/core/outbound-scan.js";
import { chunkNamesFile } from "../src/core/turn-sink.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function fakeWriter() {
  const hosted: string[] = [];
  const writer = {
    addMedia: vi.fn(async (_messageId: string, m: { filename: string }) => {
      hosted.push(m.filename);
    }),
  } as unknown as ConvexWriter;
  return { writer, hosted };
}

const NOW = 1_000_000_000_000;
const deps = (writer: ConvexWriter, dir: string, enabled = true) => ({
  writer,
  dir,
  maxBytes: 10_000,
  enabled: () => enabled,
});

describe("scanAndHostOutbound", () => {
  it("hosts a fresh file with a SPACE in its name (the reported bug)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atrium-os-"));
    dirs.push(dir);
    await writeFile(join(dir, "IFOA Presentation.pdf"), "x");
    await utimes(join(dir, "IFOA Presentation.pdf"), new Date(NOW), new Date(NOW));
    const { writer, hosted } = fakeWriter();
    await (await scanAndHostOutbound(deps(writer, dir), "m1", "c1", NOW - 1000, new Set(), () => true)).host();
    expect(hosted).toEqual(["IFOA Presentation.pdf"]);
  });

  it("is a no-op when disabled (not shared-fs)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atrium-os-"));
    dirs.push(dir);
    await writeFile(join(dir, "f.pdf"), "x");
    const { writer, hosted } = fakeWriter();
    await (await scanAndHostOutbound(deps(writer, dir, false), "m1", "c1", NOW - 1000, new Set(), () => true)).host();
    expect(hosted).toEqual([]);
  });

  it("skips prior-turn files, subdirs, dotfiles, already-hosted, and oversize", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atrium-os-"));
    dirs.push(dir);
    // fresh, eligible
    await writeFile(join(dir, "new.pdf"), "x");
    await utimes(join(dir, "new.pdf"), new Date(NOW), new Date(NOW));
    // old (prior turn) — mtime well before `since`
    await writeFile(join(dir, "old.pdf"), "x");
    await utimes(join(dir, "old.pdf"), new Date(NOW - 60_000), new Date(NOW - 60_000));
    // already delivered via MEDIA: this turn
    await writeFile(join(dir, "done.pdf"), "x");
    await utimes(join(dir, "done.pdf"), new Date(NOW), new Date(NOW));
    // dotfile (validate marker)
    await writeFile(join(dir, ".marker"), "x");
    await utimes(join(dir, ".marker"), new Date(NOW), new Date(NOW));
    // oversize
    await writeFile(join(dir, "big.pdf"), "y".repeat(20_000));
    await utimes(join(dir, "big.pdf"), new Date(NOW), new Date(NOW));

    const { writer, hosted } = fakeWriter();
    await (await scanAndHostOutbound(
      deps(writer, dir),
      "m1",
      "c1",
      NOW - 1000,
      new Set(["done.pdf"]),
      () => true,
    )).host();
    expect(hosted).toEqual(["new.pdf"]);
  });

  it("CONTAINMENT: a fresh file the turn never NAMED is left alone (cross-conversation leak)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atrium-os-"));
    dirs.push(dir);
    // Two fresh files: the turn's tools only ever mentioned "mine.pdf" — the
    // other belongs to a concurrent mission of ANOTHER conversation (live
    // prod reports 2026-07-14/15: deliverables landed in unrelated chats).
    for (const f of ["mine.pdf", "PA-EL_P1_L2_Planning-directeur_v1.2.pdf"]) {
      await writeFile(join(dir, f), "x");
      await utimes(join(dir, f), new Date(NOW), new Date(NOW));
    }
    const { writer, hosted } = fakeWriter();
    const bag = "exec: python3 build.py --out mine.pdf (exit 0)";
    await (
      await scanAndHostOutbound(
        deps(writer, dir),
        "m1",
        "c1",
        NOW - 1000,
        new Set(),
        (name) => bag.includes(name),
      )
    ).host();
    expect(hosted).toEqual(["mine.pdf"]);
  });

  it("a missing dir is a no-op (never throws)", async () => {
    const { writer, hosted } = fakeWriter();
    await (await scanAndHostOutbound(deps(writer, "/no/such/atrium/os"), "m1", "c1", 0, new Set(), () => true)).host();
    expect(hosted).toEqual([]);
  });

  it("an UNREADABLE dir in shared-fs mode logs the misconfig once (no silent no-op)", async () => {
    // The bench bug the user hit: OPENCLAW_MEDIA_OUTBOUND_DIR pointed at the
    // gateway CONTAINER path -> readdir ENOENT on the host -> every file silently
    // undeliverable. The backstop must SURFACE it, not swallow it. Discriminating:
    // delete the warn and this fails; the errno proves it's the misconfig branch.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { writer, hosted } = fakeWriter();
      // A UNIQUE path so the warn-once Set (keyed by dir) hasn't seen it.
      const badDir = "/no/such/atrium/os-misconfig-1";
      await (await scanAndHostOutbound(deps(writer, badDir), "m1", "c1", 0, new Set(), () => true)).host();
      await (await scanAndHostOutbound(deps(writer, badDir), "m1", "c1", 0, new Set(), () => true)).host();
      expect(hosted).toEqual([]);
      const misconfigWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("outbound dir unreadable"),
      );
      expect(misconfigWarns).toHaveLength(1); // ONCE per dir, even across turns
      expect(String(misconfigWarns[0]![0])).toContain("ENOENT");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("chunkNamesFile (whole-name correlation match)", () => {
  it("accepts whole-name hits, with paths and sentence periods", () => {
    expect(chunkNamesFile("wrote outbound/report.pdf", "report.pdf")).toBe(true);
    expect(chunkNamesFile("j'ai produit report.pdf.", "report.pdf")).toBe(true);
    expect(chunkNamesFile("(report.pdf)", "report.pdf")).toBe(true);
    expect(chunkNamesFile("report.pdf", "report.pdf")).toBe(true);
  });
  it("refuses suffix/extension hits of a LONGER name (cross-file leak)", () => {
    expect(chunkNamesFile("annual-report.pdf", "report.pdf")).toBe(false);
    expect(chunkNamesFile("x.report.pdf", "report.pdf")).toBe(false);
    expect(chunkNamesFile("report.pdf.old kept", "report.pdf")).toBe(false);
    expect(chunkNamesFile("report.pdfx", "report.pdf")).toBe(false);
    expect(chunkNamesFile("nothing here", "report.pdf")).toBe(false);
    // Non-ASCII / tilde continuations are filename material too (codex P1).
    expect(chunkNamesFile("\u00e9report.pdf", "report.pdf")).toBe(false);
    expect(chunkNamesFile("report.pdf~ backup", "report.pdf")).toBe(false);
    expect(chunkNamesFile("rapport-r\u00e9sum\u00e9.pdf", "sum\u00e9.pdf")).toBe(false);
  });
  it("accents inside the searched name itself still whole-match", () => {
    expect(
      chunkNamesFile("livr\u00e9 rapport-r\u00e9sum\u00e9.pdf ici", "rapport-r\u00e9sum\u00e9.pdf"),
    ).toBe(true);
  });
  it("a later whole-name hit wins after an earlier suffix hit", () => {
    expect(
      chunkNamesFile("annual-report.pdf then also report.pdf", "report.pdf"),
    ).toBe(true);
  });
});
