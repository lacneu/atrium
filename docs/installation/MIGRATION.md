# Moving a deployment to another host and onto object storage

This procedure moves a running deployment to a new Linux host with a self-hosted
Convex backend, whose files live in S3-compatible object storage. The deployment
moved can have either kind of backend:

- a **Convex Cloud** backend, with the front end and bridge on your own host;
- a **self-hosted** backend, with its files in the `convex-data` volume (the
  default).

It also covers a move that keeps the files in the volume: skip the
object-storage parts.

The only supported way to change where Convex keeps its files is an **export
with file storage and an import into a new deployment** — upstream's own
procedure
([`self-hosted/advanced/s3_storage.md`](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md),
*Migrating storage providers*). Pointing the existing database at a bucket does
not work: the storage kind is recorded in the database at its first start, and a
mismatch stops the backend
(`Database was initialized with Local …, but backend started up with S3`).

What the export and import carry, and what they do not:

| Carried | Not carried |
|---|---|
| Every table, with its document IDs and creation times | The deployment's environment variables — `bootstrap-env.sh` sets them from `.env` |
| Every file that still has a record, with its ID, content type and checksum; the import verifies each checksum | The deployed functions — `bootstrap-env.sh` deploys them |
| Users, sessions and the gateway credentials (still encrypted) | **Pending scheduled functions** (work queued with a delay) |
| | Files whose record was deleted: their bytes were never removed from the old storage, and the move leaves them behind |

The upstream references for these facts are
[`database/import-export/import.mdx`](https://github.com/get-convex/convex-backend/blob/main/npm-packages/docs/docs/database/import-export/import.mdx)
and
[`database/backup-restore.mdx`](https://github.com/get-convex/convex-backend/blob/main/npm-packages/docs/docs/database/backup-restore.mdx).

The examples call the old host **old-host** and the new one **new-host**.

---

## Before you start

- **Keep the public origins when you can.** From a self-hosted backend, move
  `CONVEX_CLOUD_ORIGIN`, `CONVEX_SITE_ORIGIN` and the front end's URL to the new
  host by DNS or reverse proxy rather than changing them. OAuth redirect URIs,
  signed sessions and file links then stay valid, and nobody has to sign in
  again. From **Convex Cloud** the Convex origins necessarily change (they were
  `*.convex.cloud` / `*.convex.site`), so:
  - register the new site origin's OAuth callback with each provider;
  - point the front end at the new cloud origin;
  - expect every user to sign in once.
- **Carry the secrets over unchanged**:
  - `ATRIUM_SECRET_KEY`, otherwise every stored gateway credential is
    undecipherable;
  - `JWT_PRIVATE_KEY` and `JWKS`, otherwise every session is invalid;
  - `BRIDGE_INGEST_SECRET`, `BRIDGE_SHARED_SECRET` and `BRIDGE_INSTANCE_SECRETS`.

  With a Convex Cloud backend, the first two groups live in its deployment
  environment: read them with `npx convex env list --prod` from a checkout
  linked to the Cloud project, and put them in new-host's `.env`. The new
  deployment may keep `CONVEX_INSTANCE_NAME` and `CONVEX_INSTANCE_SECRET` or get
  new ones.
- **Room for the export on a self-hosted old-host.** The backend writes the whole export,
  files included, inside its own volume before the CLI downloads it: plan free
  space equal to the files' total size. The ZIP then stays in that volume for
  about 44 days (it expires after 14 days and is removed 30 days later).
- **The gateways must be reachable from new-host.** If a bridge used shared-fs
  media with a gateway on old-host, that mount does not cross hosts: switch that
  instance to gateway-http mode, or move the gateway too.
- **Rehearse once, on throwaway storage.** Run Steps 1 to 5 with an export taken
  while the old stack keeps running, into a deployment with its own volume and
  its own buckets, then delete that volume and those buckets. Do not rehearse
  into the buckets you will keep: a later `--replace-all` drops the rehearsal's
  file records but not their bytes, which would stay in the buckets for good.
  The rehearsal tells you how long the export, the transfer and the import
  take — that is your maintenance window.

---

## Step 1 — Prepare new-host

On new-host, follow [COMPOSE.md](COMPOSE.md) Steps 0 to 3 with the `.env` of
old-host as the starting point, then turn object storage on as described in
[BACKUP.md § 5](BACKUP.md#5-where-the-files-live--an-install-time-choice):
`COMPOSE_FILE`, the `CONVEX_S3_*` variables, five empty buckets.

Bring up the backend alone, then set its environment and deploy the functions:

```bash
cd deploy/compose
docker compose up -d convex-backend
docker logs <project>-convex-backend 2>&1 | grep 'storage is configured'
./bootstrap-env.sh
```

**Expected:** the log line reads `S3 { s3_prefix: "…" } storage is configured.`
(not `Local`), and `bootstrap-env.sh` ends with the functions deployed. The
schema must be deployed before the import: the import is validated against it.

Leave the front end and the bridge stopped on new-host until Step 6.

Under Dokploy, the same compose file and variables go into a Dokploy compose
application; run the CLI steps (`bootstrap-env.sh`, `npx convex …`) from an
Atrium checkout on the host, pointed at the backend's published port.

---

## Step 2 — Freeze old-host

Pick a quiet moment: turns in progress are cut, and work scheduled for later is
not carried over. Stop what writes, keep the backend running:

```bash
docker compose stop frontend bridge
```

With a Convex Cloud backend, stop them on the host where they run; the
Cloud backend stays up. Users now see the site unavailable; the data stops
changing. Scheduled Convex
jobs still run, and anything they write after Step 3 stays behind.

---

## Step 3 — Export from old-host, files included

**From a Convex Cloud backend**, run this from a checkout linked to the Cloud
project, or set that deployment's deploy key in `CONVEX_DEPLOY_KEY`:

```bash
npx convex export --prod --include-file-storage --path atrium-migration.zip
sha256sum atrium-migration.zip
```

**From a self-hosted backend**, the export needs an admin key minted by
old-host's backend and the Convex CLI reaching its cloud port. From any machine
with an Atrium checkout and Node that can reach old-host over SSH:

```bash
ssh -L 3210:127.0.0.1:3210 admin@old-host        # keep open in another terminal
ADMIN_KEY="$(ssh admin@old-host docker exec <project>-convex-backend ./generate_admin_key.sh | tail -n1)"
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
  npx convex export --include-file-storage --path atrium-migration.zip
sha256sum atrium-migration.zip
```

Use the container name that `docker ps` shows on old-host. On a Synology NAS,
Container Manager may name the project differently from the directory; the
container name is what counts.

**Check the export before going further** — it must list every table and a
`_storage` folder with the files:

```bash
unzip -l atrium-migration.zip | tail -n1
unzip -Z1 atrium-migration.zip | grep -c '^_storage/'
```

---

## Step 4 — Import on new-host

Copy the ZIP to new-host and compare checksums (`sha256sum` on both ends). Then,
from the checkout on new-host, with the admin key of **new-host's** backend:

```bash
ADMIN_KEY="$(docker exec <project>-convex-backend ./generate_admin_key.sh | tail -n1)"
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
  npx convex import --replace-all -y atrium-migration.zip
```

**Expected:** `Imported "_storage" (<n> files)` followed by the document count.
`--replace-all` replaces every table, so anything the rehearsal or the empty
deployment wrote is gone.

**Compare table by table.** Export the new deployment's tables and compare the
document counts with the migration ZIP:

```bash
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
  npx convex export --include-file-storage --path after-import.zip
count() { unzip -Z1 "$1" | grep '/documents.jsonl$' | while read -r f; do
  printf '%s %s\n' "${f%/documents.jsonl}" "$(unzip -p "$1" "$f" | grep -c .)"; done | sort; }
diff <(count atrium-migration.zip) <(count after-import.zip) && echo "counts match"
```

`_tables` may differ by the tables the empty deployment had created; every
application table and `_storage` must match.

**Then remove the two leftover copies of the whole dataset**: the import upload
in the snapshot-imports bucket, which the backend never deletes, and the
verification export (it expires with the other exports). Empty the
snapshot-imports bucket with your provider's console or any S3 client, e.g.:

```bash
rclone delete <remote>:<prefix>-snapshot-imports   # or: aws s3 rm --recursive s3://<prefix>-snapshot-imports
rm after-import.zip
```

---

## Step 5 — Verify on new-host, before anyone uses it

Start the rest of the stack on new-host, reachable only by you (a hosts-file
entry or a temporary proxy route to the same public names):

```bash
docker compose up -d
```

Then walk the [restore test checklist](BACKUP.md#qualification-checklist): sign-in
with an existing account, an old conversation, an old attachment opening intact,
search, a new turn streaming through a gateway, the instances' credentials.

---

## Step 6 — Cut over

1. Point the public names (front end, Convex cloud origin, Convex site origin)
   at new-host.
2. Watch a few real turns (`docker compose logs -f bridge`).
3. Declare the new deployment to your backup system with the facts in
   [BACKUP.md](BACKUP.md): the volume and buckets, a consistent database copy,
   the exclusions, the retention. Run one backup by hand and qualify it. Do not
   leave the new deployment a night without a backup.

---

## Rolling back

- **Before the cutover:** nothing changed on old-host. Start what you stopped
  (`docker compose start frontend bridge`) and discard new-host.
- **After the cutover, nothing written since:** point the names back at old-host
  and start its front end and bridge.
- **After the cutover, with new data:** the reverse move. Freeze new-host,
  export it with file storage, and import it with `--replace-all` into old-host
  (add `--prod` for a Convex Cloud backend; the storage kind does not matter to
  an import). Point the names back. Anything not exported is lost, so decide
  quickly: every hour of use makes rolling back more expensive.

Keep old-host's stack stopped but intact until the rollback window you choose
has passed — a week of normal use is a reasonable bar.

---

## Retiring old-host

**A Convex Cloud backend** keeps everything the deployment stored, including the
bytes of deleted files, plus the backups Convex took of it (up to 14 days).
Delete the Cloud deployment once the rollback window is over. The bridge host
keeps only its configuration (BACKUP.md §1).

**A self-hosted old-host's** volume holds everything the deployment ever stored, including the
bytes of every file deleted in Atrium (the backend never removed them) and the
migration export. It is personal data with no retention of its own: remove it
once the rollback window is over, together with any backups of it.

Remove the **right** volume. List what the backend container actually mounts:

```bash
docker inspect <project>-convex-backend \
  --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}'
```

and delete that volume by name after removing the containers. On a Synology NAS,
`docker compose down -v` run from a shell can target a different project than
the one Container Manager created — delete by the name above, not by project.
