import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  ConvexMessagePartView,
  ConvexMessageView,
  isCompactionPart,
  isFilePart,
  isMediaPart,
  isReasoningPart,
  isToolPart,
  type ProvenancePartView,
  isCronPart,
  type CronPartView,
  isPlanPart,
  type PlanPartView,
} from "./convexTypes";
import type { ToolActivityPart } from "./toolActivityView";
import { stripGatewayMediaId } from "../../convex/lib/mediaName";
import { m } from "@/paraglide/messages.js";

// A localized "(N KB, not shown here)" note for a part field ELIDED from the window
// read (loadChatView PART_FIELD_CAP) — shown in place of the omitted output/input/
// reasoning so the card reads honestly instead of appearing empty.
function omittedNote(bytes: number | undefined): string {
  return m.tools_field_omitted({ size: String(Math.round((bytes ?? 0) / 1024)) });
}

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
    // Oversized output/input are elided from the window read; show the size note in
    // place of the payload (the full value stays in the DB, not on the hot path).
    result: part.outputOmitted ? omittedNote(part.outputBytes) : part.output,
    // `argsText` keeps the JSON form available so a tool card can show inputs
    // while the tool is still running.
    argsText: part.inputOmitted
      ? omittedNote(part.inputBytes)
      : part.input === undefined
        ? undefined
        : safeStringify(part.input),
    phase: typeof part.phase === "string" ? part.phase : undefined,
  };
}

// Strip the gateway media-store `---<uuid>` id for DISPLAY (and the download
// filename) so an agent-generated file reads `…-report.pdf`. The strip lives in the
// SHARED lib/mediaName so the backend documentary correlation uses the EXACT same
// normalization (a returned `…---<uuid>.pdf` must match a `….pdf` reference).
export function displayFilename(name: string | undefined): string | undefined {
  if (!name) return name;
  return stripGatewayMediaId(name);
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
    // `filename` + `storageId` are non-standard on the file content part but
    // assistant-ui tolerates extra fields and our MediaPart renderer reads them
    // (storageId keys the Document Viewer's PDF-rendition request for Office files).
    filename: displayFilename(part.filename),
    storageId: part.storageId,
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
  // Per-message attribution resolved by the runtime (resolveMessageAgents):
  // an assistant message usually carries NO routed fields of its own and
  // INHERITS the preceding user turn's agent — the cron detail panel must
  // target THAT instance, not the chat primary.
  resolvedAgent?: { instanceName: string; agentId: string } | null,
): ThreadMessageLike {
  const content: ContentPart[] = [];
  const toolParts: ToolActivityPart[] = [];
  const provenanceParts: ProvenancePartView[] = [];
  const cronParts: CronPartView[] = [];
  const planParts: PlanPartView[] = [];
  // Gateway context-compaction marker (at most one is written per turn by the
  // bridge sink; keep the FIRST defensively). Rendered by CompactionNotice —
  // always visible (it explains the agent's shortened memory + a long wait),
  // never gated behind the tools toggle.
  let compaction: { phase: string; at: number } | null = null;

  // 1) Parts that PRECEDE the text chronologically (listByChat returns parts
  //    flat + sorted by order): reasoning goes into content; tool calls are
  //    diverted to metadata.custom.toolParts (rendered by ToolActivity, never
  //    interleaved with the body — fixes the text-inserted-above-cards bug).
  //    Provenance reports are likewise diverted (rendered by SourcesActivity
  //    under the reply, never inside the body).
  message.parts.forEach((p, index) => {
    if (isReasoningPart(p)) {
      content.push({
        type: "reasoning",
        text: p.textOmitted ? omittedNote(p.textBytes) : (p.text ?? ""),
      } as ContentPart);
    } else if (isToolPart(p)) {
      toolParts.push(toolPartToActivity(message, index, p));
    } else if (p.kind === "provenance") {
      provenanceParts.push(p);
    } else if (isCronPart(p)) {
      cronParts.push(p);
    } else if (isPlanPart(p)) {
      planParts.push(p);
    } else if (isCompactionPart(p) && compaction === null) {
      compaction = { phase: p.phase, at: p.at };
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
        // The message's true moment (fork copies carry their SOURCE time in
        // orderTime) — shown in the reply's contextual menu header.
        sentAt: message.orderTime ?? message._creationTime,
        // How long the reply took: dispatch creates the assistant placeholder,
        // the finalize is its last write — so updatedAt − _creationTime IS the
        // generation window. Only meaningful on a SETTLED assistant turn and
        // never on a fork copy (its timestamps are the copy's, not the run's).
        // Restricted to complete/aborted: an errored turn may be a dispatch
        // failure that never generated anything (failDispatch inserts a
        // terminal message directly) — showing "< 1 s" there would lie.
        // Reads the STABLE finalizedAt stamp (first terminal transition), so a
        // redelivered final / late part write can never inflate the duration;
        // rows finalized before the stamp existed simply show nothing.
        generationMs:
          message.role === "assistant" &&
          (message.status === "complete" || message.status === "aborted") &&
          message.orderTime === undefined &&
          typeof message.finalizedAt === "number"
            ? Math.max(0, message.finalizedAt - message._creationTime)
            : null,
        // The owning chat id — surfaced so per-message actions (forensic feedback)
        // can scope the mutation without threading chatId through React context.
        chatId: message.chatId,
        status: message.status,
        runId: message.runId ?? null,
        // TRUE only when a delivery/announce actually MERGED into this bubble
        // (see loadChatView) — MarkdownText skips its typewriter replay there.
        hasMergedRuns: message.hasMergedRuns ?? false,
        error: message.error ?? null,
        // Stable failure class (gateway errorKind or dispatch code) — drives
        // the actionable localized headline on the error card.
        errorCode: message.errorCode ?? null,
        // Live processing phase (in-flight turns only) — thinking-placeholder
        // detail when Tools is ON.
        phase: message.phase ?? null,
        // Tool invocations for this turn, in part order. Re-emitted on every
        // conversion (useExternalStoreRuntime reconverts whenever the reactive
        // listByChat result changes), so the ToolActivity summary counter and
        // the expanded ToolCards stream live as the bridge appends/patches
        // tool parts.
        toolParts,
        // Provenance reports (what the gateway plugins fed the LLM this turn),
        // in part order — rendered by SourcesActivity as the "Sources" line.
        provenanceParts,
        // Cron jobs the agent created/updated/removed this turn — rendered by
        // CronActivity as the dedicated "Crons" section next to Tools/Sources.
        cronParts,
        // Work-plan updates (update_plan) in part order — PlanActivity renders
        // the NEWEST as the live plan (steps + progress).
        planParts,
        // Which instance answered this turn (per-turn routing, INHERITED
        // attribution included); null = the chat's primary. The cron detail
        // panel targets THIS gateway.
        routedInstanceName:
          resolvedAgent?.instanceName ?? message.routedInstanceName ?? null,
        // Gateway context-compaction marker for this turn (null = none) —
        // rendered by CompactionNotice above the reply body.
        compaction,
        // L2: count of READY downloadable document attachments for this turn —
        // drives the subtle "joints" badge on the Sources chip.
        attachedDocCount: message.attachedDocCount ?? 0,
        // Mid-turn QUEUE: this user turn was sent while the chat was BUSY, so it is
        // parked as a `queued` outbox row awaiting the in-flight turn to drain.
        // Drives the "en attente" badge; clears reactively when the drainer promotes
        // it to dispatch (status -> pending/sent). Only meaningful for user turns.
        queued: message.role === "user" && message.outbox?.status === "queued",
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
