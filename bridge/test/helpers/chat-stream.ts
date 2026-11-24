/**
 * The `chat` delta the gateway publishes beside an `assistant` text frame.
 *
 * The bubble's live text is read from the `chat` stream alone. Scenarios written when the
 * `assistant` stream fed it keep their point (a compaction reset, a lifecycle error after
 * partial text, an approval released by resumed content) by carrying the same text the way
 * the gateway does: a `chat` delta whose `message` is the run's text so far. One item per
 * run is assumed (no item join), which is what those scenarios hold.
 */
export function assistantAsChat(frames: unknown[]): unknown[] {
  const runText = new Map<string, string>();
  return frames.map((frame) => {
    const f = frame as { event?: unknown; payload?: Record<string, unknown> };
    const p = f.payload;
    const data = p?.data as Record<string, unknown> | undefined;
    // A run that ended (or was abandoned to be replayed) starts its text over.
    if (f.event === "agent" && p?.stream === "lifecycle" && (data?.phase === "end" || data?.phase === "error")) {
      runText.delete(String(p.runId));
    }
    if (f.event !== "agent" || p?.stream !== "assistant" || !data || data.phase === "commentary") {
      return frame;
    }
    const delta = typeof data.delta === "string" ? data.delta : "";
    const runId = String(p.runId);
    const previous = data.replace === true ? "" : (runText.get(runId) ?? "");
    const text = typeof data.text === "string" ? data.text : previous + delta;
    if (typeof data.text !== "string" && typeof data.delta !== "string") return frame;
    runText.set(runId, text);
    const { stream: _stream, data: _data, ...rest } = p;
    return {
      ...f,
      event: "chat",
      payload: {
        ...rest,
        state: "delta",
        deltaText: delta,
        ...(data.replace === true ? { replace: true } : {}),
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    };
  });
}
