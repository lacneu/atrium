// THE PHYSICAL COLLECTOR'S DECISIONS, as pure functions (atrium-blob-gc.ts does the
// I/O). Everything that can destroy bytes is decided here, where a test can see it.
//
// HOW AN OBJECT IS TIED TO A LIVE BLOB. Not by name: the backend names each stored
// object with a fresh random UUID (`LocalDirStorage::start_upload` /
// `S3Storage` in crates/storage + crates/aws_s3: `rt.new_uuid_v4()`), distinct from
// the UUID in the blob's URL (`FileStorage::upload_file`: `storage_id =
// new_uuid_v4()`), and the `_storage` document a function can read exposes neither
// (crates/model/src/file_storage/virtual_table.rs keeps only sha256, size and
// contentType). What it does expose is the CONTENT DIGEST — base64 SHA-256 of the
// bytes — and the size. So an object is live when its (size, sha256) is the
// (size, sha256) of a live blob. Two objects with identical bytes are
// indistinguishable: when one of them is live, both are kept. That is the safe
// direction (a duplicate leaks; a live file is never taken).
//
// WHAT MAKES AN APPLY SAFE:
//   - ACCOUNTING: every live blob that existed before the listing began must be
//     found among the objects. If one is not, the mapping this tool relies on does
//     not hold for this storage (wrong bucket/prefix/volume, another deployment's
//     inventory, a changed digest encoding) — nothing is deleted.
//   - GRACE, twice: an object must be older than G, AND it must have been seen
//     orphaned by an earlier run at least G ago (the state file). The second is
//     what protects a backup: a snapshot that copied the database while the blob
//     was still live copies the files at most one backup run later, and G is
//     longer than a run. It also means a first run never deletes anything.

/** One object as listed by the store. */
export type StoredObject = {
  /** The store's key: the path under the files directory, or the S3 key. */
  key: string;
  size: number;
  /** Last modification (local) / LastModified (S3), epoch ms. */
  mtimeMs: number;
};

/** One live blob as storageInventory.listLiveBlobs returns it. */
export type LiveBlob = {
  storageId: string;
  /** Base64 SHA-256, as the `_storage` virtual table encodes it. */
  sha256: string;
  size: number;
  createdAt: number;
};

/** The collector's memory between runs (one file per storage target). */
export type GcState = {
  version: 1;
  /** Which storage this state belongs to (a state is never reused elsewhere). */
  target: string;
  /** Object key -> when a run first saw it orphaned (epoch ms). */
  orphanSince: Record<string, number>;
  /** Object key -> digest cache (objects are immutable; size + mtime guard it). */
  digests: Record<string, { size: number; mtimeMs: number; sha256: string }>;
};

export function emptyState(target: string): GcState {
  return { version: 1, target, orphanSince: {}, digests: {} };
}

/** Parse and check a state file's content for `target`. */
export function parseState(raw: string, target: string): GcState {
  const data = JSON.parse(raw) as Partial<GcState>;
  if (data.version !== 1 || typeof data.target !== "string") {
    throw new Error("state file: unknown format");
  }
  if (data.target !== target) {
    throw new Error(
      `state file belongs to another storage (${data.target}); use a separate --state per storage`,
    );
  }
  return {
    version: 1,
    target,
    orphanSince: { ...(data.orphanSince ?? {}) },
    digests: { ...(data.digests ?? {}) },
  };
}

/** Base64 SHA-256 (the inventory's encoding) to lowercase hex (the hasher's). */
export function base64DigestToHex(b64: string): string {
  const bin = atob(b64);
  if (bin.length !== 32) throw new Error("sha256 digest is not 32 bytes");
  let hex = "";
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** "36h", "2d", "90m" -> ms. A bare number is hours. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/.exec(text.trim());
  if (m === null) throw new Error(`not a duration: ${text} (use 90m, 36h or 2d)`);
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "d" ? 86_400_000 : 3_600_000;
  return n * unit;
}

/** The smallest grace accepted: an upload in flight is written for minutes. */
export const MIN_GRACE_MS = 60 * 60 * 1000;
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

/** The live side, indexed for matching. */
export type LiveIndex = {
  /** size -> hex digests of live blobs of that size. */
  bySize: Map<number, Set<string>>;
  count: number;
};

export function indexLive(blobs: readonly LiveBlob[]): LiveIndex {
  const bySize = new Map<number, Set<string>>();
  for (const b of blobs) {
    const hex = base64DigestToHex(b.sha256);
    let set = bySize.get(b.size);
    if (set === undefined) bySize.set(b.size, (set = new Set()));
    set.add(hex);
  }
  return { bySize, count: blobs.length };
}

/** Does this object need its digest to be decided? Only when a live blob has its
 *  size — any other size cannot be a live blob's bytes. */
export function needsDigest(obj: StoredObject, live: LiveIndex): boolean {
  return live.bySize.has(obj.size);
}

/** What one run found and decided. `digestOf(key)` is the object's hex digest when
 *  it was needed and computed, `null` when computing it failed. */
export type Plan = {
  objects: number;
  objectBytes: number;
  live: number;
  /** Objects whose (size, digest) is a live blob's. */
  matched: number;
  /** Live blobs (older than the listing) with no object: nothing may be deleted. */
  missingLive: LiveBlob[];
  /** Objects whose digest could not be read: nothing may be deleted. */
  digestErrors: string[];
  orphans: StoredObject[];
  /** Orphans old enough AND seen orphaned for at least the grace. */
  eligible: StoredObject[];
  /** The state to save after the run (before any deletion is recorded). */
  nextState: GcState;
};

export function plan(args: {
  objects: readonly StoredObject[];
  liveBlobs: readonly LiveBlob[];
  digestOf: (key: string) => string | null | undefined;
  state: GcState;
  /** When the object listing began. */
  listedAt: number;
  graceMs: number;
}): Plan {
  const { objects, liveBlobs, digestOf, state, listedAt, graceMs } = args;
  const live = indexLive(liveBlobs);
  const found = new Set<string>(); // "size:hex" of live blobs seen among objects
  const orphans: StoredObject[] = [];
  const digestErrors: string[] = [];
  let matched = 0;
  let objectBytes = 0;
  for (const obj of objects) {
    objectBytes += obj.size;
    const sizes = live.bySize.get(obj.size);
    if (sizes === undefined) {
      orphans.push(obj);
      continue;
    }
    const hex = digestOf(obj.key);
    if (hex === null || hex === undefined) {
      digestErrors.push(obj.key);
      continue;
    }
    if (sizes.has(hex)) {
      matched += 1;
      found.add(`${obj.size}:${hex}`);
    } else {
      orphans.push(obj);
    }
  }
  // A blob created after the listing began may legitimately have no object in it.
  const missingLive = liveBlobs.filter(
    (b) => b.createdAt < listedAt && !found.has(`${b.size}:${base64DigestToHex(b.sha256)}`),
  );

  const orphanSince: Record<string, number> = {};
  const eligible: StoredObject[] = [];
  for (const obj of orphans) {
    const since = state.orphanSince[obj.key] ?? listedAt;
    orphanSince[obj.key] = since;
    if (obj.mtimeMs <= listedAt - graceMs && since <= listedAt - graceMs) eligible.push(obj);
  }
  const present = new Set(objects.map((o) => o.key));
  const digests: GcState["digests"] = {};
  for (const [key, d] of Object.entries(state.digests)) {
    if (present.has(key)) digests[key] = d;
  }
  return {
    objects: objects.length,
    objectBytes,
    live: live.count,
    matched,
    missingLive,
    digestErrors,
    orphans,
    eligible,
    nextState: { version: 1, target: state.target, orphanSince, digests },
  };
}

/** Why an apply must not delete anything, or null. */
export function applyRefusal(
  p: Plan,
  opts: { maxMissingLive: number; allowEmptyInventory: boolean },
): string | null {
  if (p.digestErrors.length > 0) {
    return `${p.digestErrors.length} object(s) could not be read; fix access and run again`;
  }
  if (p.missingLive.length > opts.maxMissingLive) {
    return (
      `${p.missingLive.length} live blob(s) have no object in this storage — wrong ` +
      `volume, bucket or prefix, or bytes already lost; nothing will be deleted`
    );
  }
  if (p.live === 0 && p.objects > 0 && !opts.allowEmptyInventory) {
    return "the live inventory is empty while the storage is not; check --convex-url";
  }
  return null;
}

/**
 * THE SECOND READ. The inventory is read again immediately before deleting, and an
 * object goes only if it is orphaned in BOTH reads. Between the two, a restore
 * (`npx convex import --replace` / `--replace-all`) can bring an old record back
 * while its bytes still exist; deleting from the first read alone would destroy
 * them. Any sign of such a change stops the whole apply rather than trimming it:
 *   - a record present in both reads whose digest or size changed;
 *   - a record in the second read only, created before the listing began — an
 *     old record re-appearing is what a restore looks like (a record created
 *     after the listing is an ordinary new upload).
 * Of the eligible objects, one whose size a live record of the second read has is
 * deleted only if its known digest is not that record's; unknown digest -> kept.
 */
export function recheck(args: {
  first: readonly LiveBlob[];
  second: readonly LiveBlob[];
  eligible: readonly StoredObject[];
  digestOf: (key: string) => string | null | undefined;
  listedAt: number;
}): { deletable: StoredObject[]; kept: StoredObject[]; refusal: string | null } {
  const before = new Map(args.first.map((b) => [b.storageId, b]));
  for (const b of args.second) {
    const prev = before.get(b.storageId);
    if (prev !== undefined) {
      if (prev.sha256 !== b.sha256 || prev.size !== b.size) {
        return { deletable: [], kept: [...args.eligible], refusal: `record ${b.storageId} changed between the two inventory reads` };
      }
    } else if (b.createdAt < args.listedAt) {
      return {
        deletable: [],
        kept: [...args.eligible],
        refusal: `record ${b.storageId} re-appeared between the two inventory reads (a restore?)`,
      };
    }
  }
  const live = indexLive(args.second);
  const deletable: StoredObject[] = [];
  const kept: StoredObject[] = [];
  for (const obj of args.eligible) {
    const sizes = live.bySize.get(obj.size);
    if (sizes === undefined) {
      deletable.push(obj);
      continue;
    }
    const hex = args.digestOf(obj.key);
    if (hex !== null && hex !== undefined && !sizes.has(hex)) deletable.push(obj);
    else kept.push(obj);
  }
  return { deletable, kept, refusal: null };
}

const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;
export function humanBytes(n: number): string {
  let v = n;
  let u = 0;
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000;
    u += 1;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${UNITS[u]}`;
}

/** The one line an operator (or a cron log) reads. */
export function summaryLine(
  p: Plan,
  mode: "dry-run" | "apply",
  deleted: { count: number; bytes: number },
): string {
  const sum = (xs: readonly StoredObject[]) => xs.reduce((a, o) => a + o.size, 0);
  return [
    `atrium-blob-gc ${mode.toUpperCase()}:`,
    `objects=${p.objects} (${humanBytes(p.objectBytes)})`,
    `live=${p.live}`,
    `matched=${p.matched}`,
    `orphans=${p.orphans.length} (${humanBytes(sum(p.orphans))})`,
    `eligible=${p.eligible.length} (${humanBytes(sum(p.eligible))})`,
    `waiting=${p.orphans.length - p.eligible.length}`,
    `deleted=${deleted.count} (${humanBytes(deleted.bytes)})`,
    `missingLive=${p.missingLive.length}`,
    `digestErrors=${p.digestErrors.length}`,
  ].join(" ");
}
