import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  buildFlushBatch,
  collectNewSamples,
  skewFromPing,
  type ClientSample,
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

// Closes delivery segment C (Convex -> frontend) from the browser. While a recording
// is active, getStreamingText carries each delta's `recTimingId`; on first sight of a
// new id we stamp t4 (browser clock) and batch-report it (recordFrontendTiming). One
// clientSkew calibration ping fires the first time we see a recorded delta.
//
// INERT when not recording: no recTimingId -> nothing queued, no ping, no reports.
// The getStreamingText subscription is shared (Convex dedupes) with the chat runtime,
// so this adds no extra server read. See convex/deliveryTiming.ts.
export function useDeliveryRecorder(chatId: Id<"chats"> | string | null): void {
  const rows = useQuery(
    api.messages.getStreamingText,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  ) as StreamRow[] | undefined;
  const report = useMutation(api.deliveryTiming.recordFrontendTiming);
  const calibrate = useMutation(api.deliveryTiming.calibrateClock);

  const seen = useRef(new Set<string>());
  const queue = useRef<ClientSample[]>([]);
  const skew = useRef<number | undefined>(undefined);
  const calibrating = useRef(false);

  // Stamp t4 on first sight of each new recTimingId, and kick a one-time skew ping.
  useEffect(() => {
    if (!rows) return;
    const fresh = collectNewSamples(rows, seen.current, Date.now(), skew.current);
    for (const s of fresh) {
      seen.current.add(s.timingId);
      queue.current.push(s);
    }
    if (queue.current.length > MAX_QUEUED) {
      queue.current.splice(0, queue.current.length - MAX_QUEUED);
    }
    // Recording ended for the observed stream(s) (no row carries a recTimingId) -> reset
    // the dedup set so it can't grow across recording sessions. Never mid-recording (a
    // recording row -> fresh was just collected above, so this is skipped). recTimingIds
    // are unique, so a cleared set never causes a real re-report; `skew` is kept (a stable
    // client offset, valid for any still-queued samples).
    if (seen.current.size > 0 && !rows.some((r) => r.recTimingId !== undefined)) {
      seen.current.clear();
    }
    if (fresh.length > 0 && skew.current === undefined && !calibrating.current) {
      calibrating.current = true;
      const sentAt = Date.now();
      void calibrate({ clientSentAt: sentAt })
        .then((res) => {
          skew.current = skewFromPing(sentAt, res.serverNow, Date.now());
        })
        .catch(() => {
          calibrating.current = false; // allow a retry on the next fresh delta
        });
    }
  }, [rows, calibrate]);

  // Batch-flush the queued t4 samples (~1/s), back-filling skew that arrived late.
  useEffect(() => {
    const flush = () => {
      // HOLD until the clock is calibrated: never persist a C sample computed across
      // two clocks (it can't be corrected later). null = empty or still waiting.
      const batch = buildFlushBatch(queue.current, skew.current, FLUSH_CHUNK);
      if (batch === null) return;
      // Remove ONLY what we send; a backlog larger than one chunk rides later ticks
      // rather than being clipped by the server cap and lost.
      queue.current.splice(0, batch.length);
      void report({ samples: batch }).catch(() => {
        // Best-effort instrumentation: a failed report just drops those samples.
      });
    };
    const id = window.setInterval(flush, FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      // Final drain on unmount / chat switch: empty the whole queue in chunks (each
      // call stops when the queue is empty or the clock never calibrated).
      while (buildFlushBatch(queue.current, skew.current, FLUSH_CHUNK) !== null) {
        flush();
      }
    };
  }, [report]);
}
