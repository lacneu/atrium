// LIVE-TEXT BASELINES — the append-only streaming of OpenClaw 2026.9.7, undone at the
// connection so every reader downstream keeps seeing the frames it has always seen.
//
// WHAT CHANGED UPSTREAM, WITHOUT NEGOTIATION. From v2026.9.7 the gateway sends a
// socket the FULL live text once, then only what was appended — per socket, per run
// and per publication key, and only while that socket received the previous
// publication of the key (`canSendDelta`, src/gateway/server-broadcast-live-text.ts:
// 214-224). The delta frames lose their cumulative field:
//   - `chat` deltas drop `message` and keep `deltaText` (`projectChatWireDelta`,
//     src/gateway/server-chat-live-text.ts:17-21; the chat publication carries no text
//     of its own, so it is a snapshot only on `replace` or a canvas-block change,
//     :52-77);
//   - `agent` `assistant` events drop `data.text` and keep `data.delta`
//     (`projectAssistantWireDelta` :23-28), and only when the new text IS the previous
//     one plus the delta for the same `itemId` (`isLiveTextAppend`,
//     src/gateway/live-text-continuity.ts:3-13; snapshot forced on replace, an empty
//     delta or media, `assistantWireProjection` :79-106).
// No capability turns it on or off. Terminal frames (`final`, `error`, `aborted`) keep
// their message.
//
// WHY HERE. The normalizer treats a frame carrying the cumulative text as a snapshot
// and LOCKS on it (normalizer.ts `applyVisible`: a delta after a snapshot is dropped),
// so on 9.7 the live reply froze on its first fragment until the final. The Control UI
// does not patch its reducer either: it rebuilds the cumulative message per run at the
// CONNECTION, before any listener sees the event (`GatewayChatStreamProjection`,
// packages/gateway-client/src/chat-stream-projection.ts:7-56, merge rules
// `mergeChatStreamMessage`, chat-stream-message.ts:3-46). This module is that, for the
// bridge: the frames leave it carrying `message` / `data.text` again, exactly as 9.6
// sent them, so the normalizer, the sub-agent observer and the run manager are
// untouched — and on 9.6, where every delta already carries its base, it changes
// nothing at all (identity, asserted by the golden corpus).
//
// A MISSING BASELINE. The gateway only drops the base for a socket that received the
// previous publication, so a delta without one means THIS side lost a frame (an
// unreadable frame, a bug). The Control UI drops the event and reconnects
// (ui/src/api/gateway-chat-events.ts:59-74). The bridge cannot drop a conversation
// socket mid-turn for that, so the frame goes on WITHOUT its fragment — a fragment
// without its prefix appended to the reply is a corrupted reply, and the final frame
// carries the whole text anyway — and the caller is told, so it can re-read the
// in-flight text (`chat.history` → `inFlightRun`).

import type { GatewayFrame } from "./openclaw-client.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A delta that arrived with nothing to append to. */
export interface LiveTextGap {
  stream: "chat" | "agent";
  runId: string;
  sessionKey: string;
}

export interface ProjectedFrame {
  frame: GatewayFrame;
  gap: LiveTextGap | null;
  /** UTF-8 bytes of the cumulative text this projection ADDED to the frame — what the
   *  rebuilt frame weighs beyond the wire bytes it arrived as. 0 whenever the frame is
   *  returned as received (every frame of a gateway that sends the base each time). */
  addedBytes: number;
}

interface ChatBaseline {
  sessionKey: string;
  agentId: unknown;
  message: unknown;
  /** UTF-8 bytes of the message's text blocks, computed ONCE when the first append lands
   *  on a received snapshot and then carried forward by each delta's own size — so a long
   *  reply costs O(delta) per frame, not a re-measure of the whole text. Undefined until
   *  then: a gateway that always sends the base never pays for it. */
  textBytes?: number;
  /** Ordering memory (see `staleOrRepeated`). */
  lastSeq?: number;
  lastAppendKey?: string;
  lastOut?: ProjectedFrame;
}

interface AssistantBaseline {
  sessionKey: unknown;
  itemId: string | undefined;
  text: string;
  /** Same carry-forward rule as ChatBaseline.textBytes. */
  textBytes?: number;
  lastSeq?: number;
  lastAppendKey?: string;
  lastOut?: ProjectedFrame;
}

/** RETRANSMISSIONS AND LATE FRAMES, before anything is accumulated.
 *
 *  A run's `payload.seq` grows with every event it emits. The gateway can re-send a frame
 *  verbatim (same runId, same seq), and a cumulative frame made that harmless: the
 *  normalizer drops an exact re-broadcast by a key that includes the message
 *  (normalizer.ts `handleChat` dedup). An append is not idempotent — applied twice it
 *  duplicates its text — and once rebuilt, the two copies carry DIFFERENT messages, so
 *  that key can no longer see them as one frame. Upstream does not meet the case: the
 *  Control UI's projection keeps no seq at all (packages/gateway-client/src/
 *  chat-stream-projection.ts:11-38) because its socket never redelivers — the protocol
 *  client tracks the envelope seq and reconnects on any hole
 *  (packages/gateway-client/src/protocol-client.ts:459-482). The bridge keeps its socket,
 *  so it orders the run's frames itself:
 *   - a frame at or below the last applied seq never moves the baseline;
 *   - an EXACT repeat of the last append returns the very frame the first copy produced,
 *     so the normalizer's own dedup drops it, as it always did;
 *   - a cumulative frame is passed as received (the reader decides, as before);
 *   - an append that cannot be placed (older seq, or the same seq with other content) is
 *     withheld like a missing baseline, and the in-flight text is re-read. */
type SeqMemory = { lastSeq?: number; lastAppendKey?: string; lastOut?: ProjectedFrame };

function staleOrRepeated(
  previous: SeqMemory | undefined,
  seq: number | undefined,
  cumulative: boolean,
  appendKey: string,
  withheld: () => ProjectedFrame,
  frame: GatewayFrame,
): ProjectedFrame | null {
  if (seq === undefined || previous?.lastSeq === undefined || seq > previous.lastSeq) return null;
  if (cumulative) return { frame, gap: null, addedBytes: 0 };
  if (seq === previous.lastSeq && previous.lastAppendKey === appendKey && previous.lastOut) {
    // The queue already holds this frame's text: nothing new to weigh.
    return { ...previous.lastOut, addedBytes: 0 };
  }
  return withheld();
}

/** UTF-8 bytes of a chat message's text, as the merge above stores it. */
function messageTextBytes(message: unknown): number {
  if (!isRecord(message)) return 0;
  if (typeof message.content === "string") return Buffer.byteLength(message.content, "utf8");
  if (!Array.isArray(message.content)) return 0;
  let n = 0;
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      n += Buffer.byteLength(block.text, "utf8");
    }
  }
  return n;
}

/** Runs whose terminal never reached this socket must not pin their text forever. */
const MAX_TRACKED_RUNS = 256;

/** Mirror of upstream `mergeChatStreamMessage` (chat-stream-message.ts:4-46 @v2026.9.7):
 *  a frame with `message` IS the snapshot; an append-only frame needs a baseline, and a
 *  `replace` rebuilds the text block from the delta alone. `undefined` = no baseline. */
export function mergeChatStreamMessage(
  previous: unknown,
  payload: { message?: unknown; deltaText?: unknown; replace?: unknown },
): unknown {
  if (payload.message !== undefined) {
    return payload.message;
  }
  const delta = payload.deltaText;
  if (typeof delta !== "string") {
    return previous;
  }
  const replace = payload.replace === true;
  if (!delta && !replace) {
    return previous;
  }
  if (!isRecord(previous) && !replace) {
    return undefined;
  }
  const message: JsonRecord = isRecord(previous) ? previous : { role: "assistant" };
  if (typeof message.content === "string") {
    return { ...message, content: replace ? delta : message.content + delta };
  }
  const content: unknown[] = Array.isArray(message.content) ? [...message.content] : [];
  const isText = (block: unknown): block is JsonRecord =>
    isRecord(block) && block.type === "text";
  if (replace) {
    return {
      ...message,
      content: [{ type: "text", text: delta }, ...content.filter((block) => !isText(block))],
    };
  }
  let index = -1;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    if (isText(content[i])) {
      index = i;
      break;
    }
  }
  const block = index >= 0 ? content[index] : undefined;
  if (isText(block)) {
    content[index] = {
      ...block,
      text: `${typeof block.text === "string" ? block.text : ""}${delta}`,
    };
  } else {
    content.push({ type: "text", text: delta });
  }
  return { ...message, content };
}

/** Connection-owned baselines: one instance per gateway socket, never shared. */
export class LiveTextBaselines {
  private readonly chat = new Map<string, ChatBaseline>();
  private readonly assistant = new Map<string, AssistantBaseline>();
  /** Runs whose chat terminal this socket has seen, most recent last, bounded. A re-read
   *  of the in-flight text that lands after the terminal belongs to a run that is over:
   *  forwarded, its pre-terminal `delta` would reach a turn in its finishing grace and
   *  could rewrite the reply or prolong the wait. */
  private readonly ended = new Map<string, true>();

  /** Restore the cumulative field of an append-only frame; every other frame is
   *  returned as is (same object). */
  project(frame: GatewayFrame): ProjectedFrame {
    if (frame.type !== "event" || !isRecord(frame.payload)) {
      return { frame, gap: null, addedBytes: 0 };
    }
    if (frame.event === "chat") return this.projectChat(frame, frame.payload);
    if (frame.event === "agent") return this.projectAgent(frame, frame.payload);
    return { frame, gap: null, addedBytes: 0 };
  }

  private projectChat(frame: GatewayFrame, payload: JsonRecord): ProjectedFrame {
    const runId = payload.runId;
    const sessionKey = payload.sessionKey;
    if (typeof runId !== "string" || typeof sessionKey !== "string") {
      return { frame, gap: null, addedBytes: 0 };
    }
    const state = payload.state;
    if (state === "final" || state === "error" || state === "aborted") {
      this.chat.delete(runId);
      this.assistant.delete(runId);
      this.remember(this.ended, runId, true);
      return { frame, gap: null, addedBytes: 0 };
    }
    if (state !== "delta") {
      return { frame, gap: null, addedBytes: 0 };
    }
    const previous = this.chat.get(runId);
    const seq = typeof payload.seq === "number" ? payload.seq : undefined;
    const appendKey = JSON.stringify([payload.deltaText ?? null, payload.replace === true]);
    const withheldChat = (): ProjectedFrame => ({
      frame: { ...frame, payload: { ...payload, deltaText: "" } },
      gap: { stream: "chat", runId, sessionKey },
      addedBytes: 0,
    });
    const ordered = staleOrRepeated(
      previous !== undefined && previous.sessionKey === sessionKey ? previous : undefined,
      seq,
      payload.message !== undefined,
      appendKey,
      withheldChat,
      frame,
    );
    if (ordered !== null) return ordered;
    const message = mergeChatStreamMessage(
      previous !== undefined &&
        previous.sessionKey === sessionKey &&
        previous.agentId === payload.agentId
        ? previous.message
        : undefined,
      payload,
    );
    if (message === undefined) {
      // No base to append to: forward the frame (it still says the run is alive)
      // without a fragment that would land with its prefix missing.
      return withheldChat();
    }
    if (payload.message !== undefined) {
      this.remember(this.chat, runId, {
        sessionKey,
        agentId: payload.agentId,
        message,
        lastSeq: seq ?? previous?.lastSeq,
      });
      return { frame, gap: null, addedBytes: 0 };
    }
    const delta = typeof payload.deltaText === "string" ? payload.deltaText : "";
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    const continued =
      previous !== undefined && previous.message !== message && payload.replace !== true;
    const textBytes =
      payload.replace === true
        ? deltaBytes
        : continued
          ? (previous!.textBytes ?? messageTextBytes(previous!.message)) + deltaBytes
          : messageTextBytes(message);
    const out: ProjectedFrame = {
      frame: { ...frame, payload: { ...payload, message } },
      gap: null,
      addedBytes: message === previous?.message ? 0 : textBytes,
    };
    this.remember(this.chat, runId, {
      sessionKey,
      agentId: payload.agentId,
      message,
      textBytes,
      lastSeq: seq ?? previous?.lastSeq,
      lastAppendKey: appendKey,
      lastOut: out,
    });
    return out;
  }

  private projectAgent(frame: GatewayFrame, payload: JsonRecord): ProjectedFrame {
    const runId = payload.runId;
    if (typeof runId !== "string") return { frame, gap: null, addedBytes: 0 };
    const data = payload.data;
    if (payload.stream === "lifecycle") {
      if (isRecord(data) && (data.phase === "end" || data.phase === "error")) {
        this.assistant.delete(runId);
      }
      return { frame, gap: null, addedBytes: 0 };
    }
    if (payload.stream !== "assistant" || !isRecord(data)) {
      return { frame, gap: null, addedBytes: 0 };
    }
    const itemId =
      typeof data.itemId === "string" && data.itemId !== "" ? data.itemId : undefined;
    const previous = this.assistant.get(runId);
    const seq = typeof payload.seq === "number" ? payload.seq : undefined;
    const delta = data.delta;
    const withheldAgent = (): ProjectedFrame => {
      const { delta: _dropped, ...rest } = data;
      return {
        frame: { ...frame, payload: { ...payload, data: rest } },
        gap:
          typeof payload.sessionKey === "string"
            ? { stream: "agent", runId, sessionKey: payload.sessionKey }
            : null,
        addedBytes: 0,
      };
    };
    const appendKey = JSON.stringify([delta ?? null, data.replace === true, itemId ?? null]);
    if (typeof data.text === "string" || typeof delta === "string") {
      const ordered = staleOrRepeated(
        previous !== undefined && previous.sessionKey === payload.sessionKey ? previous : undefined,
        seq,
        typeof data.text === "string",
        appendKey,
        withheldAgent,
        frame,
      );
      if (ordered !== null) return ordered;
    }
    if (typeof data.text === "string") {
      this.remember(this.assistant, runId, {
        sessionKey: payload.sessionKey,
        itemId,
        text: data.text,
        lastSeq: seq ?? previous?.lastSeq,
      });
      return { frame, gap: null, addedBytes: 0 };
    }
    if (typeof delta !== "string") {
      return { frame, gap: null, addedBytes: 0 };
    }
    // Upstream's own accumulation (`prepareAgentWirePayload`, server-chat-live-text.ts:
    // 108-133): a replace or a new item starts over, anything else appends to the
    // previous text of the same item.
    let text: string | undefined;
    if (data.replace === true) {
      text = delta;
    } else if (
      previous !== undefined &&
      previous.sessionKey === payload.sessionKey &&
      previous.itemId === itemId
    ) {
      text = previous.text + delta;
    }
    if (text === undefined) return withheldAgent();
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    const textBytes =
      data.replace === true
        ? deltaBytes
        : (previous!.textBytes ?? Buffer.byteLength(previous!.text, "utf8")) + deltaBytes;
    const out: ProjectedFrame = {
      frame: { ...frame, payload: { ...payload, data: { ...data, text } } },
      gap: null,
      addedBytes: textBytes,
    };
    this.remember(this.assistant, runId, {
      sessionKey: payload.sessionKey,
      itemId,
      text,
      textBytes,
      lastSeq: seq ?? previous?.lastSeq,
      lastAppendKey: appendKey,
      lastOut: out,
    });
    return out;
  }

  private remember<T>(map: Map<string, T>, runId: string, value: T): void {
    map.delete(runId);
    map.set(runId, value);
    if (map.size > MAX_TRACKED_RUNS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  /** Is a chat baseline held for this run? (the re-read only fills a gap) */
  hasChatBaseline(runId: string): boolean {
    return this.chat.has(runId);
  }

  /** Has this socket seen the run's chat terminal? */
  hasEnded(runId: string): boolean {
    return this.ended.has(runId);
  }

  /** Retire every baseline after a frame was LOST on this socket (an unreadable frame, a
   *  hole in the envelope seq): the lost one may have been an append, and which run it
   *  belonged to is unknown. The next append of any run then reports a gap and re-reads
   *  instead of extending a prefix that misses text. Terminal markers are kept. */
  invalidate(): void {
    this.chat.clear();
    this.assistant.clear();
  }

  clear(): void {
    this.invalidate();
    this.ended.clear();
  }
}
