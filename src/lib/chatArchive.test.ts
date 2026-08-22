// Building an archive and applying it, against fakes.
//
// This is where the orchestration bugs live: the cursors, the blob mapping, the
// order sections are applied in, and — the one that matters most — what happens
// when an import fails halfway.

import { describe, expect, test, vi } from "vitest";
import {
  ArchiveTooLarge,
  STALE_IMPORT_MS,
  staleImports,
  BLOB_PREFIX,
  MANIFEST_ENTRY,
  applyArchive,
  buildArchive,
  type ExportSource,
  type ImportTarget,
  type SectionPage,
} from "./chatArchive";
import { readZip } from "./zipStore";

const MANIFEST = {
  formatVersion: 1,
  origin: "atr_" + "a".repeat(32),
  sections: ["messages", "files"],
  notIncluded: [{ what: "traces", why: "operational" }],
  chatFieldsDropped: ["recoverableSession"],
};

const empty: SectionPage = { rows: [], blobs: [], cursor: null };

function source(overrides: Partial<ExportSource> = {}): ExportSource {
  return {
    manifest: async () => MANIFEST,
    chat: async (chatId) => ({ _id: chatId, title: "sujet" }),
    section: async () => empty,
    blob: async () => new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function target(overrides: Partial<ImportTarget> = {}): ImportTarget {
  return {
    begin: async () => "imp1",
    batch: async (_id, _section, rows) => ({
      written: rows.length,
      writtenIds: rows.map((row) => row._id as string),
    }),
    finish: async () => ({ done: true }),
    abandon: async () => ({ done: true }),
    upload: async (_bytes, name) => `storage-${name}`,
    registerBlob: async () => undefined,
    discardUpload: async () => undefined,
    ...overrides,
  };
}

describe("building an archive", () => {
  test("every page of every section is walked to the end", async () => {
    // A cursor abandoned early ships a truncated conversation that looks whole.
    const pages: Record<string, SectionPage[]> = {
      messages: [
        { rows: [{ _id: "m1" }], blobs: [], cursor: "c1" },
        { rows: [{ _id: "m2" }], blobs: [], cursor: "c2" },
        { rows: [{ _id: "m3" }], blobs: [], cursor: null },
      ],
      files: [empty],
    };
    const seen: (string | null)[] = [];
    const { archive } = await buildArchive(
      source({
        section: async (_chat, section, cursor) => {
          seen.push(cursor);
          const list = pages[section]!;
          return list.shift() ?? empty;
        },
      }),
      ["chat1"],
    );

    expect(seen).toEqual([null, "c1", "c2", null]);
    const names = readZip(archive).map((e) => e.name);
    expect(names).toContain("sections/chat1/messages/0.json");
    expect(names).toContain("sections/chat1/messages/2.json");
  });

  test("an attachment whose BYTES are gone is reported, not silently dropped", async () => {
    // Storage can no longer resolve it. The row still names it, so the import
    // would drop the attachment — an archive that looks complete while it is not.
    const { archive, missingBlobs } = await buildArchive(
      source({
        section: async (_c, section) =>
          section === "files"
            ? {
                rows: [{ _id: "f1", archiveBlobKey: "perdu" }],
                blobs: [
                  { key: "perdu", url: null, filename: "a", mimeType: "m" },
                ],
                cursor: null,
              }
            : empty,
      }),
      ["chat1"],
    );

    expect(missingBlobs).toEqual(["perdu"]);
    // ...and the archive itself says so, for whoever opens it later.
    const manifestEntry = readZip(archive).find((e) => e.name === MANIFEST_ENTRY)!;
    const written = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
    expect(written.missingBlobs).toEqual(["perdu"]);
  });

  test("names inside the archive are ASCII, so it opens anywhere", async () => {
    // Unzip implementations old enough to ignore the UTF-8 flag are still what a
    // lot of people have; keeping our own names ASCII costs nothing.
    const { archive } = await buildArchive(
      source({
        section: async (_c, section) =>
          section === "files"
            ? {
                rows: [{ _id: "f1", archiveBlobKey: "f1" }],
                blobs: [
                  {
                    key: "f1",
                    url: "https://x/1",
                    filename: "été.png",
                    mimeType: "image/png",
                  },
                ],
                cursor: null,
              }
            : empty,
      }),
      ["chat1"],
    );

    for (const entry of readZip(archive)) {
      // eslint-disable-next-line no-control-regex
      expect(entry.name).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  test("bytes shared by two rows are stored ONCE", async () => {
    // A forked conversation references the same attachment; storing it twice
    // doubles the archive for nothing.
    const blob = {
      key: "same",
      url: "https://x/1",
      filename: "a.png",
      mimeType: "image/png",
    };
    const fetched = vi.fn(async () => new Uint8Array([9]));
    const { archive, blobCount } = await buildArchive(
      source({
        section: async (_c, section) =>
          section === "files"
            ? { rows: [{ _id: "f1" }], blobs: [blob, blob], cursor: null }
            : empty,
        blob: fetched,
      }),
      ["chat1"],
    );

    expect(blobCount).toBe(1);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(
      readZip(archive).filter((e) => e.name.startsWith(BLOB_PREFIX)),
    ).toHaveLength(1);
  });

  test("an archive past the ceiling STOPS rather than shipping truncated", async () => {
    const huge = new Uint8Array(1024 * 1024);
    await expect(
      buildArchive(
        source({
          section: async (_c, section) =>
            section === "files"
              ? {
                  rows: [{ _id: "f1" }],
                  blobs: Array.from({ length: 1000 }, (_v, i) => ({
                    key: `b${i}`,
                    url: `https://x/${i}`,
                    filename: "a",
                    mimeType: "application/octet-stream",
                  })),
                  cursor: null,
                }
              : empty,
          blob: async () => huge,
        }),
        ["chat1"],
      ),
    ).rejects.toThrow(ArchiveTooLarge);
  });

  test("a cursor that never ends is an ERROR, not a quiet stop", async () => {
    await expect(
      buildArchive(
        source({ section: async () => ({ rows: [], blobs: [], cursor: "x" }) }),
        ["chat1"],
      ),
    ).rejects.toThrow(/did not finish/);
  });
});

describe("finding the imports a closed tab left behind", () => {
  test("a LIVE import in another tab is left alone", () => {
    // It writes on every batch, so it stays fresh. Tearing it down would break a
    // transfer that is working, in a window this person cannot see.
    const now = 1_000_000_000;

    expect(
      staleImports(
        [
          { importId: "live", updatedAt: now - 1_000 },
          { importId: "stale", updatedAt: now - STALE_IMPORT_MS - 1 },
        ],
        now,
      ).map((row) => row.importId),
    ).toEqual(["stale"]);
  });

  test("nothing open means nothing to sweep", () => {
    expect(staleImports([], Date.now())).toEqual([]);
  });
});

describe("applying an archive", () => {
  async function archiveOf(pages: Record<string, SectionPage[]>) {
    const { archive } = await buildArchive(
      source({
        section: async (_chat, section) => pages[section]?.shift() ?? empty,
      }),
      ["chat1"],
    );
    return archive;
  }

  test("bytes are uploaded BEFORE the rows that name them", async () => {
    // A row naming an attachment cannot be written before the attachment exists
    // here — the import would skip it.
    const order: string[] = [];
    const archive = await archiveOf({
      files: [
        {
          rows: [{ _id: "f1", archiveBlobKey: "f1" }],
          blobs: [
            {
              key: "f1",
              url: "https://x/1",
              filename: "a.png",
              mimeType: "image/png",
            },
          ],
          cursor: null,
        },
      ],
    });

    await applyArchive(
      target({
        upload: async () => {
          order.push("upload");
          return "s1";
        },
        batch: async (_i, section, rows) => {
          order.push(`batch:${section}`);
          return { written: rows.length, writtenIds: rows.map((r) => r._id as string) };
        },
      }),
      archive,
      null,
    );

    expect(order[0]).toBe("upload");
    expect(order).toContain("batch:chats");
    expect(order.indexOf("upload")).toBeLessThan(order.indexOf("batch:files"));
  });

  test("the conversation is applied before the rows that reference it", async () => {
    const sections: string[] = [];
    const archive = await archiveOf({
      messages: [{ rows: [{ _id: "m1", chatId: "chat1" }], blobs: [], cursor: null }],
    });

    await applyArchive(
      target({
        batch: async (_i, section, rows) => {
          sections.push(section);
          return { written: rows.length, writtenIds: rows.map((r) => r._id as string) };
        },
      }),
      archive,
      null,
    );

    expect(sections[0]).toBe("chats");
    expect(sections).toContain("messages");
  });

  test("pages are applied in NUMERIC order, not alphabetical", async () => {
    // Ten pages sort as 0, 1, 10, 2 as strings — and a reference inside a section
    // can point at a row from an earlier page.
    const pages: SectionPage[] = Array.from({ length: 11 }, (_v, i) => ({
      rows: [{ _id: `m${i}` }],
      blobs: [],
      cursor: i === 10 ? null : `c${i}`,
    }));
    const archive = await archiveOf({ messages: pages });
    const applied: string[] = [];

    await applyArchive(
      target({
        batch: async (_i, section, rows) => {
          if (section === "messages") applied.push(rows[0]!._id as string);
          return { written: rows.length, writtenIds: rows.map((r) => r._id as string) };
        },
      }),
      archive,
      null,
    );

    expect(applied).toEqual(
      Array.from({ length: 11 }, (_v, i) => `m${i}`),
    );
  });

  test("a batch is handed only the blobs its OWN rows name", async () => {
    // Convex bounds an argument array, and the request size well before that.
    // Handing every batch the whole archive's list failed an import of a few
    // thousand attachments on its very first batch — the one carrying a single
    // conversation row.
    const archive = await archiveOf({
      files: [
        {
          rows: [
            { _id: "f1", archiveBlobKey: "k1" },
            { _id: "f2", archiveBlobKey: "k2" },
          ],
          blobs: [
            { key: "k1", url: "https://x/1", filename: "a", mimeType: "m" },
            { key: "k2", url: "https://x/2", filename: "b", mimeType: "m" },
            { key: "k3", url: "https://x/3", filename: "c", mimeType: "m" },
          ],
          cursor: null,
        },
      ],
    });
    const handed: Record<string, string[]> = {};

    await applyArchive(
      target({
        batch: async (_i, section, rows, blobs) => {
          handed[section] = blobs.map((b) => b.key).sort();
          return { written: rows.length, writtenIds: rows.map((r) => r._id as string) };
        },
      }),
      archive,
      null,
    );

    // The conversation row names none.
    expect(handed.chats).toEqual([]);
    // The file rows name two of the three the archive carries.
    expect(handed.files).toEqual(["k1", "k2"]);
  });

  test("bytes uploaded before a failure are DISCARDED", async () => {
    // The server can only undo the rows it wrote; it never learned about a blob
    // whose batch never ran. Left behind, a repeated bad import fills the
    // storage.
    const discarded: string[] = [];
    const archive = await archiveOf({
      files: [
        {
          rows: [{ _id: "f1", archiveBlobKey: "k1" }],
          blobs: [{ key: "k1", url: "https://x/1", filename: "a", mimeType: "m" }],
          cursor: null,
        },
      ],
    });

    await expect(
      applyArchive(
        target({
          discardUpload: async (_importId, storageId) => {
            discarded.push(storageId);
          },
          batch: async (_i, section, rows) => {
            if (section === "files") throw new Error("echec");
            return { written: rows.length, writtenIds: rows.map((r) => r._id as string) };
          },
        }),
        archive,
        null,
      ),
    ).rejects.toThrow("echec");

    expect(discarded).toEqual(["storage-k1"]);
  });

  test("a failure halfway UNDOES the import", async () => {
    // Otherwise a failed import leaves a folder of conversations nobody can name,
    // and the server can only undo precisely while the import is identified.
    const abandon = vi.fn(async () => ({ done: true }));
    const archive = await archiveOf({
      messages: [{ rows: [{ _id: "m1" }], blobs: [], cursor: null }],
    });

    await expect(
      applyArchive(
        target({
          abandon,
          batch: async (_i, section, rows) => {
            if (section === "messages") throw new Error("le lot a echoue");
            return { written: rows.length, writtenIds: rows.map((r) => r._id as string) };
          },
        }),
        archive,
        null,
      ),
    ).rejects.toThrow("le lot a echoue");

    expect(abandon).toHaveBeenCalledWith("imp1");
  });

  test("bytes no imported row NAMED are removed, even on success", async () => {
    // An untrusted archive may carry blobs no row references, and a row may be
    // skipped for want of a reference. Left behind on a successful import, they
    // fill the storage without anything looking wrong.
    const archive = await archiveOf({
      files: [
        {
          rows: [{ _id: "f1", archiveBlobKey: "k1" }],
          blobs: [
            { key: "k1", url: "https://x/1", filename: "a", mimeType: "m" },
            { key: "orphelin", url: "https://x/2", filename: "b", mimeType: "m" },
          ],
          cursor: null,
        },
      ],
    });
    const discarded: string[] = [];

    const result = await applyArchive(
      target({
        discardUpload: async (_importId, storageId) => {
          discarded.push(storageId);
        },
      }),
      archive,
      null,
    );

    expect(discarded).toEqual(["storage-orphelin"]);
    expect(result.purged).toBe(true);
  });

  test("a purge that does not finish is REPORTED, not called clean", async () => {
    // The server purges a bounded page per call. A ceiling that simply gave up
    // would report a clean finish over a mapping table still holding thousands
    // of rows.
    const archive = await archiveOf({
      messages: [{ rows: [{ _id: "m1" }], blobs: [], cursor: null }],
    });

    const result = await applyArchive(
      target({ finish: async () => ({ done: false }) }),
      archive,
      null,
    );

    // The history IS imported; only the bookkeeping is unfinished, and it says so.
    expect(result.written).toBeGreaterThan(0);
    expect(result.purged).toBe(false);
  });

  test("the ceiling counts what the FILE weighs, not just the payload", async () => {
    // Every entry costs two headers and the name twice. Counting only the data
    // let an archive of many small entries overshoot by megabytes — right where
    // a browser allocation is most likely to fail.
    let built: Uint8Array | null = null;
    const pages: SectionPage[] = Array.from({ length: 400 }, (_v, i) => ({
      rows: [{ _id: `m${i}`, text: "x".repeat(64) }],
      blobs: [],
      cursor: i === 399 ? null : `c${i}`,
    }));
    const { archive } = await buildArchive(
      source({ section: async (_c, section) =>
        section === "messages" ? (pages.shift() ?? empty) : empty,
      }),
      ["chat1"],
    );
    built = archive;

    // The accounting must not be BELOW what was actually written, or the ceiling
    // means nothing at the size where it matters.
    const payload = readZip(built).reduce(
      (sum, e) => sum + e.bytes.length + e.name.length,
      0,
    );
    expect(built.length).toBeGreaterThan(payload);
  });

  test("a row the server SKIPPED does not keep its bytes alive", async () => {
    // A row can be refused for want of a reference. It names its bytes just the
    // same, so counting that as used left an orphan behind a successful import.
    const archive = await archiveOf({
      files: [
        {
          rows: [{ _id: "f1", archiveBlobKey: "k1" }],
          blobs: [{ key: "k1", url: "https://x/1", filename: "a", mimeType: "m" }],
          cursor: null,
        },
      ],
    });
    const discarded: string[] = [];

    await applyArchive(
      target({
        // The server writes the conversation but refuses the file row.
        batch: async (_i, section, rows) =>
          section === "files"
            ? { written: 0, writtenIds: [] }
            : { written: rows.length, writtenIds: rows.map((r) => r._id as string) },
        discardUpload: async (_importId, storageId) => {
          discarded.push(storageId);
        },
      }),
      archive,
      null,
    );

    expect(discarded).toEqual(["storage-k1"]);
  });

  test("an archive naming the same blob twice is REFUSED", async () => {
    // ZIP allows two entries to share a name, and an archive is untrusted.
    // Overwriting would strand the first upload outside the cleanup map.
    const { writeZip: write } = await import("./zipStore");
    const archive = write([
      {
        name: MANIFEST_ENTRY,
        bytes: new TextEncoder().encode(JSON.stringify(MANIFEST)),
      },
      { name: `${BLOB_PREFIX}k1`, bytes: new Uint8Array([1]) },
      { name: `${BLOB_PREFIX}k1`, bytes: new Uint8Array([2]) },
    ]);

    await expect(applyArchive(target(), archive, null)).rejects.toThrow(
      /same blob twice/,
    );
  });

  test("progress counts the two phases that actually take the time", async () => {
    // A spinner over a folder of attachments says nothing. What a reader wants
    // counted is the bytes going out and the bytes coming back.
    const steps: string[] = [];
    const archive = await archiveOf({
      files: [
        {
          rows: [{ _id: "f1", archiveBlobKey: "k1" }],
          blobs: [{ key: "k1", url: "https://x/1", filename: "a", mimeType: "m" }],
          cursor: null,
        },
      ],
    });

    await applyArchive(target(), archive, null, (progress) => {
      steps.push(progress.phase);
    });

    expect(steps).toContain("reading");
    expect(steps).toContain("uploading");
    expect(steps).toContain("writing");
  });

  test("the upload phase knows how many there are, so it can be a fraction", async () => {
    const archive = await archiveOf({
      files: [
        {
          rows: [
            { _id: "f1", archiveBlobKey: "k1" },
            { _id: "f2", archiveBlobKey: "k2" },
          ],
          blobs: [
            { key: "k1", url: "https://x/1", filename: "a", mimeType: "m" },
            { key: "k2", url: "https://x/2", filename: "b", mimeType: "m" },
          ],
          cursor: null,
        },
      ],
    });
    const uploads: { done: number; total: number | null }[] = [];

    await applyArchive(target(), archive, null, (progress) => {
      if (progress.phase === "uploading") {
        uploads.push({ done: progress.done, total: progress.total });
      }
    });

    expect(uploads).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  test("an archive with no manifest is refused", async () => {
    const archive = await archiveOf({});
    const stripped = readZip(archive).filter((e) => e.name !== MANIFEST_ENTRY);
    const { writeZip } = await import("./zipStore");

    await expect(
      applyArchive(target(), writeZip(stripped), null),
    ).rejects.toThrow(/no manifest/);
  });
});
