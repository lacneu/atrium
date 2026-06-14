import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  ConvexMessagePartView,
  ConvexMessageView,
  isFilePart,
  isMediaPart,
  isReasoningPart,
  isToolPart,
  type ProvenancePartView,
} from "./convexTypes";
import type { ToolActivityPart } from "./toolActivityView";

// Maps a Convex `messages` document (joined with its ordered `messageParts`)
// into the assistant-ui `ThreadMessageLike` shape consumed by
// useExternalStoreRuntime's `convertMessage`.
//
// Content parts produced (CHRONOLOGICAL: reasoning precedes the text — it
// happens first — and media/file attachments follow it; the old text-first
// order made the late-arriving final text insert ABOVE the stacked tool cards,
// out of view of the bottom-following auto-scroll):
//   - { type: "reasoning", text }                    (reasoning parts)
//   - { type: "text", text }                         (assistant/user/system body)
//   - { type: "file", mimeType, data: <url> }        (media + file parts)
//
// TOOL parts intentionally do NOT become content: they are extracted into
// `metadata.custom.toolParts` and rendered by the grouped ToolActivity block
// at the top of the assistant message (summary line + collapsible ToolCards).
//
// Streaming works WITHOUT any HTTP transport: the Convex bridge worker patches
// the message doc (text/status) and appends messageParts as OpenClaw frames
// arrive; useQuery re-runs reactively; this converter re-runs; assistant-ui
// re-renders. There is no per-turn POST+SSE connection that could close and
// drop post-turn OpenClaw events (the Open WebUI failure mode this project
// exists to kill).

// ThreadMessageLike["content"] is `string | readonly Part[]` in 0.14, so the
// `extends Array<infer T>` trick resolves to `never`. Take the array element
// type directly via indexed access on the array branch.
type MessageContent = NonNullable<ThreadMessageLike["content"]>;
type ContentPart = Extract<MessageContent, readonly unknown[]>[number];

/** Stable synthetic toolCallId; OpenClaw tool frames are keyed by run + name + order. */
function toolCallId(message: ConvexMessageView, order: number): string {
  const run = message.runId ?? "norun";
  return `${message._id}:${run}:${order}`;
}

function toolPartToActivity(
  message: ConvexMessageView,
  order: number,
  part: Extract<ConvexMessagePartView, { kind: "tool" }>,
): ToolActivityPart {
  return {
    toolCallId: toolCallId(message, order),
    toolName: part.name,
    // Same structural fields ToolCard consumed when assistant-ui routed
    // tool-call content parts to it: `args` (parsed input), `result` (output).
    args: (part.input ?? {}) as Record<string, unknown>,
    result: part.output,
    // `argsText` keeps the JSON form available so a tool card can show inputs
    // while the tool is still running.
    argsText:
      part.input === undefined ? undefined : safeStringify(part.input),
    phase: typeof part.phase === "string" ? part.phase : undefined,
  };
}

// The gateway names offloaded media `<base>---<uuid>.<ext>` (media-store id), so
// an agent-generated file surfaces as e.g.
// `openclaw-lightrag-report---4c23520c-…-….pdf`. Strip the `---<uuid>` segment
// for DISPLAY (and the download filename) so the chip reads `…-report.pdf`. Only
// a strict UUID immediately before the extension is removed — a user upload like
// `IFOA Presentation.pptx` (no such segment) is left untouched.
const GATEWAY_MEDIA_ID_RE =
  /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[^.]+$|$)/i;

export function displayFilename(name: string | undefined): string | undefined {
  if (!name) return name;
  return name.replace(GATEWAY_MEDIA_ID_RE, "");
}

function filePartToContent(
  part:
    | Extract<ConvexMessagePartView, { kind: "media" }>
    | Extract<ConvexMessagePartView, { kind: "file" }>,
): ContentPart | null {
  // Without a resolved URL there is nothing renderable; skip rather than leak
  // a storageId (which is an opaque key, never a path) into the DOM as data.
  if (!part.url) return null;
  return {
    type: "file",
    mimeType: part.mimeType,
    data: part.url,
    // `filename` is non-standard on the file content part but assistant-ui
    // tolerates extra fields and our custom MediaPart renderer reads it.
    filename: displayFilename(part.filename),
  } as ContentPart;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function convertConvexMessage(
  message: ConvexMessageView,
): ThreadMessageLike {
  const content: ContentPart[] = [];
  const toolParts: ToolActivityPart[] = [];
  const provenanceParts: ProvenancePartView[] = [];

  // 1) Parts that PRECEDE the text chronologically (listByChat returns parts
  //    flat + sorted by order): reasoning goes into content; tool calls are
  //    diverted to metadata.custom.toolParts (rendered by ToolActivity, never
  //    interleaved with the body — fixes the text-inserted-above-cards bug).
  //    Provenance reports are likewise diverted (rendered by SourcesActivity
  //    under the reply, never inside the body).
  message.parts.forEach((p, index) => {
    if (isReasoningPart(p)) {
      content.push({ type: "reasoning", text: p.text } as ContentPart);
    } else if (isToolPart(p)) {
      toolParts.push(toolPartToActivity(message, index, p));
    } else if (p.kind === "provenance") {
      provenanceParts.push(p);
    }
  });

  // 2) Primary text body. `message.text` is the live-streamed/normalized text
  //    (message.delta appends, message.snapshot replaces, message.final fixes).
  if (message.text && message.text.length > 0) {
    content.push({ type: "text", text: message.text });
  }

  // 3) Media/file attachments stay AFTER the text.
  message.parts.forEach((p) => {
    if (isMediaPart(p) || isFilePart(p)) {
      const fileContent = filePartToContent(p);
      if (fileContent) content.push(fileContent);
    }
  });

  // assistant-ui requires at least one content part to render a bubble; if a
  // message somehow has neither text nor renderable parts yet (e.g. a turn
  // that so far only produced tool calls), emit an empty text part so the
  // streaming placeholder still appears.
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: message._id,
    role: message.role,
    createdAt: new Date(message.updatedAt ?? message._creationTime),
    content,
    // Surface error text on the message so the Thread can style failed turns;
    // assistant-ui reads custom `metadata` for renderers that opt in.
    metadata: {
      custom: {
        // The Convex message _id — surfaced so per-message actions (delete) call
        // the mutation with the authoritative id, not assistant-ui's internal one.
        messageId: message._id,
        // The owning chat id — surfaced so per-message actions (forensic feedback)
        // can scope the mutation without threading chatId through React context.
        chatId: message.chatId,
        status: message.status,
        runId: message.runId ?? null,
        error: message.error ?? null,
        // Tool invocations for this turn, in part order. Re-emitted on every
        // conversion (useExternalStoreRuntime reconverts whenever the reactive
        // listByChat result changes), so the ToolActivity summary counter and
        // the expanded ToolCards stream live as the bridge appends/patches
        // tool parts.
        toolParts,
        // Provenance reports (what the gateway plugins fed the LLM this turn),
        // in part order — rendered by SourcesActivity as the "Sources" line.
        provenanceParts,
        // The EXACT stored text — the verbatim string for the "Source" view (no
        // markdown, no autocorrect, no transformation). For the user turn this is
        // what was typed/sent; for the assistant turn it is the gateway's final
        // text. The trust guarantee that lets a user verify a word was not
        // silently changed (see docs note in ConvexChat MessageSource).
        rawText: message.text,
      },
    },
  } satisfies ThreadMessageLike;
}
