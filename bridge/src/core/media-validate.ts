// Shared-fs path validation (the "Valider" button). The bridge can only check
// ITS OWN access to the shared volume (write the inbound dir it writes to, read the
// outbound dir it reads from) — there is no gateway filesystem API to confirm the
// AGENT-side container mount, so the result is explicitly bridge-side. It still
// catches the most common shared-fs misconfig: the volume not mounted / wrong
// permissions on the bridge side.

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export interface DirCheck {
  /** Was this leg checked (its mode is shared-fs)? */
  checked: boolean;
  /** Did the access succeed? */
  ok: boolean;
  /** Non-secret detail: the dir, or the error message. */
  detail: string;
}

/** Round-trip a marker (mkdir → write → read-back → delete) to prove the bridge
 *  can WRITE the dir (its inbound write path). */
export async function checkWritableDir(
  dir: string,
  now: number,
): Promise<DirCheck> {
  const marker = join(dir, `.atrium_validate_${now}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(marker, "ok");
    const back = await readFile(marker, "utf8");
    if (back !== "ok") {
      return { checked: true, ok: false, detail: "read-back mismatch" };
    }
    return { checked: true, ok: true, detail: dir };
  } catch (e) {
    return { checked: true, ok: false, detail: (e as Error)?.message ?? "error" };
  } finally {
    await rm(marker, { force: true }).catch(() => {});
  }
}

/** Confirm the bridge can READ the dir (its outbound read path). */
export async function checkReadableDir(dir: string): Promise<DirCheck> {
  try {
    await access(dir, constants.R_OK);
    return { checked: true, ok: true, detail: dir };
  } catch (e) {
    return { checked: true, ok: false, detail: (e as Error)?.message ?? "error" };
  }
}

const SKIPPED: DirCheck = { checked: false, ok: true, detail: "not shared-fs" };

/**
 * Validate the bridge-side shared-fs access for the legs that are in shared-fs
 * mode. `inbound` is the bridge's inbound WRITE dir; `outbound` its outbound READ
 * dir. Each leg is skipped (checked:false) when its mode is not shared-fs.
 */
export async function validateSharedFs(opts: {
  inboundDir: string;
  outboundDir: string;
  inboundSharedFs: boolean;
  outboundSharedFs: boolean;
  now: number;
}): Promise<{ inbound: DirCheck; outbound: DirCheck }> {
  return {
    inbound: opts.inboundSharedFs
      ? await checkWritableDir(opts.inboundDir, opts.now)
      : SKIPPED,
    outbound: opts.outboundSharedFs
      ? await checkReadableDir(opts.outboundDir)
      : SKIPPED,
  };
}
