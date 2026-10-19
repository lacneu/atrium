// THE CLASS OF A REJECTED INGEST WRITE, without its content (0.101.2, prod 2026-10-18/19:
// ~67 `applyTranscript` rejections in 500 whose trace said only `handler_threw`, so a write
// conflict, a platform limit and a refused argument could not be told apart). The class is
// read from the Convex runtime's own error sentences; the message itself never leaves here.

export type IngestErrorClass = "occ_conflict" | "limit_exceeded" | "validator" | "other";

/** Convex's sentence for a mutation that lost its optimistic-concurrency retries. */
const OCC_RE = /changed while this mutation was being run|OptimisticConcurrencyControl/i;
/** Convex's transaction and value limits (reads, writes, bytes, sizes, array lengths). */
const LIMIT_RE = /too many (reads|documents|bytes|writes|function calls|scheduled)|too large|too long|exceeds? (the )?(maximum|limit)/i;
/** An argument or a stored value refused by a validator. */
const VALIDATOR_RE = /ArgumentValidationError|ReturnsValidationError|does not match (the )?validator|missing the required field|extra field|Validator error/i;

export function ingestErrorClass(err: unknown): IngestErrorClass {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (OCC_RE.test(msg)) return "occ_conflict";
  if (VALIDATOR_RE.test(msg)) return "validator";
  if (LIMIT_RE.test(msg)) return "limit_exceeded";
  return "other";
}

/** A chat named without being named: the first 16 hex of SHA-256 over its id — enough to
 *  tell whether rejections fall on one conversation or many, not to find it. */
export async function hashedChatRef(chatId: unknown): Promise<string | null> {
  if (typeof chatId !== "string" || chatId === "") return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chatId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
