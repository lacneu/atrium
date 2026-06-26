// Pure helpers for the client side of the delivery-latency recorder (segment C).
// Kept free of React/Convex so the dedup + skew math is unit-testable; the side
// effects (subscription, mutations, refs) live in useDeliveryRecorder.ts. See
// convex/deliveryTiming.ts for the end-to-end contract.

// A streamingText row as returned by getStreamingText. `recTimingId` (the timing
// row's id = the end-to-end correlator) is present ONLY while a recording is active.
export type StreamRow = {
  messageId: string;
  text: string;
  recTimingId?: string;
  recCommittedAt?: number;
};

// One frontend timing sample: t4 (browser clock) for a delta's timing row.
export type ClientSample = {
  timingId: string;
  t4: number;
  clientSkew?: number;
};

// Report shapes (mirror convex/deliveryTiming.ts getDeliveryReport / listDeliverySessions).
export type SegStat = {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};
export type DeliveryReport = {
  sessionId: string | null;
  count: number;
  // True when the session had more rows than the report window cap, so the stats
  // cover only the first slice — surfaced so a capped report isn't read as complete.
  truncated: boolean;
  // `bridge` = bridge-internal (receipt -> send, single clock). There is NO B (Convex
  // exec): it's structurally unmeasurable in-app (frozen mutation clock) and comes from
  // Convex's own telemetry. A = bridge->Convex, C = Convex->frontend (both skew-corrected).
  segments: { bridge: SegStat; A: SegStat; C: SegStat } | null;
};
export type SessionSummary = {
  sessionId: string;
  startedAt: number;
  stoppedAt: number | null;
  startedBy: string;
  active: boolean;
};

// Render a report as a compact, shareable plain-text block (for the Copy button).
// Neutral technical labels — it's data to paste into a bug report, not UI chrome.
export function reportToText(report: DeliveryReport): string {
  const ms = (n: number | null): string => (n === null ? "—" : String(Math.round(n)));
  const head = `delivery latency — session ${report.sessionId ?? "?"} (${report.count}${report.truncated ? "+" : ""} deltas)`;
  if (report.segments === null) return `${head}\n(no samples)`;
  const seg = report.segments;
  const line = (label: string, s: SegStat): string =>
    `${label}: p50=${ms(s.p50)} p95=${ms(s.p95)} max=${ms(s.max)} ms (n=${s.count})`;
  const lines = [
    head,
    line("bridge internal", seg.bridge),
    line("A bridge->Convex", seg.A),
    line("C Convex->frontend", seg.C),
    "B Convex exec: from Convex telemetry (not measurable in-app)",
  ];
  if (report.truncated) {
    lines.push(
      `(report capped at ${report.count} rows — later deltas not included)`,
    );
  }
  return lines.join("\n");
}

// Clock offset estimate `serverClock - clientClock` (the calibrateClock convention)
// from a single client-clock round-trip, assuming symmetric latency (NTP-style):
//   skew = serverNow - (clientSentAt + RTT/2)
export function skewFromPing(
  clientSentAt: number,
  serverNow: number,
  clientRecvAt: number,
): number {
  const rtt = clientRecvAt - clientSentAt;
  return serverNow - (clientSentAt + rtt / 2);
}

// Decide what to flush: HOLD everything until the clock is calibrated, so segment C
// is never persisted across two clocks (Codex review — uncorrected samples can't be
// fixed later because recordFrontendTiming ignores rows whose t4 is already set).
// Returns at most `limit` skew-applied samples (the head of the queue), or null to
// keep waiting (empty queue, or no skew yet — the caller drops the held queue on
// unmount rather than sending it wrong). `limit` MUST be <= the server's per-call cap
// (FRONTEND_BATCH_CAP) so the server never silently drops part of the batch; the
// caller removes only `batch.length` from the queue, so any overflow rides the next
// flush instead of being lost.
export function buildFlushBatch(
  queue: readonly ClientSample[],
  skew: number | undefined,
  limit: number,
): ClientSample[] | null {
  if (queue.length === 0 || skew === undefined) return null;
  return queue
    .slice(0, limit)
    .map((s) => ({ ...s, clientSkew: s.clientSkew ?? skew }));
}

// Stamp t4 = `now` for each row whose recTimingId hasn't been seen yet. Pure: the
// caller owns `seen` (mutates it after queuing). One sample per DISTINCT recTimingId
// observed -> maximizes segment-C coverage given Convex coalesces intermediate states.
export function collectNewSamples(
  rows: readonly StreamRow[],
  seen: ReadonlySet<string>,
  now: number,
  skew: number | undefined,
): ClientSample[] {
  const out: ClientSample[] = [];
  for (const r of rows) {
    if (r.recTimingId !== undefined && !seen.has(r.recTimingId)) {
      out.push({ timingId: r.recTimingId, t4: now, clientSkew: skew });
    }
  }
  return out;
}
