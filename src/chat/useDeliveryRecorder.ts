import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  buildFlushBatch,
  mergeMinT4,
  rowTimingSamples,
  skewFromPing,
  type ClientSample,
  type SseTimingSample,
  type StreamRow,
} from "./deliveryRecorder";

const FLUSH_INTERVAL_MS = 1000;
// Bound the held queue if calibration never resolves (Convex unreachable) during a
// long recording — keep the most recent samples, drop the oldest.
const MAX_QUEUED = 2000;
// Max samples per recordFrontendTiming call. MUST be <= the server's FRONTEND_BATCH_CAP
// (convex/deliveryTiming.ts) so the server never silently drops part of a batch; the
// flush removes only what it sends, so any overflow rides the next tick (Codex review).
const FLUSH_CHUNK = 500;

// Closes delivery segment C (Convex -> frontend) from the browser. Transport-AGNOSTIC: it
// samples BOTH legs and reports min(reactive receipt, SSE receipt) per delta — the FIRST
// appearance, i.e. the path the user actually saw first. That is reactive on short streams,
// SSE on long ones (where the reactive O(n²) full-text re-push lags and SSE wins the
// display), and it never loses a sample if one leg replays/fails (Codex/advisor). The SSE
// ref is empty when SSE is off, so reactive-only behaves exactly as before.
//
// One owner: calibrate/skew/pending/reported/queue all live here. INERT when not recording
// (no recTimingId -> nothing merged, no ping, no reports). The getStreamingText subscription
// is shared (Convex dedupes) with the chat runtime. See convex/deliveryTiming.ts.
export function useDeliveryRecorder(
  chatId: Id<"chats"> | string | null,
  sseSamplesRef: RefObject<SseTimingSample[]>,
): void {
  const rows = useQuery(
    api.messages.getStreamingText,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as StreamRow[] | undefined;
  const report = useMutation(api.deliveryTiming.recordFrontendTiming);
  const calibrate = useMutation(api.deliveryTiming.calibrateClock);

  // recTimingId -> earliest t4 across both legs, for ids not yet reported. Reconciled +
  // drained to `queue` on each flush; `reported` dedups across flushes.
  const pending = useRef(new Map<string, number>());
  const reported = useRef(new Set<string>());
  const queue = useRef<ClientSample[]>([]);
  const skew = useRef<number | undefined>(undefined);
  const calibrating = useRef(false);

  // One-time clock-skew calibration ping, fired on the first observed sample.
  const triggerCalibrate = useCallback(() => {
    if (skew.current !== undefined || calibrating.current) return;
    calibrating.current = true;
    const sentAt = Date.now();
    void calibrate({ clientSentAt: sentAt })
      .then((res) => {
        skew.current = skewFromPing(sentAt, res.serverNow, Date.now());
      })
      .catch(() => {
        calibrating.current = false; // allow a retry on the next sample
      });
  }, [calibrate]);

  // REACTIVE leg: merge each row's recTimingId at the row's receipt (Date.now() ~= push
  // arrival). Also the reliable "recording ended" reset — the rows carry recTimingId only
  // during a recording, regardless of the display transport, so their absence resets the
  // dedup state (recTimingIds are unique, so a cleared set never re-reports).
  useEffect(() => {
    if (!rows) return;
    mergeMinT4(pending.current, rowTimingSamples(rows, Date.now()), reported.current);
    if (pending.current.size > 0) triggerCalibrate();
    // Recording ended (no row carries recTimingId): reset ONLY the dedup set for the next
    // recording. Do NOT clear `pending` — those un-flushed samples (a short stream that
    // ended before the next 1s flush, or the last deltas) are still reported by the interval
    // flush + the final drain. Clearing them here would lose those segment-C measurements
    // (Codex review).
    if (
      reported.current.size > 0 &&
      !rows.some((r) => r.recTimingId !== undefined)
    ) {
      reported.current.clear();
    }
  }, [rows, triggerCalibrate]);

  // SSE-leg drain + reconcile + batch-flush (~1/s). Drains SSE samples (t4 stamped at the
  // chunk's arrival) into the SAME pending map BEFORE moving the reconciled minima to the
  // report queue, so each delta's reported t4 is min(reactive, SSE) — comparing stamped t4,
  // not arrival order. `reported` dedups across flushes (a later, larger-t4 straggler is
  // correctly dropped). buildFlushBatch holds the queue until the clock is calibrated.
  useEffect(() => {
    const reconcileAndFlush = () => {
      mergeMinT4(pending.current, sseSamplesRef.current ?? [], reported.current);
      if (sseSamplesRef.current) sseSamplesRef.current.length = 0;
      if (pending.current.size > 0) triggerCalibrate();
      for (const [timingId, t4] of pending.current) {
        queue.current.push({ timingId, t4, clientSkew: skew.current });
        reported.current.add(timingId);
      }
      pending.current.clear();
      if (queue.current.length > MAX_QUEUED) {
        queue.current.splice(0, queue.current.length - MAX_QUEUED);
      }
      const batch = buildFlushBatch(queue.current, skew.current, FLUSH_CHUNK);
      if (batch === null) return;
      queue.current.splice(0, batch.length);
      void report({ samples: batch }).catch(() => {
        // Best-effort instrumentation: a failed report just drops those samples.
      });
    };
    const id = window.setInterval(reconcileAndFlush, FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      // Final drain on unmount / chat switch: reconcile remaining, then empty the queue in
      // chunks (each call stops when empty or the clock never calibrated).
      reconcileAndFlush();
      while (buildFlushBatch(queue.current, skew.current, FLUSH_CHUNK) !== null) {
        reconcileAndFlush();
      }
    };
  }, [report, sseSamplesRef, triggerCalibrate]);
}
