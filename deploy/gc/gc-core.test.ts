// @vitest-environment node
//
// The physical collector's decisions: what it keeps, what it may delete, and when
// it must refuse to delete anything at all.

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  applyRefusal,
  base64DigestToHex,
  emptyState,
  parseDuration,
  parseState,
  plan,
  recheck,
  summaryLine,
  type LiveBlob,
  type StoredObject,
} from "./gc-core.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;
const GRACE = DAY;

const hex = (body: string) => createHash("sha256").update(body).digest("hex");
const b64 = (body: string) => createHash("sha256").update(body).digest("base64");

/** A stored object and, if `live`, the blob that names it. */
function file(key: string, body: string, ageMs: number) {
  const obj: StoredObject = { key, size: body.length, mtimeMs: NOW - ageMs };
  const blob: LiveBlob = { storageId: `id-${key}`, sha256: b64(body), size: body.length, createdAt: NOW - ageMs };
  return { obj, blob, hex: hex(body) };
}

function run(
  objects: StoredObject[],
  live: LiveBlob[],
  digests: Record<string, string>,
  state = emptyState("local:/x"),
  listedAt = NOW,
) {
  return plan({ objects, liveBlobs: live, digestOf: (k) => digests[k], state, listedAt, graceMs: GRACE });
}

describe("matching objects to live blobs", () => {
  test("the inventory's base64 digest is the hasher's hex digest", () => {
    expect(base64DigestToHex(b64("abc"))).toBe(hex("abc"));
    expect(() => base64DigestToHex("AAAA")).toThrow();
  });

  test("a live blob's object is kept; others are orphans; an unknown size needs no digest", () => {
    const a = file("a.blob", "live bytes", 10 * DAY);
    const b = file("b.blob", "dead bytes", 10 * DAY); // same size as a, other content
    const c = file("c.blob", "dead, other size", 10 * DAY);
    const p = run([a.obj, b.obj, c.obj], [a.blob], { "a.blob": a.hex, "b.blob": b.hex });
    expect(p.matched).toBe(1);
    expect(p.orphans.map((o) => o.key)).toEqual(["b.blob", "c.blob"]);
    expect(p.missingLive).toEqual([]);
  });

  test("identical bytes: while one copy is live, every copy is kept", () => {
    const a = file("a.blob", "same", 10 * DAY);
    const twin = { ...a.obj, key: "twin.blob" };
    const p = run([a.obj, twin], [a.blob], { "a.blob": a.hex, "twin.blob": a.hex });
    expect(p.orphans).toEqual([]);
  });
});

describe("the grace, twice", () => {
  test("a first run deletes nothing: orphans are only recorded", () => {
    const b = file("b.blob", "dead", 10 * DAY);
    const p = run([b.obj], [], {});
    expect(p.orphans).toHaveLength(1);
    expect(p.eligible).toEqual([]);
    expect(p.nextState.orphanSince).toEqual({ "b.blob": NOW });
  });

  test("an orphan seen at least the grace ago, and older than the grace, is eligible", () => {
    const b = file("b.blob", "dead", 10 * DAY);
    const state = { ...emptyState("local:/x"), orphanSince: { "b.blob": NOW - GRACE } };
    expect(run([b.obj], [], {}, state).eligible.map((o) => o.key)).toEqual(["b.blob"]);
    const recent = { ...emptyState("local:/x"), orphanSince: { "b.blob": NOW - GRACE + 1 } };
    expect(run([b.obj], [], {}, recent).eligible).toEqual([]);
  });

  test("a young object is never eligible, however long it was seen (an upload in flight)", () => {
    const y = file("y.blob", "partial", HOUR);
    const state = { ...emptyState("local:/x"), orphanSince: { "y.blob": NOW - 5 * DAY } };
    expect(run([y.obj], [], {}, state).eligible).toEqual([]);
  });

  test("a key that is no longer an orphan (or gone) leaves the state", () => {
    const a = file("a.blob", "live", 10 * DAY);
    const state = {
      ...emptyState("local:/x"),
      orphanSince: { "a.blob": NOW - 5 * DAY, "gone.blob": NOW - 5 * DAY },
      digests: { "gone.blob": { size: 1, mtimeMs: 1, sha256: "00" } },
    };
    const p = run([a.obj], [a.blob], { "a.blob": a.hex }, state);
    expect(p.nextState.orphanSince).toEqual({});
    expect(p.nextState.digests).toEqual({});
  });
});

describe("when an apply must delete nothing", () => {
  const opts = { maxMissingLive: 0, allowEmptyInventory: false };

  test("a live blob with no object: the mapping does not hold for this storage", () => {
    const a = file("a.blob", "live", 10 * DAY);
    const other = file("o.blob", "another deployment", 10 * DAY);
    const p = run([other.obj], [a.blob], {});
    expect(p.missingLive.map((b) => b.storageId)).toEqual(["id-a.blob"]);
    expect(applyRefusal(p, opts)).toMatch(/no object/);
  });

  test("a blob created after the listing began is not required to be found", () => {
    const late = { ...file("l.blob", "late", 0).blob, createdAt: NOW + 5 };
    expect(run([], [late], {}).missingLive).toEqual([]);
  });

  test("an unreadable object blocks the apply", () => {
    const a = file("a.blob", "live", 10 * DAY);
    const p = run([a.obj], [a.blob], { "a.blob": undefined as unknown as string });
    expect(p.digestErrors).toEqual(["a.blob"]);
    expect(applyRefusal(p, opts)).toMatch(/could not be read/);
  });

  test("an empty inventory over a non-empty storage (wrong --convex-url)", () => {
    const b = file("b.blob", "x", 10 * DAY);
    const p = run([b.obj], [], {});
    expect(applyRefusal(p, opts)).toMatch(/inventory is empty/);
    expect(applyRefusal(p, { ...opts, allowEmptyInventory: true })).toBeNull();
  });

  test("a clean plan applies, and the summary line says what it did", () => {
    const a = file("a.blob", "live", 10 * DAY);
    const p = run([a.obj], [a.blob], { "a.blob": a.hex });
    expect(applyRefusal(p, opts)).toBeNull();
    expect(summaryLine(p, "dry-run", { count: 0, bytes: 0 })).toMatch(
      /^atrium-blob-gc DRY-RUN: objects=1 .* orphans=0 .* missingLive=0 digestErrors=0$/,
    );
  });
});

describe("state and arguments", () => {
  test("a state file is bound to its storage", () => {
    const raw = JSON.stringify(emptyState("local:/a"));
    expect(parseState(raw, "local:/a").target).toBe("local:/a");
    expect(() => parseState(raw, "s3:x/y/z")).toThrow(/another storage/);
    expect(() => parseState("{}", "local:/a")).toThrow(/format/);
  });

  test("durations", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("36h")).toBe(36 * HOUR);
    expect(parseDuration("2d")).toBe(2 * DAY);
    expect(parseDuration("12")).toBe(12 * HOUR);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("the second inventory read, immediately before deleting", () => {
  const a = file("a.blob", "live bytes", 10 * DAY);
  const dead = file("d.blob", "dead bytes", 10 * DAY);
  const other = file("o.blob", "other size, dead", 10 * DAY);
  const digests: Record<string, string> = { "a.blob": a.hex, "d.blob": dead.hex };
  const eligible = [dead.obj, other.obj];
  const again = (second: LiveBlob[]) =>
    recheck({ first: [a.blob], second, eligible, digestOf: (k) => digests[k], listedAt: NOW });

  test("orphaned in both reads: deleted", () => {
    const r = again([a.blob]);
    expect(r.refusal).toBeNull();
    expect(r.deletable.map((o) => o.key)).toEqual(["d.blob", "o.blob"]);
  });

  test("an old record re-appearing (a restore) stops the whole apply", () => {
    const r = again([a.blob, dead.blob]);
    expect(r.refusal).toMatch(/re-appeared/);
    expect(r.deletable).toEqual([]);
  });

  test("a record whose digest or size changed between the reads stops the apply", () => {
    expect(again([{ ...a.blob, sha256: dead.blob.sha256 }]).refusal).toMatch(/changed/);
    expect(again([{ ...a.blob, size: a.blob.size + 1 }]).refusal).toMatch(/changed/);
  });

  test("a new upload with an eligible object's bytes keeps that object", () => {
    const fresh = { ...dead.blob, storageId: "id-new", createdAt: NOW + 10 };
    const r = again([a.blob, fresh]);
    expect(r.refusal).toBeNull();
    expect(r.deletable.map((o) => o.key)).toEqual(["o.blob"]);
    expect(r.kept.map((o) => o.key)).toEqual(["d.blob"]);
  });

  test("a new record of an eligible object's size, digest unknown: kept", () => {
    const sameSize = { ...file("x", "z".repeat(other.obj.size), 0).blob, createdAt: NOW + 10 };
    const r = again([a.blob, sameSize]);
    expect(r.deletable.map((o) => o.key)).toEqual(["d.blob"]);
    expect(r.kept.map((o) => o.key)).toEqual(["o.blob"]);
  });

  test("a record deleted between the reads changes nothing", () => {
    expect(again([]).deletable).toHaveLength(2);
  });
});
