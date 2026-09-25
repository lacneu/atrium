// What a question's SECRET answer must never become: a line in a diagnostic.
//
// The gateway broadcasts `question.resolved` WITH the answers, and a plain `isSecret`
// question's value travels in clear there (only a store-bound one is replaced by a
// marker upstream). The bridge's two frame diagnostics write whole frames: the dev
// capture (`OPENCLAW_CAPTURE_FRAMES`, promoted into the golden corpus, i.e. the
// repository) and the first-shape debug sample (`BRIDGE_DEBUG`). Both go through here.
//
// Values are replaced, never removed: the corpus keeps the SHAPE (how many values,
// under which question) and loses the content.

const REDACTED = "[redacted]";
const MAX_REMEMBERED = 256;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;

/** The question ids of a QuestionRecord whose answer is a secret — or `null` when the
 *  questions cannot ALL be read, which says nothing about which answer is a secret:
 *  every value is then hidden (fail closed, codex P2 ×2). */
function secretIdsOf(record: Obj): Set<string> | null {
  if (!Array.isArray(record.questions)) return null;
  const out = new Set<string>();
  for (const raw of record.questions) {
    const q = obj(raw);
    if (q === null || typeof q.questionId !== "string") return null;
    if (q.isSecret === true || obj(q.secretStore) !== null) out.add(q.questionId);
  }
  return out;
}

/** A copy of `{answers: {<id>: string[]}}` with the chosen ids' values replaced
 *  (every id when `only` is null). */
function redactAnswers(answers: unknown, only: Set<string> | null): unknown {
  const container = obj(answers);
  const map = container === null ? null : obj(container.answers);
  if (container === null || map === null) return answers;
  const next: Obj = {};
  for (const [id, values] of Object.entries(map)) {
    next[id] =
      (only === null || only.has(id)) && Array.isArray(values) ? values.map(() => REDACTED) : values;
  }
  return { ...container, answers: next };
}

function redactRecord(record: unknown): unknown {
  const r = obj(record);
  if (r === null || r.answers === undefined) return record;
  return { ...r, answers: redactAnswers(r.answers, secretIdsOf(r)) };
}

/**
 * STATELESS: every answer value of every question frame is replaced. For the debug
 * sample, which sees one frame per shape and knows nothing of the question it answers.
 */
export function redactAllQuestionAnswers(frame: unknown): unknown {
  const f = obj(frame);
  if (f === null) return frame;
  const p = obj(f.payload);
  if (p === null) return frame;
  if (f.type === "event" && f.event === "question.resolved" && p.answers !== undefined) {
    return { ...f, payload: { ...p, answers: redactAnswers(p.answers, null) } };
  }
  if (f.type === "res") return redactResult(f, p);
  return frame;
}

/** A response payload that carries answers: a record (`question.get`), a list of
 *  records (`question.list`), or a bare `{status, answers}` (`question.resolve`,
 *  `question.waitAnswer`) — the last one says nothing about which answer was secret. */
function redactResult(f: Obj, p: Obj): Obj {
  if (obj(p.question) !== null) return { ...f, payload: { ...p, question: redactRecord(p.question) } };
  if (Array.isArray(p.questions) && p.questions.some((q) => obj(q)?.answers !== undefined)) {
    return { ...f, payload: { ...p, questions: p.questions.map(redactRecord) } };
  }
  if (typeof p.status === "string" && obj(p.answers) !== null) {
    return { ...f, payload: { ...p, answers: redactAnswers(p.answers, null) } };
  }
  return f;
}

/**
 * PER CONNECTION, for the capture: a question announced on this socket is remembered,
 * so its resolution keeps the ordinary answers readable and hides only the secret
 * ones. A resolution for a question this socket never saw hides every value — fail
 * closed.
 */
export class SecretAnswerRedactor {
  private readonly secretIds = new Map<string, Set<string> | null>();

  redact(frame: unknown): unknown {
    const f = obj(frame);
    if (f === null) return frame;
    const p = obj(f.payload);
    if (p === null) return frame;
    if (f.type === "event" && f.event === "question.requested" && typeof p.id === "string") {
      this.secretIds.set(p.id, secretIdsOf(p));
      if (this.secretIds.size > MAX_REMEMBERED) {
        const oldest = this.secretIds.keys().next().value;
        if (oldest !== undefined) this.secretIds.delete(oldest);
      }
      return frame;
    }
    if (f.type === "event" && f.event === "question.resolved" && p.answers !== undefined) {
      // Unknown here, or announced with questions we could not all read: every value.
      const known = typeof p.id === "string" ? this.secretIds.get(p.id) : undefined;
      if (typeof p.id === "string") this.secretIds.delete(p.id);
      return { ...f, payload: { ...p, answers: redactAnswers(p.answers, known ?? null) } };
    }
    if (f.type === "res") return redactResult(f, p);
    return frame;
  }
}
