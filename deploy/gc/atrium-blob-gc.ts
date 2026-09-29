// atrium-blob-gc — the PHYSICAL garbage collector for a self-hosted Convex backend's
// file storage. Deleting a file in Convex removes its `_storage` record but leaves
// its bytes on disk or in the bucket (get-convex/convex-backend#93); this command
// finds those bytes and, only with --apply, deletes them.
//
// Runs anywhere Node 24 runs — typically `docker run --rm node:24-alpine`, so the
// host needs nothing else (docs/installation/BACKUP.md, "Reclaiming the space of
// deleted files"). DRY RUN by default. The decisions live in gc-core.ts.
//
//   node atrium-blob-gc.ts --convex-url URL --admin-key-file FILE --state FILE
//        (--volume DIR | --s3-bucket NAME [--s3-prefix P] [--instance-name N])
//        [--grace 24h] [--apply] [--list] [--json]
//        [--max-missing-live 0] [--allow-empty-inventory] [--maintenance-lock FILE]
//        [--run-lock FILE (default: atrium-gc.lock beside --state)]

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_GRACE_MS,
  MIN_GRACE_MS,
  applyRefusal,
  emptyState,
  needsDigest,
  indexLive,
  parseDuration,
  parseState,
  plan,
  recheck,
  summaryLine,
  type GcState,
  type LiveBlob,
  type StoredObject,
} from "./gc-core.ts";
import { acquireRunLock } from "./run-lock.ts";
import { S3Client, s3ConfigFromEnv } from "./s3.ts";

/** What the collector needs from a storage. */
export interface ObjectStore {
  /** Identifies the storage in the state file. */
  readonly target: string;
  list(): Promise<StoredObject[]>;
  /** Hex SHA-256 of the object's bytes. */
  digest(key: string): Promise<string>;
  /** Delete one object; false when it changed since it was listed (kept). */
  delete(obj: StoredObject): Promise<boolean>;
}

/** The volume's `storage/files` directory — and nothing else in the volume
 *  (modules, search, exports and snapshot imports live beside it). */
export class LocalFilesStore implements ObjectStore {
  readonly target: string;
  private readonly dir: string;
  constructor(volume: string) {
    this.dir = resolve(volume, "storage", "files");
    this.target = `local:${this.dir}`;
  }

  async list(): Promise<StoredObject[]> {
    const info = await stat(this.dir).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Error(`${this.dir} is not a directory: --volume must be the backend's /convex/data`);
    }
    const out: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        // Dirents are not followed: a symbolic link is neither a file nor a
        // directory here, so nothing outside the files directory is reached.
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".blob")) {
          const s = await lstat(path);
          out.push({ key: relative(this.dir, path).split(sep).join("/"), size: s.size, mtimeMs: s.mtimeMs });
        }
      }
    };
    await walk(this.dir);
    return out;
  }

  private pathOf(key: string): string {
    const path = resolve(this.dir, key);
    if (!path.startsWith(this.dir + sep)) throw new Error(`key escapes the files directory: ${key}`);
    return path;
  }

  async digest(key: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(this.pathOf(key))) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async delete(obj: StoredObject): Promise<boolean> {
    const path = this.pathOf(obj.key);
    const s = await lstat(path).catch(() => null);
    if (s === null) return true;
    if (!s.isFile() || s.size !== obj.size || s.mtimeMs !== obj.mtimeMs) return false;
    await unlink(path);
    return true;
  }
}

/** The FILES bucket, under the deployment's one key prefix. */
export class S3FilesStore implements ObjectStore {
  readonly target: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private prefix: string | null;
  private readonly instanceName: string | null;
  constructor(client: S3Client, bucket: string, endpoint: string, prefix: string | null, instanceName: string | null) {
    this.client = client;
    this.bucket = bucket;
    this.prefix = prefix;
    this.instanceName = instanceName;
    this.target = `s3:${endpoint}/${bucket}/${prefix ?? "*"}`;
  }

  async list(): Promise<StoredObject[]> {
    let prefix = this.prefix;
    if (prefix === null) {
      // Every key is `<instance>-<uuid>/<object uuid>`: exactly one top-level
      // prefix, or the bucket is shared and the operator must name ours.
      const all = await this.client.list("");
      const tops = new Set(all.map((o) => (o.key.includes("/") ? o.key.slice(0, o.key.indexOf("/") + 1) : "")));
      if (tops.size === 0) return [];
      if (tops.size > 1 || tops.has("")) {
        throw new Error(
          `bucket ${this.bucket} holds several key prefixes (${[...tops].slice(0, 5).join(", ")}): pass --s3-prefix`,
        );
      }
      prefix = [...tops][0]!;
      this.prefix = prefix;
      if (this.instanceName !== null && !prefix.startsWith(`${this.instanceName}-`)) {
        throw new Error(`prefix ${prefix} does not belong to instance ${this.instanceName}`);
      }
      return all;
    }
    if (this.instanceName !== null && !prefix.startsWith(`${this.instanceName}-`)) {
      throw new Error(`prefix ${prefix} does not belong to instance ${this.instanceName}`);
    }
    return this.client.list(prefix);
  }

  async digest(key: string): Promise<string> {
    const hash = createHash("sha256");
    const reader = (await this.client.get(key)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return hash.digest("hex");
  }

  async delete(obj: StoredObject): Promise<boolean> {
    await this.client.delete(obj.key);
    return true;
  }
}

/** Every live blob, paged through storageInventory.listLiveBlobs with the admin key
 *  (an internal function: only an admin-key caller reaches it). */
export async function fetchLiveBlobs(convexUrl: string, adminKey: string): Promise<LiveBlob[]> {
  const out: LiveBlob[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = await fetch(`${convexUrl.replace(/\/+$/, "")}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
      body: JSON.stringify({
        path: "storageInventory:listLiveBlobs",
        args: { paginationOpts: { numItems: 500, cursor } },
        format: "json",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { status: "success"; value: { blobs: LiveBlob[]; isDone: boolean; continueCursor: string } }
      | { status: "error"; errorMessage?: string }
      | null;
    if (body === null || body.status !== "success") {
      const why = body !== null && body.status === "error" ? body.errorMessage : `HTTP ${res.status}`;
      throw new Error(`live inventory: ${why ?? "unknown error"}`);
    }
    out.push(...body.value.blobs);
    if (body.value.isDone) return out;
    cursor = body.value.continueCursor;
  }
}

async function loadState(path: string, target: string): Promise<GcState> {
  const raw = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  return raw === null ? emptyState(target) : parseState(raw, target);
}

async function saveState(path: string, state: GcState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * The whole run — listing, second inventory read, deletes — holds the run lock
 * (run-lock.ts), the same flock(2) lock every restore takes. Null when a restore
 * or another run holds it.
 */
async function withRunLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T | null> {
  const lock = await acquireRunLock(lockPath);
  if (lock === null) return null;
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * A restore in progress (or within a grace period of one) is marked by a file the
 * operator's restore runbook creates: while it exists the collector does nothing —
 * no listing, no state write, no deletion — and it is checked again right before
 * deleting. Returns the refusal, or null.
 */
export async function maintenanceRefusal(path: string | null): Promise<string | null> {
  if (path === null) return null;
  const info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  return info === null ? null : `maintenance lock ${path} is present (a restore is in progress or recent)`;
}

async function readAdminKey(file: string | undefined): Promise<string> {
  const path = file ?? process.env.CONVEX_ADMIN_KEY_FILE;
  const key = path !== undefined ? (await readFile(path, "utf8")).trim() : process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim();
  if (!key) throw new Error("no admin key: pass --admin-key-file (or CONVEX_ADMIN_KEY_FILE)");
  return key;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "convex-url": { type: "string" },
      "admin-key-file": { type: "string" },
      volume: { type: "string" },
      "s3-bucket": { type: "string" },
      "s3-prefix": { type: "string" },
      "instance-name": { type: "string" },
      state: { type: "string" },
      grace: { type: "string" },
      apply: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "max-missing-live": { type: "string" },
      "allow-empty-inventory": { type: "boolean", default: false },
      "maintenance-lock": { type: "string" },
      "run-lock": { type: "string" },
    },
    strict: true,
  });
  const convexUrl = values["convex-url"] ?? process.env.CONVEX_SELF_HOSTED_URL;
  if (!convexUrl) throw new Error("pass --convex-url (the backend's URL, e.g. http://convex-backend:3210)");
  if (!values.state) throw new Error("pass --state FILE (kept between runs; one per storage)");
  if ((values.volume === undefined) === (values["s3-bucket"] === undefined)) {
    throw new Error("pass exactly one of --volume DIR or --s3-bucket NAME");
  }
  const graceMs = values.grace !== undefined ? parseDuration(values.grace) : DEFAULT_GRACE_MS;
  if (graceMs < MIN_GRACE_MS) throw new Error("--grace must be at least 1h (and longer than a backup run)");
  const maxMissingLive = Number(values["max-missing-live"] ?? "0");
  if (!Number.isInteger(maxMissingLive) || maxMissingLive < 0) throw new Error("--max-missing-live: a count");
  const adminKey = await readAdminKey(values["admin-key-file"]);

  let store: ObjectStore;
  if (values.volume !== undefined) {
    store = new LocalFilesStore(values.volume);
  } else {
    const cfg = s3ConfigFromEnv(process.env, values["s3-bucket"]!);
    store = new S3FilesStore(
      new S3Client(cfg),
      cfg.bucket,
      cfg.endpoint ?? `aws:${cfg.region}`,
      values["s3-prefix"] ?? null,
      values["instance-name"] ?? null,
    );
  }
  const statePath = resolve(values.state);
  const mode = values.apply ? "apply" : "dry-run";
  const maintenanceLock = values["maintenance-lock"] ?? null;
  const runLock = resolve(values["run-lock"] ?? join(dirname(statePath), "atrium-gc.lock"));

  const outcome = await withRunLock(runLock, async () => {
    const blocked = await maintenanceRefusal(maintenanceLock);
    if (blocked !== null) {
      console.log(`REFUSED: ${blocked}`);
      return 2;
    }
    const state = await loadState(statePath, store.target);
    // Objects first, then the inventory: an object listed here whose blob is live
    // is in the inventory read afterwards.
    const listedAt = Date.now();
    const objects = await store.list();
    const liveBlobs = await fetchLiveBlobs(convexUrl, adminKey);
    const live = indexLive(liveBlobs);
    const failed = new Set<string>();
    for (const obj of objects) {
      if (!needsDigest(obj, live)) continue;
      const cached = state.digests[obj.key];
      if (cached !== undefined && cached.size === obj.size && cached.mtimeMs === obj.mtimeMs) continue;
      try {
        state.digests[obj.key] = { size: obj.size, mtimeMs: obj.mtimeMs, sha256: await store.digest(obj.key) };
      } catch (e) {
        failed.add(obj.key);
        console.error(`digest failed for ${obj.key}: ${(e as Error).message}`);
      }
    }
    const p = plan({
      objects,
      liveBlobs,
      digestOf: (key) => (failed.has(key) ? null : state.digests[key]?.sha256),
      state,
      listedAt,
      graceMs,
    });
    await saveState(statePath, p.nextState);

    const deleted = { count: 0, bytes: 0 };
    let refusal: string | null = null;
    if (values.apply) {
      refusal = applyRefusal(p, { maxMissingLive, allowEmptyInventory: values["allow-empty-inventory"] });
      // The second read (gc-core.recheck): immediately before deleting, so a
      // record a restore brought back since the first read keeps its bytes.
      let deletable: StoredObject[] = [];
      if (refusal === null && p.eligible.length > 0) {
        refusal = await maintenanceRefusal(maintenanceLock);
        if (refusal === null) {
          const again = recheck({
            first: liveBlobs,
            second: await fetchLiveBlobs(convexUrl, adminKey),
            eligible: p.eligible,
            digestOf: (key) => (failed.has(key) ? null : state.digests[key]?.sha256),
            listedAt,
          });
          refusal = again.refusal;
          deletable = again.deletable;
          if (again.kept.length > 0) console.log(`recheck kept ${again.kept.length} object(s) a live record now matches`);
        }
      }
      if (refusal === null) {
        for (const obj of deletable) {
          if (await store.delete(obj)) {
            deleted.count += 1;
            deleted.bytes += obj.size;
            delete p.nextState.orphanSince[obj.key];
            delete p.nextState.digests[obj.key];
          }
        }
        await saveState(statePath, p.nextState);
      }
    }

    if (values.json) {
      console.log(
        JSON.stringify({
          mode,
          objects: p.objects,
          objectBytes: p.objectBytes,
          live: p.live,
          matched: p.matched,
          orphans: p.orphans.length,
          eligible: p.eligible.length,
          deleted,
          missingLive: p.missingLive.map((b) => b.storageId),
          digestErrors: p.digestErrors,
          refusal,
          ...(values.list ? { eligibleKeys: p.eligible.map((o) => o.key) } : {}),
        }),
      );
    } else {
      if (values.list) for (const o of p.eligible) console.log(`eligible ${o.key} ${o.size}`);
      for (const b of p.missingLive.slice(0, 20)) console.log(`missing-live ${b.storageId} ${b.size}`);
      if (refusal !== null) console.log(`REFUSED: ${refusal}`);
      console.log(summaryLine(p, mode, deleted));
    }
    return refusal === null ? 0 : 2;
  });
  if (outcome === null) {
    console.log(`REFUSED: run lock ${runLock} is held (a restore or another collector run)`);
    return 2;
  }
  return outcome;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`atrium-blob-gc: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
