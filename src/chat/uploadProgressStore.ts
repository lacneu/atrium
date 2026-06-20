// Tiny external store for attachment-UPLOAD progress, read via useSyncExternalStore
// so ONLY the composer's progress indicator re-renders on each progress tick (a
// big-file upload fires many) — never the whole thread. The attachment adapter
// reports into it from inside `send()`; `<UploadProgress>` subscribes.
//
// Why this exists: assistant-ui's `AttachmentAdapter.send` is `Promise`-only (no
// progress generator), and the upload runs there (the slow part for a big file),
// AFTER the composer clears + BEFORE onNew's optimistic echo — so without this the
// user sees nothing for seconds. This surfaces immediate, advancing feedback.

export type UploadSnapshot = {
  active: boolean;
  percent: number; // 0..100 aggregate across in-flight uploads
  count: number; // number of files currently uploading
};

const inflight = new Map<string, { loaded: number; total: number }>();
let snapshot: UploadSnapshot = { active: false, percent: 0, count: 0 };
const listeners = new Set<() => void>();

function recompute() {
  let loaded = 0;
  let total = 0;
  for (const v of inflight.values()) {
    loaded += v.loaded;
    total += v.total;
  }
  const count = inflight.size;
  // New object ONLY here (not on every getSnapshot) so useSyncExternalStore's
  // Object.is check is stable between ticks (no render loop).
  snapshot = {
    active: count > 0,
    percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
    count,
  };
  for (const l of listeners) l();
}

export const uploadProgressStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  getSnapshot(): UploadSnapshot {
    return snapshot;
  },
  /** Report (or update) an in-flight upload's byte progress. */
  report(id: string, loaded: number, total: number): void {
    inflight.set(id, { loaded, total });
    recompute();
  },
  /** Drop an upload from the in-flight set (on success OR failure). */
  clear(id: string): void {
    if (inflight.delete(id)) recompute();
  },
};
