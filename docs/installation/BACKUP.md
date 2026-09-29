# Backing up Atrium — the facts a backup system needs

Atrium does not back itself up. Whatever does — a platform's restic exports,
Dokploy volume archives, provider snapshots, a script — needs a few facts
about what Atrium stores and how it writes. This page states them, with how
each was established. It prescribes no tool and no schedule. How long backups
are kept, and what deletion promise follows, is the backup platform's choice;
§3 gives the arithmetic.

Measurements quoted here come from the current `ghcr.io/get-convex/convex-backend`
image, on a throwaway deployment with a 200 MB database, under synthetic write
load. The source references point at
[get-convex/convex-backend](https://github.com/get-convex/convex-backend).

---

## 1. What Atrium stores, and where

### Self-hosted Convex (the Compose stack, a Dokploy stack, Helm)

Everything stateful sits in **one volume**, mounted at `/convex/data` in the Convex
backend container. Find its real name from the running container — each platform
prefixes names its own way:

```bash
docker inspect <backend container> \
  --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}'
```

| Path in the volume | Needed for a restore | Notes |
|---|---|---|
| `db.sqlite3` | **Yes** — as a consistent copy (§2) | The whole database: conversations, users, settings, gateway credentials (encrypted), the deployment's environment variables, file records |
| `db.sqlite3-journal` | No | Exists only while a write is in flight (rollback journal); a consistent copy never needs it |
| `storage/files/` | **Yes** | Uploaded and generated files |
| `storage/modules/` | **Yes** | Deployed function bundles the database refers to (redeploying from the matching release also restores them) |
| `storage/search/` | **Yes** | Search index snapshots the database refers to |
| `credentials/` | No | `instance_name`, `instance_secret`: the image rewrites them from `INSTANCE_NAME`/`INSTANCE_SECRET` at each start (Atrium's compose always sets both) |
| `storage/exports/` | **No — safe to exclude** | ZIPs of `npx convex export`: each is a whole copy of the data, files included. The backend deletes them 14 days after creation plus 30 more (`MAX_EXPIRED_SNAPSHOT_AGE_DAYS`), about 44 days. Keeping them in backups extends the life of purged data |
| `storage/snapshot_imports/` | **No — safe to exclude** | ZIPs uploaded by `npx convex import`, also whole copies. The backend never deletes them; remove them once an import is verified |
| `tmp/` | No | Scratch space, including the search engine's local cache (`tmp/.tmp*`) |

Checked on a running deployment: **`db.sqlite3` is the only SQLite file** in the
volume, and **Convex creates no symbolic links** there. An extra file at the
volume root is tolerated: a backup tool's witness file, such as a restore
qualification marker, does not disturb start-up or writes (tested).

**With object storage** (§5), the volume holds only `db.sqlite3`,
`credentials/` and `tmp/`. The same roles move to buckets (`CONVEX_S3_*_BUCKET`):

- `FILES`, `MODULES` and `SEARCH` are needed for a restore.
- `EXPORTS` and `SNAPSHOT_IMPORTS` are safe to exclude, for the reasons above.
- Every key starts with `<CONVEX_INSTANCE_NAME>-<id>/`. That prefix is also
  stored in the database, so a restore must keep the same instance name.

**Outside the volume:**

- the deployment's configuration: compose file and `.env`, or the platform's
  stack definition and secrets;
- `ATRIUM_SECRET_KEY` — without it, restored gateway credentials cannot be
  decrypted;
- `JWT_PRIVATE_KEY` and `JWKS` — without them every session is invalid;
- `CONVEX_INSTANCE_NAME` and `CONVEX_INSTANCE_SECRET` — the admin key derives
  from them;
- the bridge secrets (`BRIDGE_INSTANCE_SECRETS`, `BRIDGE_INGEST_SECRET`,
  `BRIDGE_SHARED_SECRET`).

### Convex Cloud deployments (the backend hosted by Convex, a bridge on your host)

- **The backend's data is Convex's to back up.** Convex offers dashboard backups
  (manual, or periodic daily/weekly on paid plans; kept 7 days, weekly 14) and
  the same ZIP through `npx convex export`
  ([`database/backup-restore.mdx`](https://github.com/get-convex/convex-backend/blob/main/npm-packages/docs/docs/database/backup-restore.mdx)).
  Environment variables, code and pending scheduled functions are not in those
  backups.
- **The bridge keeps no durable state of its own.** It fetches every gateway's
  URL, token and device identity from Convex at start. What exists on its host:

  | What | Back up |
  |---|---|
  | Its configuration: compose file or `.env` with `BRIDGE_INSTANCE_SECRETS`, `BRIDGE_INGEST_SECRET`, `BRIDGE_SHARED_SECRET` | **Yes** — the one thing to keep. A lost per-instance secret can be minted again in Settings → Agents → Instances; the ingest and shared secrets must match the Convex deployment's environment |
  | Shared-fs media mounts, when enabled: the gateway's `…/.openclaw/media/outbound` and the inbound root `…/.openclaw/media/inbound/{published,.staging}` | Only as part of the **gateway's** own backup. Delivered files end up in Convex; inbound copies are reaped after `OPENCLAW_INBOUND_TTL_MS` (default 6 h) |
  | Debug captures (`BRIDGE_FRAME_DUMP` files, watchdog logs), when turned on | No |

---

## 2. Consistency — what makes a copy of the database valid

The facts:

- **Rollback journal, one writer.** Convex writes `db.sqlite3` in
  `journal_mode=delete`. A file copied byte by byte while a write lands can be
  torn. A plain archive of the live volume is therefore not a valid copy of the
  database. The other paths are fine to read live (see "Files" below).
- **A 5-second budget.** The backend's SQLite binding waits at most 5 s for a
  lock (rusqlite 0.32 sets `sqlite3_busy_timeout(db, 5000)` on every
  connection). A reader that holds a read lock longer makes the backend's writes
  fail — and the backend **exits**. Measured: a read lock held for 12 s under
  writes produced
  `Commit … failed to write to persistence … Shutting down committer`, and the
  process stopped. A single-transaction copy (`VACUUM INTO`, `backup` with all
  pages in one step) is therefore safe only while it finishes in under 5 s; on
  200 MB, `VACUUM INTO` took 3–5 s and stalled writes by up to 3.1 s.
- **A stepped online backup is safe for the backend, but restarts on every
  write.** The SQLite backup API copied in small steps with a pause between them
  — for instance Python's `sqlite3.backup(pages=256)` with a 10 ms yield — takes
  each lock only briefly. Writes were never failed (latency ≤ 1.3 s). But
  SQLite restarts the copy whenever another process writes to the database, so
  it completes only in a **write-free window at least as long as the copy
  itself**. Measured on 200 MB:

  | Writes during the copy | Result |
  |---|---|
  | none | done in 3.5 s |
  | one every 10 s | done in 5.2 s |
  | one every 4 s | done in 15.7 s, after several restarts |
  | 1, 2, 4 or 8 per second, for 130 s | **never completed while writes continued**; done a few seconds after they stopped |

  It **fails safe**: every copy that completed passed `quick_check`. A copy
  interrupted before completion must be discarded, which is why it should be
  written to a disposable location. Its risk is not finishing, not corruption. The copy time grows with the database — about 3.5 s per 200 MB
  here, so roughly 17 s per GB — and the write-free window it needs grows with
  it. An idle Atrium still writes: its scheduled jobs run every 1 to 5 minutes,
  and at fixed times, in UTC (`convex/crons.ts`: 03:00 trace purge, 03:30 trash
  purge, :17 past every hour token pruning, hourly KPI rollup). Busy hours and large
  databases make a stepped backup slow or unbounded.
- **What makes a copy robust**, whatever the load:
  - **A bounded, read-locked raw copy.** Take a read lock, copy the file with a
    hard cap well under 5 s (e.g. `timeout 3 cp`), release it. With the
    rollback journal, the file cannot change while the lock is held, so the
    copy is exactly one committed state. Measured on 200 MB under writes: about
    1.5 s, writes stalled at most 1.6 s, no failed request, `integrity_check`
    ok; restored with every file served. When the cap is exceeded, it gives up
    with no copy and the backend is untouched. Its limit: the database must copy
    in under the cap.
  - **A clean stop.** Stop the backend, copy the volume, start it. The backend
    shuts down cleanly on **SIGINT** and ignores SIGTERM. Atrium's compose file
    sets `stop_signal: SIGINT` and `stop_grace_period: 60s`, and its Helm chart
    a `preStop` hook sending SIGINT. **A platform that deploys Convex with its
    own compose or stack file must set `stop_signal: SIGINT` itself.** Without
    it, every stop — `docker stop`, a Swarm scale to 0, a volume archive with the
    service turned off — waits out the grace period and SIGKILLs the backend.
    The copy stays crash-consistent (SQLite rolls the journal back at the next
    start; tested), but the shutdown is not clean. Costs downtime for the copy.
  - **A Convex export.** `npx convex export --include-file-storage` gives one
    consistent snapshot, portable to any deployment and storage kind. It carries
    every file on every run, is built inside the backend's own storage first
    (it needs that much free space again), and stays in `storage/exports` about
    44 days. A table-only export is smaller, but it carries no file records and
    cannot rebuild a lost deployment.
- **Files can be read live, after the database copy.** Each stored file is
  written once under a fresh random name, and synced to disk before the database
  records it (`LocalDirStorage`, `crates/storage/src/lib.rs`). The backend never
  rewrites it and never deletes it
  ([#93](https://github.com/get-convex/convex-backend/issues/93): deletes are
  soft). So a copy of `storage/files`, `modules` and `search` made **after** the
  database copy contains everything that copy refers to. A file still being
  written is not referenced yet. The same holds for bucket objects.

---

## 3. Retention — what a deletion promise depends on

"Purged data leaves the backups within `N` days" is a promise the **backup
platform** makes, through its retention. Atrium only determines how long purged
data lingers in the live storage first (`L`), and so what the platform can
promise:

| Data | Lingers in live storage after the purge (`L`) | Set by |
|---|---|---|
| Database rows | The document retention window: superseded and deleted versions are kept that long. **2 days** in Atrium's compose file and Helm chart (upstream's self-hosted value); **14 days** — the backend's default — wherever it is not set. The Ataraxis stack definition (`stacks/atrium-convex/compose.yml`) does not set it | `DOCUMENT_RETENTION_DELAY` on the backend container, in seconds (Compose: `CONVEX_DOCUMENT_RETENTION_DELAY`; Helm: `convexBackend.documentRetentionDelaySeconds`) |
| Files | Without the physical collector, **indefinitely**: the backend removes a file's record, never its bytes ([#93](https://github.com/get-convex/convex-backend/issues/93)). With it: Atrium first keeps a released file in a **7-day quarantine** (`Q`, then the record is deleted at the next daily run), and the collector removes the bytes after its grace `G` (§6) — so `L = Q + 1 day + G` | `BLOB_QUARANTINE_DAYS` (Atrium, default 7); the collector's `--grace` |
| Export and import ZIPs | About 44 days / until deleted | Excluding `storage/exports` and `storage/snapshot_imports` (or their buckets) takes them out of the equation |

For a promise of `N` days, every copy that can hold purged data — snapshots,
archives, replicas, bucket versions, object-lock retention — must be kept at most:

```
rows:   N − L              (L = 2 days with Atrium's defaults)
files:  N − (Q + 1 + G)    (with the physical collector; no bound without it)
```

For example, 30 days needs at most 28 days of snapshots for rows; for files,
with `Q` = 7 days and `G` = 1 day, at most 21 days. `N` counts from the moment
data is **purged** — a conversation first spends its trash retention (30 days by
default, `CHAT_TRASH_RETENTION_DAYS`) restorable before its purge. Calendar tiers (weekly,
monthly) count in full: a monthly snapshot kept for 6 months holds purged data
for 6 months.

**Two constraints on the clean-up's grace `G`:**

- `G` must be **longer than one backup run**, from the database copy to the end
  of the file copy. Otherwise a run can copy a database that still refers to a
  file, then miss the file because the clean-up deleted it in between.
- `G` should be short — at most a couple of days — or it eats into `N`.

**A residual caveat.** SQLite reuses freed pages without zeroing them: the
bundled SQLite is built without `SECURE_DELETE`. Fragments of purged rows can
stay inside `db.sqlite3` until their space is reused — in the live file and in
raw copies of it. Exports never carry them.

---

## 4. Restore, and qualifying a backup

**Every restore runs under the storage collector's run lock**
([§6](#6-reclaiming-the-space-of-deleted-files)). This applies to every kind of
restore below, a table import included:

1. `touch /var/lib/atrium-blob-gc/maintenance`
2. Run the restore itself as
   `flock /var/lib/atrium-blob-gc/atrium-gc.lock <restore command>`. `flock`
   waits for a collector run in progress to finish.
3. Delete the collector's state file.
4. Remove the maintenance file one full grace period later.

### Restore a self-hosted deployment from a volume backup

1. Deploy the stack with the **same** `CONVEX_INSTANCE_NAME`,
   `CONVEX_INSTANCE_SECRET`, `ATRIUM_SECRET_KEY`, `JWT_PRIVATE_KEY`/`JWKS`,
   bridge secrets and public origins. Do not start the backend yet.
2. Fill the volume the backend will mount:
   - `db.sqlite3` is the consistent copy;
   - `storage/files`, `storage/modules` and `storage/search` come from the same
     run.

   With object storage, put the objects back into the buckets under the **same
   keys**.
3. Start the backend. The log must read `storage is configured` with the
   expected kind (`Local { … }` or `S3 { s3_prefix: … }`), and show no
   `Database was initialized with …` error.
4. The deployment's environment variables and functions come back with the
   database. Redeploying the matching release's functions (`bootstrap-env.sh`)
   is harmless.

### Restore from an export

On a fresh deployment, with its environment set and functions deployed:

```bash
npx convex import --replace-all -y <export>.zip
```

Then delete the upload from `storage/snapshot_imports` or its bucket.

A **table-only** export restores with `--replace`, into a deployment that still
has its files. Never use `--replace-all` with one: it has no file records to
restore.

### Qualification checklist

Run it on a throwaway deployment, never the live volume or buckets:

- after setting a backup up;
- after changing storage or the backup method;
- on the platform's qualification schedule.

- [ ] The copy of `db.sqlite3` passes `PRAGMA integrity_check` (or `quick_check`).
- [ ] The backend starts on the restored volume with the expected storage kind
      and no `Database was initialized with` error.
- [ ] Sign-in works with an existing account.
- [ ] A conversation from before the backup shows its full history.
- [ ] A file attached before the backup opens intact (size or checksum).
- [ ] Search finds a message from before the backup.
- [ ] Settings → Agents → Instances lists the gateways with their credentials.
- [ ] A new message streams a reply through a gateway (bridge secrets and
      `ATRIUM_SECRET_KEY` survived).
- [ ] Record the restore's duration and the backup's age (recovery time and
      point).
- [ ] Destroy the test deployment, volume and buckets included.

---

## 5. Where the files live — an install-time choice

Convex keeps files, function bundles, search index snapshots, exports and imports
either **in the volume** (the default) or **in S3-compatible object storage**.
The database stays in the volume either way.

The choice is written into the database at the first start. A deployment created
on one kind refuses to start on the other (`Database was initialized with Local …,
but backend started up with S3`). Switching later is an export and an import
([MIGRATION.md](MIGRATION.md)).

**Pros of object storage:**

- the host's disk no longer grows with files;
- the provider replicates them;
- moving to another host or provider later is a bucket copy plus an endpoint
  change.

It is still not a backup of itself.

MinIO's community edition is archived —
[github.com/minio/minio](https://github.com/minio/minio) reads "THIS REPOSITORY
IS NO LONGER MAINTAINED" — and its images are no longer published.

**The variables** are upstream's
([`self-hosted/advanced/s3_storage.md`](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md),
[`self-hosted/docker-build/run_backend.sh`](https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker-build/run_backend.sh)).
They go on the backend container:

| Variable | Value |
|---|---|
| `AWS_REGION` | The provider's region (any non-empty value for a self-hosted server) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | A key limited to the five buckets |
| `S3_ENDPOINT_URL` | The provider's S3 endpoint (unset for AWS) |
| `AWS_S3_FORCE_PATH_STYLE` | `true` for most non-AWS endpoints |
| `AWS_S3_DISABLE_SSE`, `AWS_S3_DISABLE_CHECKSUMS` | `true` only if the provider rejects AWS's encryption headers or default checksums |
| `S3_STORAGE_FILES_BUCKET`, `S3_STORAGE_MODULES_BUCKET`, `S3_STORAGE_SEARCH_BUCKET`, `S3_STORAGE_EXPORTS_BUCKET`, `S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET` | Five distinct private buckets, created beforehand |

- **All six of the region and the five buckets, or none.** With only some, the
  backend logs a warning and quietly stays on local storage.
- **Compose:** the opt-in example `deploy/compose/docker-compose.s3.yml` maps
  them from `CONVEX_S3_*` variables and requires each one. Enable it with
  `COMPOSE_FILE=docker-compose.yml:docker-compose.s3.yml` in `.env`.
- **Helm:** `convexBackend.s3` (disabled by default).
- **Nothing changes in the browser.** Files are served through the Convex origin
  (`/api/storage/<id>`); the buckets stay private.
- **Confirm it at start.** The log shows
  `S3 { s3_prefix: "<instance>-<id>/" } storage is configured.`

<!-- BEGIN §6 storage garbage collection (deploy/gc). Kept as one appended block:
     edit it here, not interleaved with the sections above. -->

---

## 6. Reclaiming the space of deleted files

A file Atrium deletes loses its record at once: no URL is issued for it again.
Its **bytes stay** — on the volume or in the files bucket — because the
self-hosted backend's storage deletes are soft
([#93](https://github.com/get-convex/convex-backend/issues/93)). Two tools close
the gap, in this order.

### 1. Atrium: files nothing references any more (Settings → Trash)

Deleting a message or purging a conversation releases its files as it goes. A
released file is not deleted at once: it enters a **quarantine** (7 days,
`BLOB_QUARANTINE_DAYS`), and a daily job deletes its record only if nothing
references it again by then — a mistake in reference counting stays recoverable
for that week. Nothing leaves the quarantine until the one-time indexing of
message attachments (`blobQuarantine:backfillPartStorage`, started automatically
every 15 minutes until complete) has finished.
Files that were never released stay recorded forever: uploads picked in the
composer and never sent, sub-agent uploads, leftovers of older delete paths.
**Settings → Trash → Orphaned files** finds them:

- **Analyze (dry run)** walks every file record at least 7 days old and reports
  those no conversation, attachment, rendition or chart references. It deletes
  nothing.
- **Delete the orphans** applies a dry run of the last 24 hours. Each file is
  checked again, then put in the quarantine above — its record is deleted only
  when the quarantine ends and nothing references it. Admin only, audit-logged.
- The references for file attachments are read from the `files` table. A
  deployment whose data predates that table must fill it first:
  `npx convex run files:backfillFiles`. The dry run reports any attachment
  still missing its row, and the apply refuses to run while one is found.

This deletes **records**. The bytes are the next tool's job.

### 2. The operator: `atrium-blob-gc`, the physical collector

`deploy/gc/atrium-blob-gc.ts` compares the objects in storage with the live file
records and deletes the objects no record accounts for. Plain Node 24, no
dependency, so it runs from the stock `node:24-alpine` image.

**How it ties an object to a record.** Not by name: the backend stores each file
under a fresh random UUID (`LocalDirStorage` / `S3Storage`, `new_uuid_v4()`),
unrelated to the file's id or URL, and a function can read neither. A record does
carry the file's SHA-256 and size, so an object is **live** when its size and
digest are those of a live record. It hashes only the objects whose size matches
a live record, and caches the digests in its state file. Two identical files are
indistinguishable: while one is live, both are kept.

**What stops it from deleting anything:**

| Condition | Why |
|---|---|
| A live record older than the listing has no object in this storage | The wrong volume, bucket or prefix, or another deployment's URL. It also catches bytes already lost. Exit code 2, nothing deleted |
| An object could not be read | A digest it could not check is never taken for an orphan |
| The live list is empty while the storage is not | A wrong `--convex-url` (override: `--allow-empty-inventory`) |
| The bucket holds several key prefixes | A shared bucket: name this deployment's with `--s3-prefix` |
| The second read of the live list, taken just before deleting, differs from the first | A record reappeared or changed, which is what a restore looks like. Only objects that are orphans in **both** reads are ever deleted; if a record changed or reappeared, nothing is deleted |
| The maintenance lock file exists (`--maintenance-lock`) | A restore is in progress or recent. Nothing runs at all, and the lock is checked again just before deleting |

**One blind spot: Convex components.** The collector reads the app's own
`_storage` table only. Atrium uses no Convex component today. A component with
its own file storage would store its files in the same directory or bucket, and
list them in a `_storage` table of its own. The collector would see those files
as orphans, and the accounting check above cannot notice, because none of the
app's live files is missing. Before such a component is added, the collector must
read its inventory too.

**The grace `G`** (`--grace`, default `24h`, minimum `1h`). An object is deleted
only when it is older than `G` **and** a previous run already saw it orphaned
at least `G` earlier. The state file (`--state`) remembers when. `G` counts from
the moment the file's **record** is deleted. Atrium keeps a released file's
record for a 7-day logical quarantine before it deletes it. The quarantine
therefore comes **before** `G`: add it to `L` in §3. So:

- **The first run never deletes anything.**
- A backup that copied the database while a file was still live copies the
  files at most one backup run later. `G` longer than a backup run keeps every
  snapshot consistent (§3).
- With a daily run, a file whose record goes is deleted at the second or third
  run after it: `L ≤ 2 days` when `G` is under the interval (e.g. `--grace 20h`),
  `≤ 3 days` with the default. For a 30-day promise, that is the `G` of §3's
  formula.

**When to run it.** Once a day, **after the backup job finishes**. Always a dry
run first, and read its summary line:

```
atrium-blob-gc DRY-RUN: objects=… live=… matched=… orphans=… eligible=… waiting=… deleted=0 … missingLive=0 digestErrors=0
```

`missingLive` must be 0. Add `--list` to print the objects it would delete.
Then schedule the same command with `--apply`.

**Never during a restore: the run lock.** A restore can bring back records whose
bytes the collector has marked as orphans. So the collector and every restore
share one exclusive lock, `flock(2)` on
`/var/lib/atrium-blob-gc/atrium-gc.lock` (`/state/atrium-gc.lock` in the
container: `--run-lock`, by default next to `--state`).

- The collector holds the lock for its **whole** run: listing, both inventory
  reads, deletes. A restore cannot start in the middle of a run.
- If the lock is taken, by a restore or by another run, the collector does not
  start: exit code 2, nothing touched.
- The kernel drops the lock when its holder dies, even after `SIGKILL`. A crash
  never leaves a stale lock.
- The lock file must be on a local filesystem, reached through a bind mount by
  the collector and by the restore alike. `flock` does not work over NFS.

Restores include a volume restore, a bucket restore, and
`npx convex import --replace` or `--replace-all`. Each runs like this, in the
Dokploy or restic restore runbook:

```bash
touch /var/lib/atrium-blob-gc/maintenance
flock /var/lib/atrium-blob-gc/atrium-gc.lock \
  restic restore <snapshot> --target <restore dir>   # or the Dokploy restore, or npx convex import …
rm -f /var/lib/atrium-blob-gc/files.json             # the orphan dates predate the restore
# one full grace period later:
rm /var/lib/atrium-blob-gc/maintenance
```

- `flock` without `-n` **waits** for a collector run in progress to finish.
  Every step that writes the database, the volume or the bucket goes inside
  the one `flock` command. For several steps, use `flock <lock> sh -c '…'`.
- The maintenance file keeps the collector disabled for one grace period after
  the restore. Every scheduled run passes `--maintenance-lock
  /state/maintenance`, and exits with code 2 while the file exists.
- Deleting the state file makes the next run a first run, which never deletes.
  Read it like a dry run.
- The second inventory read, just before deleting, stays as a last check.

**The admin key** is read from a file, never from the command line, and never
printed. Mint it once and keep it with the other secrets:

```bash
docker exec <backend container> ./generate_admin_key.sh | tail -1 > /root/atrium-admin-key
chmod 600 /root/atrium-admin-key
```

**Volume storage (Compose, Dokploy).** The collector joins the backend's network
namespace, reads the volume, and deletes only under `storage/files`. It never
touches `modules`, `search`, `exports` or `snapshot_imports`:

```bash
docker run --rm --network container:<backend container> \
  -v <convex-data volume>:/data \
  -v /path/to/atrium/deploy/gc:/gc:ro \
  -v /var/lib/atrium-blob-gc:/state \
  -v /root/atrium-admin-key:/run/secrets/convex_admin_key:ro \
  node:24-alpine node /gc/atrium-blob-gc.ts \
    --convex-url http://127.0.0.1:3210 \
    --admin-key-file /run/secrets/convex_admin_key \
    --volume /data --state /state/files.json \
    --maintenance-lock /state/maintenance
    # add --apply once the dry run reads right
```

A dry run can mount the volume read-only (`/data:ro`).

**Object storage.** Point it at the **files** bucket only, with the backend's own
S3 variables: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`S3_ENDPOINT_URL`, `AWS_S3_FORCE_PATH_STYLE`. The key needs list, get and delete
on that bucket:

```bash
docker run --rm --network container:<backend container> \
  --env-file /root/atrium-gc-s3.env \
  -v /path/to/atrium/deploy/gc:/gc:ro \
  -v /var/lib/atrium-blob-gc:/state \
  -v /root/atrium-admin-key:/run/secrets/convex_admin_key:ro \
  node:24-alpine node /gc/atrium-blob-gc.ts \
    --convex-url http://127.0.0.1:3210 \
    --admin-key-file /run/secrets/convex_admin_key \
    --s3-bucket <CONVEX_S3_FILES_BUCKET> --instance-name <CONVEX_INSTANCE_NAME> \
    --state /state/files-s3.json --maintenance-lock /state/maintenance
```

With bucket versioning or object lock, a delete leaves a version behind. Their
retention counts toward §3's `N` like any other copy.

**Kubernetes.** The same command as a CronJob. It mounts the Convex PVC for
volume storage, which needs `ReadWriteMany` or a schedule on the backend pod's
node. It reaches the backend through its Service, and keeps `--state` on a
small PVC of its own.

**Exit codes:** `0` done, `2` refused (the reason is printed: run lock taken,
maintenance file, or an apply check), `1` error.

The run lock uses the `flock` command, present in `node:24-alpine` through
BusyBox. It falls back to Perl's `flock()` where the command does not exist.

**What was tested.** On throwaway `convex-backend` deployments, one on a volume
and one on an S3-compatible server:

- files were stored, then some deleted through `ctx.storage.delete`, and their
  bytes stayed;
- the dry runs reported exactly those, and the first run deleted nothing;
- the apply, once the grace had passed, removed exactly those objects;
- the live files were still served with the same digests, new uploads and a
  full export still worked, and a copy of the volume restored into a fresh
  backend served every live file;
- a bucket holding a second deployment's prefix, and a live list from the wrong
  deployment, were both refused with nothing deleted.

The second read, the maintenance file and the run lock are covered by the
collector's own tests (`deploy/gc`). They are not part of that live run.

The run lock was also run in `node:24-alpine`, with BusyBox `flock`:

- a restore's `flock -n` is refused while the collector holds the lock;
- a second collector run is refused;
- a collector run is refused while a restore holds the lock;
- the lock is free again after the collector is killed with `SIGKILL`.

<!-- END §6 storage garbage collection -->
