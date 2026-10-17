// `artifacts.download`, as the copier needs it (transcript redesign, final design §3.5,
// step 2 — projection `on` only).
//
// The Control UI resolves a managed transcript file by asking the gateway for a download
// grant (ui/src/api/artifact-download.ts:57 at v2026.9.33): `artifacts.download
// {sessionKey, artifactId}` answers the canonical URL followed by a short-lived ticket
// (`?mediaTicket=v1.…`, 5 minutes — src/gateway/managed-image-attachments.ts:110,
// `resolveManagedOutgoingMediaArtifactDownloadForRecord` :1026), and the bytes are read
// from that URL WITHOUT any other credential (`handleManagedOutgoingMediaHttpRequest`
// :1568-1576: a valid ticket skips request authentication). That path does not depend on
// the gateway's auth mode, which is why Atrium takes it and never the owner Bearer
// (owner access only, :1586-1608 — absent in trusted-proxy).
//
// This module only speaks the RPC and reads its answer; the bytes and the bookkeeping
// belong to core/artifact-copier.ts.

import { GatewayAnsweredError } from "./openclaw-client.js";

/** What `artifacts.download` answered, as the copier reads it. */
export type ArtifactDownloadAnswer =
  | {
      ok: true;
      /** The download URL (`url` mode): the canonical route + its ticket. */
      url?: string;
      /** Inline bytes (`bytes` mode, `encoding:"base64"`). */
      data?: string;
      mimeType?: string;
      sizeBytes?: number;
      title?: string;
    }
  | {
      ok: false;
      /** `artifact_not_found`: the gateway no longer holds this artifact for this
       *  session (`respondArtifactNotFound`, src/gateway/server-methods/artifacts.ts:194 —
       *  after `sessions.reset` in the bench probe, a reset kills the managed copy within
       *  seconds). `artifact_download_unsupported`: it will never be downloadable (:451).
       *  `transient`: anything else — no answer, or a refusal that states neither. */
      reason: "artifact_not_found" | "artifact_download_unsupported" | "transient";
    };

export interface ArtifactRequester {
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

const asRecord = (x: unknown): Record<string, unknown> | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

/** Read an `artifacts.download` answer payload (artifacts.ts:299-314 managed shape,
 *  :506-517 generic shape). */
export function readArtifactDownload(payload: unknown): ArtifactDownloadAnswer {
  const p = asRecord(payload);
  const artifact = asRecord(p?.artifact);
  const url = typeof p?.url === "string" && p.url !== "" ? p.url : undefined;
  const data = p?.encoding === "base64" && typeof p.data === "string" ? p.data : undefined;
  if (url === undefined && data === undefined) return { ok: false, reason: "transient" };
  return {
    ok: true,
    ...(url !== undefined ? { url } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(typeof artifact?.mimeType === "string" ? { mimeType: artifact.mimeType } : {}),
    ...(typeof artifact?.sizeBytes === "number" && Number.isFinite(artifact.sizeBytes)
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
    ...(typeof artifact?.title === "string" ? { title: artifact.title } : {}),
  };
}

/** The refusal's structured type (`artifactError(type, …)` puts it in `details.type`,
 *  artifacts.ts:83-90). Only the two the gateway names decide anything. */
export function classifyArtifactDownloadError(err: unknown): ArtifactDownloadAnswer {
  if (err instanceof GatewayAnsweredError) {
    const type = asRecord(err.details)?.type;
    if (type === "artifact_not_found") return { ok: false, reason: "artifact_not_found" };
    if (type === "artifact_download_unsupported") return { ok: false, reason: "artifact_download_unsupported" };
  }
  return { ok: false, reason: "transient" };
}

/** One `artifacts.download {sessionKey, artifactId}` — the Control UI's own request, with
 *  its own 30 s bound (ui/src/api/artifact-download.ts:55-60; a managed id never asks for
 *  `transport:"http"`, :41-44). */
export async function requestArtifactDownload(
  conn: ArtifactRequester,
  sessionKey: string,
  artifactId: string,
  timeoutMs = 30_000,
): Promise<ArtifactDownloadAnswer> {
  try {
    const raw = await conn.request("artifacts.download", { sessionKey, artifactId }, timeoutMs);
    return readArtifactDownload(asRecord(raw)?.payload);
  } catch (err) {
    return classifyArtifactDownloadError(err);
  }
}
