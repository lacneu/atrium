// AGENT REQUESTS — what an agent asks a person while it works, and how that person
// answers.
//
// Three families reach Atrium from two providers, and every one of them BLOCKS the
// agent until someone answers or the provider's own deadline expires:
//
//   question    — OpenClaw `ask_user` (question.requested); Hermes `clarify.request`
//   approval    — OpenClaw exec / plugin / system-agent approvals; Hermes `approval.request`
//   credential  — Hermes `secret.request` / `sudo.request`; an OpenClaw secret question
//
// This module is the CONVEX side of the contract: the stored shape, the bounds applied
// at the bridge boundary (the body is network input, not a promise), and the answer
// rules. The answer rules mirror the gateway's own (OpenClaw
// `src/gateway/question-manager.ts` validateAnswers at v2026.9.5) so a malformed answer
// is refused here, in the user's language, instead of by the gateway after a round trip.

import { v, type Infer } from "convex/values";

export const AGENT_REQUEST_SOURCES = [
  "openclaw.ask_user",
  "openclaw.exec",
  "openclaw.plugin",
  "openclaw.system_agent",
  "openclaw.secret",
  "hermes.clarify",
  "hermes.approval",
  "hermes.secret",
  "hermes.sudo",
] as const;
export type AgentRequestSource = (typeof AGENT_REQUEST_SOURCES)[number];

export const agentRequestSourceValidator = v.union(
  v.literal("openclaw.ask_user"),
  v.literal("openclaw.exec"),
  v.literal("openclaw.plugin"),
  v.literal("openclaw.system_agent"),
  v.literal("openclaw.secret"),
  v.literal("hermes.clarify"),
  v.literal("hermes.approval"),
  v.literal("hermes.secret"),
  v.literal("hermes.sudo"),
);

export const agentRequestKindValidator = v.union(
  v.literal("question"),
  v.literal("approval"),
  v.literal("credential"),
);
export type AgentRequestKind = Infer<typeof agentRequestKindValidator>;

/** The family a source belongs to — decided HERE, never taken from the bridge body. */
export function kindForSource(source: AgentRequestSource): AgentRequestKind {
  switch (source) {
    case "openclaw.ask_user":
    case "hermes.clarify":
      return "question";
    case "openclaw.exec":
    case "openclaw.plugin":
    case "openclaw.system_agent":
    case "hermes.approval":
      return "approval";
    case "openclaw.secret":
    case "hermes.secret":
    case "hermes.sudo":
      return "credential";
  }
}

export function providerForSource(
  source: AgentRequestSource,
): "openclaw" | "hermes" {
  return source.startsWith("openclaw.") ? "openclaw" : "hermes";
}

/**
 * Lifecycle. `submitting` is Atrium's own state between the user's click and the
 * gateway's receipt; every other value is the provider's verdict in our words.
 * `failed` is reserved for an answer the provider REFUSED (not a transport error —
 * those return the row to `pending` so the person can try again).
 */
export const agentRequestStatusValidator = v.union(
  v.literal("pending"),
  v.literal("submitting"),
  v.literal("answered"),
  v.literal("allowed"),
  v.literal("denied"),
  v.literal("expired"),
  v.literal("cancelled"),
  v.literal("failed"),
);
export type AgentRequestStatus = Infer<typeof agentRequestStatusValidator>;

export const OPEN_STATUSES: ReadonlySet<AgentRequestStatus> = new Set([
  "pending",
  "submitting",
]);

export function isOpenStatus(status: AgentRequestStatus): boolean {
  return OPEN_STATUSES.has(status);
}

/**
 * Reviewer decisions, in Atrium's vocabulary. OpenClaw offers `allow-once`,
 * `allow-always`, `deny`; Hermes adds a SESSION scope (`once | session | always |
 * deny`). The bridge translates both ways — this is the one list the UI and the
 * mutation agree on.
 */
export const approvalDecisionValidator = v.union(
  v.literal("allow-once"),
  v.literal("allow-session"),
  v.literal("allow-always"),
  v.literal("deny"),
);
export type ApprovalDecision = Infer<typeof approvalDecisionValidator>;

export const agentRequestQuestionValidator = v.object({
  id: v.string(),
  header: v.optional(v.string()),
  text: v.string(),
  options: v.array(
    v.object({ label: v.string(), description: v.optional(v.string()) }),
  ),
  multiSelect: v.boolean(),
  /** Free text is accepted besides the options (OpenClaw `isOther`; a question with
   *  no options is free text by construction). */
  allowOther: v.boolean(),
  /** The answer is a secret: typed masked, never stored. */
  secret: v.boolean(),
  /** A page the person may open to find the answer — opening it answers nothing. */
  url: v.optional(v.string()),
  /** Where the gateway will keep a secret answer: a NAME and the hosts it may reach.
   *  Shown before the person types — never a value. */
  store: v.optional(
    v.object({
      name: v.string(),
      allowedHosts: v.optional(v.array(v.string())),
      reason: v.optional(v.string()),
      replacesSinceMs: v.optional(v.number()),
    }),
  ),
});
export type AgentRequestQuestion = Infer<typeof agentRequestQuestionValidator>;

export const agentRequestApprovalValidator = v.object({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  detail: v.optional(v.string()),
  /** The command, as the provider REDACTED it for review (never the raw one). */
  command: v.optional(v.string()),
  /** Something shown was too long to show whole: only `deny` is offered, since the
   *  person cannot see all of what they would authorise. */
  clipped: v.optional(v.boolean()),
  warning: v.optional(v.string()),
  host: v.optional(v.string()),
  /** The node an exec runs on — which machine the allow reaches. */
  nodeId: v.optional(v.string()),
  severity: v.optional(
    v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
  ),
  toolName: v.optional(v.string()),
  pluginId: v.optional(v.string()),
  /** Owner-declared blast radius, flattened to what the card shows. */
  scope: v.optional(
    v.object({
      kind: v.union(
        v.literal("message-send"),
        v.literal("payment"),
        v.literal("external-post"),
        v.literal("standing-grant"),
      ),
      summary: v.string(),
      /** A message going outside the organisation (MessageSendApprovalScope.audience). */
      external: v.optional(v.boolean()),
      /** Lifetime of an allow-always standing grant, in days. */
      grantDays: v.optional(v.number()),
    }),
  ),
  decisions: v.array(approvalDecisionValidator),
});
export type AgentRequestApproval = Infer<typeof agentRequestApprovalValidator>;

export const agentRequestCredentialValidator = v.object({
  prompt: v.optional(v.string()),
  /** The variable the secret will be stored under (Hermes `env_var`). A NAME only. */
  envVar: v.optional(v.string()),
  /** The command a sudo password unlocks (Hermes 0.21, redacted upstream). */
  command: v.optional(v.string()),
  /** That command was too long to show whole: the password cannot be given here. */
  clipped: v.optional(v.boolean()),
  /** A sudo prompt that names NO command (Hermes <= 0.19 sends none): what the password
   *  unlocks cannot be reviewed, so it cannot be given here either. */
  commandMissing: v.optional(v.boolean()),
  mode: v.union(v.literal("secret"), v.literal("password")),
});
export type AgentRequestCredential = Infer<
  typeof agentRequestCredentialValidator
>;

export const agentRequestAnswerValidator = v.object({
  id: v.string(),
  values: v.array(v.string()),
});
export type AgentRequestAnswer = Infer<typeof agentRequestAnswerValidator>;

// ── Bounds (the bridge body is network input) ──────────────────────────────────

/** Hermes batches up to five clarify questions (tools/clarify_tool.py MAX_QUESTIONS);
 *  OpenClaw asks fewer. */
export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 4;
const MAX_HEADER = 40;
const MAX_QUESTION_TEXT = 4000;
/** An option label is sent back verbatim as the answer, so it is bounded by what an
 *  answer may carry, never clipped (see boundQuestions). */
const MAX_OPTION_LABEL = 8000;
const MAX_OPTION_DESCRIPTION = 600;
const MAX_URL = 2048;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const MAX_DETAIL = 16_384;
/** Above OpenClaw's own display bound (16 KiB after redaction, plus its
 *  `…[truncated]` marker — exec-approval-text-sanitize.ts EXEC_APPROVAL_MAX_OUTPUT), so
 *  a command the gateway shows whole is never cut here: a cut one is deny-only. */
const MAX_COMMAND = 16_384 + 64;
const MAX_SHORT = 200;
export const MAX_ANSWER_CHARS = 8000;
/** The most values one answer may carry (the bridge refuses more, never cuts). */
export const MAX_ANSWER_VALUES = 8;
const QUESTION_ID_RE = /^[a-z][a-z0-9_]*$/;

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Only http(s) links are ever rendered as something to open. */
function safeUrl(value: unknown): string | undefined {
  const url = clip(value, MAX_URL);
  if (url === undefined) return undefined;
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : undefined;
}

/**
 * Bound and re-shape the questions a bridge sent. Returns null when nothing usable
 * is left — a question row with no question is not something to show anyone.
 */
export function boundQuestions(raw: unknown): AgentRequestQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  // REFUSED past the bound, never cut: a batch is answered as a whole, keyed by question,
  // and a set missing its tail is not the set the agent asked.
  if (raw.length > MAX_QUESTIONS) return null;
  const out: AgentRequestQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const id = typeof q.id === "string" && QUESTION_ID_RE.test(q.id) ? q.id : null;
    const text = clip(q.text, MAX_QUESTION_TEXT);
    if (id === null || text === undefined || seen.has(id)) continue;
    seen.add(id);
    const options: AgentRequestQuestion["options"] = [];
    const rawOptionCount = Array.isArray(q.options) ? q.options.length : 0;
    if (Array.isArray(q.options)) {
      for (const o of q.options.slice(0, MAX_OPTIONS)) {
        if (typeof o !== "object" || o === null) continue;
        // A label is also the ANSWER VALUE: the gateway compares it byte for byte
        // (question-manager.ts). Never shortened — an option too long to send is
        // dropped instead of being offered as something the gateway will refuse.
        const rawLabel = (o as Record<string, unknown>).label;
        if (typeof rawLabel !== "string" || rawLabel.trim() === "") continue;
        if (rawLabel.length > MAX_OPTION_LABEL) continue;
        const label = rawLabel;
        const description = clip(
          (o as Record<string, unknown>).description,
          MAX_OPTION_DESCRIPTION,
        );
        options.push(description === undefined ? { label } : { label, description });
      }
    }
    // A CLOSED question left with no option it can show cannot be answered from here: shown
    // with no options it would read as free text, which the gateway refuses (codex P3).
    // Unshowable as asked → the whole request is not recorded, rather than invented.
    if (rawOptionCount > 0 && options.length === 0 && q.allowOther !== true) return null;
    const header = clip(q.header, MAX_HEADER);
    const url = safeUrl(q.url);
    const bound = boundStore(q.store);
    // A binding we cannot show truthfully makes the WHOLE request unshowable: without
    // it the person would hand over a secret without seeing where it goes.
    if (!bound.ok) return null;
    const store = bound.store;
    out.push({
      id,
      ...(header !== undefined ? { header } : {}),
      text,
      options,
      multiSelect: q.multiSelect === true,
      // No options AT ALL (as asked, not as kept) means free text; a closed question
      // whose options were dropped stays closed — the gateway would refuse free text.
      allowOther: rawOptionCount === 0 || q.allowOther === true,
      // A store-bound question is answered with the value to store: a secret.
      secret: q.secret === true || store !== undefined,
      ...(url !== undefined ? { url } : {}),
      ...(store !== undefined ? { store } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

const STORE_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Upstream's own bound (QuestionSecretStoreAllowedHostsSchema maxItems). */
const MAX_STORE_HOSTS = 128;
const MAX_HOST = 253;
const MAX_STORE_REASON = 200;

/** The gateway's secret-store binding, bounded to what the card shows. */
function boundStore(
  raw: unknown,
): { ok: true; store: AgentRequestQuestion["store"] } | { ok: false } {
  if (raw === undefined) return { ok: true, store: undefined };
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const s = raw as Record<string, unknown>;
  const name = typeof s.name === "string" && STORE_NAME_RE.test(s.name) ? s.name : null;
  if (name === null) return { ok: false };
  // EVERY host, exactly as the gateway will use them: it applies the binding's full
  // list when the answer names none (server-methods/question.ts). Showing a subset —
  // or a clipped name — would hand a secret to a host the person never saw (codex P1).
  let hosts: string[] = [];
  if (s.allowedHosts !== undefined) {
    if (!Array.isArray(s.allowedHosts) || s.allowedHosts.length > MAX_STORE_HOSTS) return { ok: false };
    for (const h of s.allowedHosts) {
      if (typeof h !== "string" || h === "" || h.length > MAX_HOST || h.trim() !== h) return { ok: false };
      hosts = [...hosts, h];
    }
  }
  const reason = clip(s.reason, MAX_STORE_REASON);
  const since =
    typeof s.replacesSinceMs === "number" && Number.isFinite(s.replacesSinceMs) && s.replacesSinceMs >= 0
      ? s.replacesSinceMs
      : undefined;
  return {
    ok: true,
    store: {
      name,
      ...(hosts.length > 0 ? { allowedHosts: hosts } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(since !== undefined ? { replacesSinceMs: since } : {}),
    },
  };
}

const DECISIONS = new Set(["allow-once", "allow-session", "allow-always", "deny"]);
const SCOPE_KINDS = new Set([
  "message-send",
  "payment",
  "external-post",
  "standing-grant",
]);

/**
 * Bound an approval presentation. `deny` is ALWAYS offered — the providers make the
 * same promise (OpenClaw `ApprovalAllowedDecisionsSchema` contains "deny"), and a
 * request a person cannot refuse is not one Atrium will show.
 */
export function boundApproval(raw: unknown): AgentRequestApproval | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const decisions: ApprovalDecision[] = [];
  if (Array.isArray(a.decisions)) {
    for (const d of a.decisions) {
      if (typeof d === "string" && DECISIONS.has(d) && !decisions.includes(d as ApprovalDecision)) {
        decisions.push(d as ApprovalDecision);
      }
    }
  }
  if (!decisions.includes("deny")) decisions.push("deny");
  const severity =
    a.severity === "info" || a.severity === "warning" || a.severity === "critical"
      ? a.severity
      : undefined;
  // Whatever the card cannot show WHOLE, the person cannot approve: OpenClaw's
  // `commandText` has no length bound (approvals.ts NonEmptyString), and an allow sent
  // under a cut command authorises the part nobody saw (codex P1).
  let clipped = false;
  const shown = (value: unknown, max: number): string | undefined => {
    const out = clip(value, max);
    if (out !== undefined && typeof value === "string" && value.trim().length > max) clipped = true;
    return out;
  };
  let scope: AgentRequestApproval["scope"];
  if (typeof a.scope === "object" && a.scope !== null) {
    const s = a.scope as Record<string, unknown>;
    const summary = shown(s.summary, MAX_DESCRIPTION);
    if (typeof s.kind === "string" && SCOPE_KINDS.has(s.kind) && summary !== undefined) {
      const grantDays =
        typeof s.grantDays === "number" && Number.isInteger(s.grantDays) && s.grantDays >= 1 && s.grantDays <= 3650
          ? s.grantDays
          : undefined;
      scope = {
        kind: s.kind as NonNullable<AgentRequestApproval["scope"]>["kind"],
        summary,
        ...(s.kind === "message-send" && s.external === true ? { external: true } : {}),
        ...(s.kind === "standing-grant" && grantDays !== undefined ? { grantDays } : {}),
      };
    }
  }
  const title = shown(a.title, MAX_TITLE);
  const description = shown(a.description, MAX_DESCRIPTION);
  const detail = shown(a.detail, MAX_DETAIL);
  const command = shown(a.command, MAX_COMMAND);
  const warning = shown(a.warning, MAX_DESCRIPTION);
  // EVERY shown field, the short ones included: a tool or plugin name cut before its
  // end is as unseen as a cut command (codex P1).
  const host = shown(a.host, MAX_SHORT);
  const nodeId = shown(a.nodeId, MAX_SHORT);
  const toolName = shown(a.toolName, MAX_SHORT);
  const pluginId = shown(a.pluginId, MAX_SHORT);
  const out: AgentRequestApproval = clipped
    ? { decisions: ["deny"], clipped: true }
    : { decisions };
  if (title !== undefined) out.title = title;
  if (description !== undefined) out.description = description;
  if (detail !== undefined) out.detail = detail;
  if (command !== undefined) out.command = command;
  if (warning !== undefined) out.warning = warning;
  if (host !== undefined) out.host = host;
  if (nodeId !== undefined) out.nodeId = nodeId;
  if (severity !== undefined) out.severity = severity;
  if (toolName !== undefined) out.toolName = toolName;
  if (pluginId !== undefined) out.pluginId = pluginId;
  if (scope !== undefined) out.scope = scope;
  // An approval that says nothing about WHAT it authorises is not answerable.
  if (
    out.title === undefined &&
    out.description === undefined &&
    out.command === undefined
  ) {
    return null;
  }
  return out;
}

export function boundCredential(
  raw: unknown,
  source: AgentRequestSource,
): AgentRequestCredential {
  const c = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const prompt = clip(c.prompt, MAX_DESCRIPTION);
  const envVar =
    typeof c.envVar === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c.envVar)
      ? c.envVar
      : undefined;
  const command = source === "hermes.sudo" ? clip(c.command, MAX_COMMAND) : undefined;
  // Same rule as an approval's: a password that unlocks a command nobody could see whole
  // is not one to give from here (codex P1).
  const clipped =
    command !== undefined && typeof c.command === "string" && c.command.trim().length > MAX_COMMAND;
  return {
    mode: source === "hermes.sudo" ? "password" : "secret",
    ...(prompt !== undefined ? { prompt } : {}),
    ...(envVar !== undefined ? { envVar } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(clipped ? { clipped: true } : {}),
    ...(source === "hermes.sudo" && command === undefined ? { commandMissing: true } : {}),
  };
}

// ── Answers ────────────────────────────────────────────────────────────────────

export type AnswerRefusal =
  | { code: "unknown_question"; questionId: string }
  | { code: "missing_answer"; questionId: string }
  | { code: "empty_answer"; questionId: string }
  | { code: "multiple_not_allowed"; questionId: string }
  | { code: "unknown_option"; questionId: string }
  | { code: "too_long"; questionId: string }
  | { code: "too_many"; questionId: string };

/**
 * Validate answers against the stored questions and return them in CANONICAL form:
 * every question answered, option labels restored exactly (the gateway compares
 * labels verbatim), free text trimmed. Mirrors OpenClaw's own rules so the gateway
 * never has to refuse what Atrium let through.
 */
export function validateAnswers(
  questions: ReadonlyArray<AgentRequestQuestion>,
  answers: ReadonlyArray<AgentRequestAnswer>,
): { ok: true; answers: AgentRequestAnswer[] } | { ok: false; refusal: AnswerRefusal } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const a of answers) {
    if (!byId.has(a.id)) return { ok: false, refusal: { code: "unknown_question", questionId: a.id } };
  }
  const canonical: AgentRequestAnswer[] = [];
  for (const q of questions) {
    const given = answers.find((a) => a.id === q.id);
    if (given === undefined || given.values.length === 0) {
      return { ok: false, refusal: { code: "missing_answer", questionId: q.id } };
    }
    if (given.values.some((value) => (q.secret ? value.length === 0 : value.trim() === ""))) {
      return { ok: false, refusal: { code: "empty_answer", questionId: q.id } };
    }
    if (given.values.some((value) => value.length > MAX_ANSWER_CHARS)) {
      return { ok: false, refusal: { code: "too_long", questionId: q.id } };
    }
    // Bounded, never cut: the bridge relays at most this many, and a stored answer the agent
    // did not receive in full would claim an answer nobody gave (codex P3).
    if (given.values.length > MAX_ANSWER_VALUES) {
      return { ok: false, refusal: { code: "too_many", questionId: q.id } };
    }
    if (!q.multiSelect && given.values.length > 1) {
      return { ok: false, refusal: { code: "multiple_not_allowed", questionId: q.id } };
    }
    const values = given.values.map((value) => {
      if (q.secret) return value;
      const match = q.options.find((o) => o.label.trim() === value.trim());
      return match !== undefined ? match.label : value.trim();
    });
    if (
      q.options.length > 0 &&
      !q.allowOther &&
      values.some((value) => !q.options.some((o) => o.label === value))
    ) {
      return { ok: false, refusal: { code: "unknown_option", questionId: q.id } };
    }
    canonical.push({ id: q.id, values: [...new Set(values)] });
  }
  return { ok: true, answers: canonical };
}

/**
 * What makes a question set THE SAME request for answering: ids, secret flags, multi-select
 * flags, option labels (verbatim — they are the answer values), where a secret goes (the
 * store's name and hosts) and everything the card SHOWS (header, text, option descriptions,
 * link, store reason — the same id asking "delete production?" under the words "delete
 * staging?" is another question, codex P1). Shown text enters through `clip`/`safeUrl`,
 * which are idempotent, so a row already bounded keeps its shape. Mirrors
 * bridge/src/core/agent-requests.ts `questionShape` exactly.
 */
export function questionShape(questions: unknown): string | null {
  if (!Array.isArray(questions)) return null;
  const shape: unknown[] = [];
  for (const q of questions) {
    if (typeof q !== "object" || q === null) return null;
    const r = q as {
      id?: unknown;
      secret?: unknown;
      multiSelect?: unknown;
      options?: unknown;
      store?: { name?: unknown; allowedHosts?: unknown; reason?: unknown };
      header?: unknown;
      text?: unknown;
      url?: unknown;
    };
    if (typeof r.id !== "string" || !Array.isArray(r.options)) return null;
    const options = r.options.map((o) =>
      typeof o === "object" && o !== null ? (o as { label?: unknown; description?: unknown }) : {},
    );
    shape.push([
      r.id,
      r.secret === true,
      r.multiSelect === true,
      options.map((o) => o.label ?? null),
      r.store !== undefined && r.store !== null
        ? [r.store.name, Array.isArray(r.store.allowedHosts) ? r.store.allowedHosts : []]
        : null,
      [
        clip(r.header, MAX_HEADER) ?? null,
        clip(r.text, MAX_QUESTION_TEXT) ?? null,
        options.map((o) => clip(o.description, MAX_OPTION_DESCRIPTION) ?? null),
        safeUrl(r.url) ?? null,
        clip(r.store?.reason, MAX_STORE_REASON) ?? null,
      ],
    ]);
  }
  return JSON.stringify(shape);
}

/** What a mutation sees in place of a secret answer: the ACTION holds the value, and
 *  no mutation argument or return value ever carries it (codex P1). */
export const SECRET_ANSWER_PLACEHOLDER = "\u0000atrium-secret-withheld";

/**
 * Take the secret answers out before a mutation sees them. Validated here, since the
 * mutation only sees the placeholder: one non-empty value, within the answer bound.
 */
export function withholdSecretAnswers(
  secretIds: ReadonlySet<string>,
  answers: ReadonlyArray<AgentRequestAnswer>,
):
  | { ok: true; forMutation: AgentRequestAnswer[]; held: Map<string, string[]> }
  | { ok: false; refusal: AnswerRefusal } {
  const held = new Map<string, string[]>();
  const forMutation: AgentRequestAnswer[] = [];
  for (const a of answers) {
    if (!secretIds.has(a.id)) {
      forMutation.push(a);
      continue;
    }
    if (a.values.length === 0 || a.values.some((value) => value.length === 0)) {
      return { ok: false, refusal: { code: "empty_answer", questionId: a.id } };
    }
    if (a.values.length > 1) {
      return { ok: false, refusal: { code: "multiple_not_allowed", questionId: a.id } };
    }
    if (a.values.some((value) => value.length > MAX_ANSWER_CHARS)) {
      return { ok: false, refusal: { code: "too_long", questionId: a.id } };
    }
    held.set(a.id, [...a.values]);
    forMutation.push({ id: a.id, values: [SECRET_ANSWER_PLACEHOLDER] });
  }
  return { ok: true, forMutation, held };
}

/** What a stored answer may keep: a secret question's value NEVER reaches the table. */
export function storableAnswers(
  questions: ReadonlyArray<AgentRequestQuestion>,
  answers: ReadonlyArray<AgentRequestAnswer>,
): AgentRequestAnswer[] {
  const secret = new Set(questions.filter((q) => q.secret).map((q) => q.id));
  return answers.map((a) => (secret.has(a.id) ? { id: a.id, values: [] } : a));
}

/** The terminal status an approval decision produces. */
export function statusForDecision(decision: ApprovalDecision): AgentRequestStatus {
  return decision === "deny" ? "denied" : "allowed";
}

/** How long after its own deadline an open request is swept as expired. The
 *  provider's `*.resolved` / `*.expire` normally lands first; this is the net for
 *  a bridge that restarted or a socket that closed. */
export const EXPIRY_SWEEP_GRACE_MS = 60_000;

/** A deadline we cannot read is bounded, never infinite. */
export const DEFAULT_REQUEST_TTL_MS = 15 * 60_000;
export const MAX_REQUEST_TTL_MS = 24 * 60 * 60_000;
