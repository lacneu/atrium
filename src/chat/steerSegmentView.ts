import { messageHasText } from "./runStatusView";

type ContentLike = ReadonlyArray<{ type?: string; text?: unknown; name?: string }>;

/** What a bubble shows whatever the Tools setting: a file, a widget, and the prose that is
 *  not the answer (0.103.0) — the agent's work notes and the model's reasoning. */
const SHOWN_DATA: ReadonlySet<string | undefined> = new Set(["widget", "commentary", "thinking"]);

/** A steer segment (projection `on`, CU-20) that shows nothing once tool work is hidden:
 *  no text, no file, no widget, no work note, no reasoning. */
export function steerSegmentSilent(steerSegment: boolean, content: ContentLike): boolean {
  return (
    steerSegment &&
    !messageHasText(content as ReadonlyArray<{ type?: string; text?: unknown }>) &&
    !content.some((p) => p?.type === "file" || (p?.type === "data" && SHOWN_DATA.has(p.name)))
  );
}
