// THE ONE IDENTITY OF A TOOL CALL IN A TRANSCRIPT ROW (codex review 12).
//
// Ported from openclaw v2026.9.33: `resolveToolUseId` (src/chat/tool-content.ts:5-11 the
// field order, :48-57 the reader) and `resolveToolCallId` (ui/src/lib/chat/tool-cards.ts:224-237),
// which `extractToolCards` uses for every card (:386, :409 on content items, :499 on a
// tool-result message). Every reader of a row's call ids goes through here — the tool
// blocks (row-blocks.ts), the row's call-id index (transcript-rows.ts `rowToolCallIds`) —
// so a call the Control UI pairs is one Atrium pairs: a legacy `tool_use` naming its call
// only by `callId` was a card with no payload when the index read `id`/`toolCallId` alone.

/** tool-content.ts:5-11 `TOOL_USE_ID_FIELDS`, in upstream's order. */
const TOOL_USE_ID_FIELDS = ["id", "tool_call_id", "toolCallId", "tool_use_id", "toolUseId"] as const;

/** normalization-core string-coerce.ts `normalizeOptionalString`: trimmed, never blank. */
function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** tool-content.ts:48-57 `resolveToolUseId`. */
export function resolveToolUseId(block: Record<string, unknown>): string | undefined {
  for (const field of TOOL_USE_ID_FIELDS) {
    const id = normalizeOptionalString(block[field]);
    if (id) return id;
  }
  return undefined;
}

/** tool-cards.ts:224-237 `resolveToolCallId`: the content item's own id, then its legacy
 *  `callId`, then the message's. `item` is `{}` for a tool-result message (:499). */
export function resolveToolCallId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return (
    resolveToolUseId(item) ||
    (typeof item.callId === "string" && item.callId.trim()) ||
    (typeof message.toolCallId === "string" && message.toolCallId.trim()) ||
    (typeof message.tool_call_id === "string" && message.tool_call_id.trim()) ||
    (typeof message.toolUseId === "string" && message.toolUseId.trim()) ||
    (typeof message.tool_use_id === "string" && message.tool_use_id.trim()) ||
    undefined
  );
}

// ── Calls without an identity (codex review 13) ───────────────────────────────────────
//
// `extractToolCards` (tool-cards.ts:353) gives an id-less call the card id
// `${name}:${index}` (:388) and pairs an id-less result with the EARLIEST same-name call of
// the same message that has no output yet and was not already paired (:413-421); the pair
// keeps the result's id when only the result has one (:442 `existing.callId ??= callId`).
// Atrium keys a card by `toolCallId` across the rows of a bubble, so the message-local
// card id is scoped by the row's own transcript id: stable from one read to the next (the
// entry id and the content index do not move), unique across rows.

/** tool-content.ts:22-31 `isToolCallContentType` / `isToolResultContentType`. */
function contentType(value: unknown): "call" | "result" | null {
  const t = typeof value === "string" ? value.toLowerCase() : "";
  if (t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use") return "call";
  if (t === "toolresult" || t === "tool_result") return "result";
  return null;
}

/** tool-cards.ts:337-351 `isToolCallContentBlock`: a tool-call type, or a named item
 *  carrying arguments. */
export function isToolCallItem(item: Record<string, unknown>): boolean {
  return (
    contentType(item.type) === "call" ||
    (typeof item.name === "string" && (item.arguments != null || item.args != null || item.input != null))
  );
}

/** tool-cards.ts:239-246 `resolveToolName`. */
export function resolveToolName(item: Record<string, unknown>, message: Record<string, unknown>): string {
  return (
    (typeof item.name === "string" && item.name.trim()) ||
    (typeof message.toolName === "string" && message.toolName.trim()) ||
    (typeof message.tool_name === "string" && message.tool_name.trim()) ||
    "tool"
  );
}

/** tool-cards.ts:87-107 `extractToolText` — only whether a result has an output matters here. */
function hasToolText(item: Record<string, unknown>): boolean {
  if (typeof item.text === "string" || typeof item.content === "string") return true;
  return (
    Array.isArray(item.content) &&
    item.content.some((e) => e !== null && typeof e === "object" && typeof (e as { text?: unknown }).text === "string")
  );
}

/**
 * The call id of every tool item of a message's `content`, by content index — the cards
 * `extractToolCards` builds, in its own pairing order (tool-cards.ts:381-466). A card with
 * no id anywhere gets `${rowKey}#${name}:${index}` (:388, scoped by the row).
 */
export function toolItemCallIds(
  message: Record<string, unknown>,
  content: readonly unknown[],
  rowKey: string,
): Map<number, string> {
  type Card = { id: string; callId: string | undefined; name: string; output: boolean; paired: boolean; items: number[] };
  const cards: Card[] = [];
  for (let index = 0; index < content.length; index++) {
    const raw = content[index];
    const item = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (isToolCallItem(item)) {
      const callId = resolveToolCallId(item, message);
      const name = resolveToolName(item, message);
      cards.push({ id: callId ?? `${name}:${index}`, callId, name, output: false, paired: false, items: [index] });
      continue;
    }
    if (contentType(item.type) === "result") {
      const name = resolveToolName(item, message);
      const callId = resolveToolCallId(item, message);
      const cardId = callId ?? `${name}:${index}`;
      const existing =
        cards.find((card) => card.id === cardId) ??
        cards.find(
          // Same-name fallback belongs to legacy blocks missing an explicit identity.
          (card) => (!callId || !card.callId) && card.name === name && !card.output && !card.paired,
        );
      if (existing !== undefined) {
        existing.paired = true;
        existing.callId ??= callId;
        existing.output = hasToolText(item);
        existing.items.push(index);
        continue;
      }
      cards.push({ id: cardId, callId, name, output: hasToolText(item), paired: false, items: [index] });
    }
  }
  const out = new Map<number, string>();
  for (const card of cards) {
    const id = card.callId ?? `${rowKey}#${card.id}`;
    for (const index of card.items) out.set(index, id);
  }
  return out;
}
