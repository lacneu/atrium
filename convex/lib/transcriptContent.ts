// WHAT A TRANSCRIPT ROW SHOWS, AS BLOCKS — the Convex side of the row contract (transcript
// redesign, final design §3.3-§3.5, step 1; projection `on` only).
//
// The bridge reads each projected row the way the Control UI's `normalizeMessage` does
// (bridge/src/providers/openclaw/row-blocks.ts) and posts its ordered blocks — text, file,
// tool — beside the text it always posted. This module is the trust boundary for them: the
// shapes and bounds are re-checked here (the body came over the network), and the row's
// content is bounded under the SAME budget as its text (one document, one apply).
//
// Pure: validators, types and bounds. The store is convex/transcriptProjection.ts; the files
// the blocks name are convex/transcriptFiles.ts.

import { v, type Infer } from "convex/values";
import { MAX_COMPOSED_TEXT_BYTES, utf8Bytes } from "./bubbleProjection";
import { WIDGET_TITLE_MAX_CHARS, WIDGET_VIEW_ID_RE } from "./widgetDescriptor";

/** One row's content budget in UTF-8 bytes — text, acknowledgment, error text and blocks
 *  together (bridge: transcript-rows.ts `ROW_TEXT_MAX_BYTES`, the same 768 KiB). */
export const MAX_ROW_CONTENT_BYTES = MAX_COMPOSED_TEXT_BYTES;
/** An error text over this is not kept (never cut) — bridge `ROW_ERROR_MAX_BYTES`. */
export const MAX_ROW_ERROR_BYTES = 4096;
/** Bounds mirrored from bridge row-blocks.ts. */
export const MAX_ROW_BLOCKS = 64;
const MAX_MEDIA_SOURCE_CHARS = 4096;
const MAX_ARTIFACT_ID_CHARS = 256;
const MAX_FILE_LABEL_CHARS = 512;
const MAX_MIME_CHARS = 128;
const MAX_TOOL_ID_CHARS = 256;
const MAX_TOOL_NAME_CHARS = 128;

const fileKindValidator = v.union(v.literal("image"), v.literal("audio"), v.literal("video"), v.literal("document"));

/** One block of a row (bridge row-blocks.ts `RowBlock`). */
export const rowBlockValidator = v.union(
  v.object({ type: v.literal("text"), text: v.optional(v.string()), omitted: v.optional(v.boolean()) }),
  v.object({
    type: v.literal("file"),
    kind: fileKindValidator,
    artifactId: v.optional(v.string()),
    mediaSource: v.optional(v.string()),
    remote: v.optional(v.boolean()),
    url: v.optional(v.string()),
    errorCode: v.optional(
      v.union(v.literal("file-not-found"), v.literal("unsupported-format"), v.literal("delivery-failed")),
    ),
    omitted: v.optional(v.boolean()),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    label: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("tool"),
    toolCallId: v.string(),
    name: v.optional(v.string()),
    status: v.union(v.literal("call"), v.literal("result"), v.literal("error")),
    // The call's arguments and the result, as the live tool part carries them (bridge
    // row-blocks.ts `RowToolBlock`, codex review 11), or the size they had when the row's
    // content budget left them out.
    input: v.optional(v.any()),
    output: v.optional(v.any()),
    inputOmitted: v.optional(v.boolean()),
    inputBytes: v.optional(v.number()),
    outputOmitted: v.optional(v.boolean()),
    outputBytes: v.optional(v.number()),
  }),
  // An inline widget the row names (bridge row-blocks.ts `RowWidgetBlock`).
  v.object({
    type: v.literal("widget"),
    viewId: v.string(),
    title: v.optional(v.string()),
    preferredHeight: v.optional(v.number()),
    origin: v.union(v.literal("tool"), v.literal("canvas"), v.literal("shortcode")),
  }),
);
export type RowBlock = Infer<typeof rowBlockValidator>;
export type RowFileBlock = Extract<RowBlock, { type: "file" }>;

/** `__openclaw.transcriptPosition` (upstream src/chat/transcript-display-position.ts:36). */
export const transcriptPositionValidator = v.object({
  source: v.string(),
  rawSeq: v.number(),
  activity: v.optional(
    v.object({ afterRawSeq: v.union(v.number(), v.null()), scopeId: v.string(), startOrder: v.number() }),
  ),
});
export type TranscriptPosition = Infer<typeof transcriptPositionValidator>;

export const IDEMPOTENCY_KINDS: ReadonlySet<string> = new Set([
  "message-tool",
  "internal-source-reply",
  "user",
  "settled-finalization-fallback",
  "other",
]);

const boundedString = (x: unknown, max: number): string | undefined =>
  typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined;
const safeNonNegative = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : undefined;

/** A display position the gateway wrote — upstream `readTranscriptDisplayPosition`
 *  (src/chat/transcript-display-position.ts:24-34 at v2026.9.33), refused whole when invalid. */
export function sanitizePosition(raw: unknown): TranscriptPosition | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const source = boundedString(r.source, 128);
  const rawSeq = safeNonNegative(r.rawSeq);
  if (source === undefined || rawSeq === undefined) return undefined;
  if (r.activity === undefined) return { source, rawSeq };
  const a = typeof r.activity === "object" && r.activity !== null ? (r.activity as Record<string, unknown>) : null;
  if (a === null) return undefined;
  const afterRawSeq = a.afterRawSeq === null ? null : safeNonNegative(a.afterRawSeq);
  const scopeId = boundedString(a.scopeId, 1024);
  const startOrder = safeNonNegative(a.startOrder);
  if (afterRawSeq === undefined || scopeId === undefined || startOrder === undefined) return undefined;
  if (afterRawSeq !== null && afterRawSeq >= rawSeq) return undefined;
  return { source, rawSeq, activity: { afterRawSeq, scopeId, startOrder } };
}

const FILE_KINDS: ReadonlySet<string> = new Set(["image", "audio", "video", "document"]);
const ERROR_CODES: ReadonlySet<string> = new Set(["file-not-found", "unsupported-format", "delivery-failed"]);
const TOOL_STATUSES: ReadonlySet<string> = new Set(["call", "result", "error"]);

/** The blocks a row may keep: known shapes, bounded fields, at most MAX_ROW_BLOCKS. A
 *  malformed block is dropped, never guessed. */
export function sanitizeRowBlocks(raw: unknown): RowBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // Known and empty (codex review 4, finding 2): the row shows nothing — never "absent",
  // which falls back to the raw text.
  if (raw.length === 0) return [];
  const out: RowBlock[] = [];
  for (const item of raw.slice(0, MAX_ROW_BLOCKS)) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Record<string, unknown>;
    if (b.type === "text") {
      if (typeof b.text === "string") out.push({ type: "text", text: b.text });
      else if (b.omitted === true) out.push({ type: "text", omitted: true });
    } else if (b.type === "file") {
      if (typeof b.kind !== "string" || !FILE_KINDS.has(b.kind)) continue;
      const artifactId = boundedString(b.artifactId, MAX_ARTIFACT_ID_CHARS);
      const mediaSource = artifactId === undefined ? boundedString(b.mediaSource, MAX_MEDIA_SOURCE_CHARS) : undefined;
      const mimeType = boundedString(b.mimeType, MAX_MIME_CHARS);
      const label = boundedString(b.label, MAX_FILE_LABEL_CHARS);
      const sizeBytes = typeof b.sizeBytes === "number" && Number.isFinite(b.sizeBytes) && b.sizeBytes >= 0 ? b.sizeBytes : undefined;
      out.push({
        type: "file",
        kind: b.kind as RowFileBlock["kind"],
        ...(artifactId !== undefined ? { artifactId } : {}),
        ...(mediaSource !== undefined ? { mediaSource } : {}),
        ...(b.remote === true && artifactId === undefined && mediaSource === undefined ? { remote: true } : {}),
        // A remote reference keeps its https URL: the reader's browser loads it, as the
        // Control UI does (chat-message-attachments.ts:127-134). Never fetched by Atrium.
        ...(b.remote === true && artifactId === undefined && mediaSource === undefined
          ? (() => {
              const url = boundedString(b.url, MAX_MEDIA_SOURCE_CHARS);
              return url !== undefined && /^https:\/\//i.test(url) ? { url } : {};
            })()
          : {}),
        ...(typeof b.errorCode === "string" && ERROR_CODES.has(b.errorCode)
          ? { errorCode: b.errorCode as NonNullable<RowFileBlock["errorCode"]> }
          : {}),
        ...(b.omitted === true ? { omitted: true } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(label !== undefined ? { label } : {}),
      });
    } else if (b.type === "tool") {
      const toolCallId = boundedString(b.toolCallId, MAX_TOOL_ID_CHARS);
      if (toolCallId === undefined || typeof b.status !== "string" || !TOOL_STATUSES.has(b.status)) continue;
      const name = boundedString(b.name, MAX_TOOL_NAME_CHARS);
      const bytes = (x: unknown): number | undefined => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : undefined);
      const inputBytes = b.inputOmitted === true ? bytes(b.inputBytes) : undefined;
      const outputBytes = b.outputOmitted === true ? bytes(b.outputBytes) : undefined;
      out.push({
        type: "tool",
        toolCallId,
        ...(name !== undefined ? { name } : {}),
        status: b.status as "call" | "result" | "error",
        // Kept as the bridge sent them (JSON values; the row's budget bounds them): what
        // `chat.history` serves, already masked by the gateway's storage
        // (src/agents/transcript-redact.ts:721). The card masks them again at display, as
        // the Control UI does (src/chat/toolActivityView.ts `toolCardDisplay`).
        ...(b.input !== undefined && b.inputOmitted !== true ? { input: b.input } : {}),
        ...(b.output !== undefined && b.outputOmitted !== true ? { output: b.output } : {}),
        ...(b.inputOmitted === true ? { inputOmitted: true, ...(inputBytes !== undefined ? { inputBytes } : {}) } : {}),
        ...(b.outputOmitted === true ? { outputOmitted: true, ...(outputBytes !== undefined ? { outputBytes } : {}) } : {}),
      });
    } else if (b.type === "widget") {
      // Re-checked, never trusted: the managed-document grammar, a bounded title, the
      // gateway's height bounds, a known carrier.
      if (typeof b.viewId !== "string" || !WIDGET_VIEW_ID_RE.test(b.viewId)) continue;
      if (b.origin !== "tool" && b.origin !== "canvas" && b.origin !== "shortcode") continue;
      const title = typeof b.title === "string" && b.title.trim() !== "" ? b.title.trim().slice(0, WIDGET_TITLE_MAX_CHARS) : undefined;
      const preferredHeight =
        typeof b.preferredHeight === "number" && Number.isFinite(b.preferredHeight)
          ? Math.min(Math.max(Math.trunc(b.preferredHeight), 160), 1200)
          : undefined;
      out.push({
        type: "widget",
        viewId: b.viewId,
        ...(title !== undefined ? { title } : {}),
        ...(preferredHeight !== undefined ? { preferredHeight } : {}),
        origin: b.origin,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

export type RowContent = { text?: string; yieldAck?: string; errorMessage?: string; blocks?: RowBlock[] };

/** What a row's content weighs (bridge transcript-rows.ts `rowContentBytes`). */
export function rowContentBytes(c: RowContent): number {
  return (
    utf8Bytes(c.text ?? "") +
    utf8Bytes(c.yieldAck ?? "") +
    utf8Bytes(c.errorMessage ?? "") +
    (c.blocks === undefined || c.blocks.length === 0 ? 0 : utf8Bytes(JSON.stringify(c.blocks)))
  );
}

const withoutBlockTexts = (blocks: readonly RowBlock[]): RowBlock[] =>
  blocks.map((b) => (b.type === "text" ? { type: "text" as const, omitted: true } : b));

/** The tool blocks without their payloads, each marked cut with its size (bridge
 *  row-blocks.ts `withoutToolPayloads`). */
export function withoutToolPayloads(blocks: readonly RowBlock[]): RowBlock[] {
  return blocks.map((b) => {
    if (b.type !== "tool" || (b.input === undefined && b.output === undefined)) return b;
    const { input, output, ...rest } = b;
    return {
      ...rest,
      ...(input !== undefined ? { inputOmitted: true, inputBytes: utf8Bytes(JSON.stringify(input) ?? "") } : {}),
      ...(output !== undefined ? { outputOmitted: true, outputBytes: utf8Bytes(JSON.stringify(output) ?? "") } : {}),
    };
  });
}

/**
 * Bound a row's content under MAX_ROW_CONTENT_BYTES, never by cutting a text (bridge
 * transcript-rows.ts `boundRowContent`, same order): the text first (the existing rule,
 * `shown`), the acknowledgment and the error text only while they fit beside it; then the
 * blocks — whole, else without their text segments (a row's files and tool blocks are never
 * dropped for the size of its text), else alone (the text goes, as an over-bound text always
 * did).
 */
export function boundRowContent(shown: { text?: string; yieldAck?: string }, extra: { errorMessage?: unknown; blocks?: RowBlock[] }): RowContent {
  const err =
    typeof extra.errorMessage === "string" &&
    extra.errorMessage !== "" &&
    utf8Bytes(extra.errorMessage) <= MAX_ROW_ERROR_BYTES &&
    rowContentBytes({ ...shown, errorMessage: extra.errorMessage }) <= MAX_ROW_CONTENT_BYTES
      ? extra.errorMessage
      : undefined;
  const base: RowContent = { ...shown, ...(err !== undefined ? { errorMessage: err } : {}) };
  if (extra.blocks === undefined) return base;
  // Known and empty: kept as such (the row shows nothing; see `sanitizeRowBlocks`).
  if (extra.blocks.length === 0) return { ...base, blocks: [] };
  const whole = { ...base, blocks: extra.blocks };
  if (rowContentBytes(whole) <= MAX_ROW_CONTENT_BYTES) return whole;
  // The tool payloads go first (codex review 11): the cards stay, marked cut.
  const lean = { ...base, blocks: withoutToolPayloads(extra.blocks) };
  if (rowContentBytes(lean) <= MAX_ROW_CONTENT_BYTES) return lean;
  const stripped = { ...base, blocks: withoutBlockTexts(withoutToolPayloads(extra.blocks)) };
  if (rowContentBytes(stripped) <= MAX_ROW_CONTENT_BYTES) return stripped;
  return { blocks: withoutBlockTexts(withoutToolPayloads(extra.blocks)) };
}

/** The file blocks of a row, with their index IN THE ROW's block list — a `MEDIA:`
 *  reference's identity is (row, block index), a managed file's its artifact id. */
export function fileBlocksOf(blocks: readonly RowBlock[] | undefined): Array<{ index: number; block: RowFileBlock }> {
  const out: Array<{ index: number; block: RowFileBlock }> = [];
  (blocks ?? []).forEach((block, index) => {
    if (block.type === "file") out.push({ index, block });
  });
  return out;
}
