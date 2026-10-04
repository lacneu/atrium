// VENDORED VERBATIM from openclaw/openclaw @ v2026.9.8 — packages/gateway-protocol/src/worker-capacity.ts.
// Source of truth for the wire protocol; used ONLY by the protocol-coverage
// ratchet test (never imported by runtime bridge code). Do not edit by hand:
// re-run scripts/vendor-protocol.mjs — vendor-integrity.test.ts checks the sha256.
// (Only changes vs upstream: @openclaw/<pkg>/<module> workspace specifiers collapsed to ./<module>.js; ../ imports rebased to ./ for the flat layout.)
import { isRecord } from "./record-coerce.js";
import type { WorkerSlotSummary } from "./environments.js";

export const NODE_WORKER_CAPACITY_MAX = 1_024;

export function availableWorkerSlots(capacity: WorkerSlotSummary): number {
  return capacity.available + (capacity.reclaimableIdle ?? 0);
}

export function parseWorkerCapacity(value: unknown): WorkerSlotSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const { total, available, reclaimableIdle } = value;
  return keys.every((key) => key === "total" || key === "available" || key === "reclaimableIdle") &&
    keys.includes("total") &&
    keys.includes("available") &&
    typeof total === "number" &&
    typeof available === "number" &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(available) &&
    total >= 1 &&
    total <= NODE_WORKER_CAPACITY_MAX &&
    available >= 0 &&
    available <= total &&
    (reclaimableIdle === undefined ||
      (typeof reclaimableIdle === "number" &&
        Number.isSafeInteger(reclaimableIdle) &&
        reclaimableIdle >= 0 &&
        reclaimableIdle <= Math.min(2, total - available)))
    ? { total, available, ...(reclaimableIdle === undefined ? {} : { reclaimableIdle }) }
    : null;
}
