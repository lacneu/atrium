import { describe, expect, it } from "vitest";
import {
  answersFromDrafts,
  blockedBy,
  deadlineShown,
  severalHermesApprovals,
  dockOrder,
  emptyDraft,
  oneLiner,
  outcomeOf,
  panelSections,
  remaining,
  requestTone,
  setOther,
  toggleOption,
  type AgentRequestView,
} from "./agentRequestsView";

const NOW = 1_000_000;

function row(over: Partial<AgentRequestView>): AgentRequestView {
  return {
    _id: "r1",
    messageId: "m1",
    source: "openclaw.ask_user",
    kind: "question",
    agentId: "denis",
    status: "pending",
    createdAt: NOW - 1000,
    expiresAt: NOW + 900_000,
    resolvedAt: null,
    resolvedElsewhere: false,
    answeredByMe: false,
    seq: null,
    queueKey: "hermes-1\u0000s",
    answerById: false,
    questions: [{ id: "format", text: "Quel format ?", options: [{ label: "PDF" }, { label: "Word" }], multiSelect: false, allowOther: false, secret: false }],
    approval: null,
    credential: null,
    answers: null,
    decision: null,
    failureCode: null,
    canAnswer: true,
    ...over,
  };
}

describe("tone", () => {
  it("a critical approval stands apart; a secret question reads as a credential", () => {
    expect(requestTone(row({ kind: "approval", approval: { decisions: ["deny"], severity: "critical" } }))).toBe("critical");
    expect(requestTone(row({ kind: "approval", approval: { decisions: ["deny"] } }))).toBe("approval");
    expect(requestTone(row({ questions: [{ id: "t", text: "Jeton", options: [], multiSelect: false, allowOther: true, secret: true }] }))).toBe("credential");
    expect(requestTone(row({ kind: "credential", questions: null, credential: { mode: "password" } }))).toBe("credential");
  });
});

describe("deadline", () => {
  it("a Hermes approval shows no countdown — its timeout is the operator's, in no payload", () => {
    expect(deadlineShown({ source: "hermes.approval" })).toBe(false);
    expect(deadlineShown({ source: "openclaw.exec" })).toBe(true);
    expect(deadlineShown({ source: "hermes.clarify" })).toBe(true);
  });
});

describe("time left", () => {
  it("reads in the coarsest honest unit, urgent near the end", () => {
    expect(remaining(NOW + 30_000, NOW)).toEqual({ unit: "seconds", value: 30, urgent: true });
    expect(remaining(NOW + 14 * 60_000, NOW)).toEqual({ unit: "minutes", value: 14, urgent: false });
    expect(remaining(NOW + 90_000, NOW)).toEqual({ unit: "minutes", value: 2, urgent: true });
    expect(remaining(NOW - 1, NOW).unit).toBe("expired");
  });
});

describe("drafts", () => {
  const single = { multiSelect: false };
  const multi = { multiSelect: true };

  it("a single-choice question keeps ONE answer: picking replaces, typing clears the pick", () => {
    let d = toggleOption(single, emptyDraft(), "PDF");
    d = toggleOption(single, d, "Word");
    expect(d.selected).toEqual(["Word"]);
    d = setOther(single, d, "Markdown");
    expect(d).toEqual({ selected: [], other: "Markdown" });
  });

  it("a multi-choice question adds and removes", () => {
    let d = toggleOption(multi, emptyDraft(), "PDF");
    d = toggleOption(multi, d, "Word");
    d = toggleOption(multi, d, "PDF");
    expect(d.selected).toEqual(["Word"]);
  });

  it("the answer is refused before the round trip when a question is left blank", () => {
    const qs = row({}).questions!;
    expect(answersFromDrafts(qs, {})).toEqual({ ok: false, problem: { code: "missing", questionId: "format" } });
    expect(answersFromDrafts(qs, { format: { selected: ["PDF"], other: "" } })).toEqual({
      ok: true,
      answers: [{ id: "format", values: ["PDF"] }],
    });
  });

  it("free text only counts where the question accepts it", () => {
    const qs = row({}).questions!; // options, no "other"
    expect(answersFromDrafts(qs, { format: { selected: [], other: "Markdown" } }).ok).toBe(false);
    const open = [{ ...qs[0]!, allowOther: true }];
    expect(answersFromDrafts(open, { format: { selected: [], other: " Markdown " } })).toEqual({
      ok: true,
      answers: [{ id: "format", values: ["Markdown"] }],
    });
  });

  it("a secret value is kept byte for byte (whitespace included)", () => {
    const qs = [{ id: "t", text: "Jeton", options: [], multiSelect: false, allowOther: true, secret: true }];
    expect(answersFromDrafts(qs, { t: { selected: [], other: " abc " } })).toEqual({ ok: true, answers: [{ id: "t", values: [" abc "] }] });
  });
});

describe("lists", () => {
  it("the dock shows what is still waiting, soonest deadline first", () => {
    const rows = [
      row({ _id: "late", expiresAt: NOW + 600_000 }),
      row({ _id: "soon", expiresAt: NOW + 60_000 }),
      row({ _id: "done", status: "answered" }),
      row({ _id: "past", expiresAt: NOW - 1 }),
    ];
    expect(dockOrder(rows, NOW).map((r) => r._id)).toEqual(["soon", "late"]);
    const { waiting, history } = panelSections(rows, NOW);
    expect(waiting.map((r) => r._id)).toEqual(["soon", "late"]);
    expect(history.map((r) => r._id).sort()).toEqual(["done", "past"]);
  });

  it("a Hermes approval waits for the older one of its session", () => {
    const a = row({ _id: "a", source: "hermes.approval", kind: "approval", seq: 1 });
    const b = row({ _id: "b", source: "hermes.approval", kind: "approval", seq: 2 });
    expect(blockedBy(b, [a, b])?._id).toBe("a");
    expect(blockedBy(a, [a, b])).toBeNull();
    // Past its deadline but not yet swept, it still heads Convex's queue: still blocks.
    expect(blockedBy(b, [{ ...a, expiresAt: NOW - 1 }, b])?._id).toBe("a");
    // An earlier answer still in flight blocks as much as one not given yet.
    expect(blockedBy(b, [{ ...a, status: "submitting" }, b])?._id).toBe("a");
    // OpenClaw approvals are addressed by id: no order to respect.
    expect(blockedBy({ ...b, source: "openclaw.exec" }, [a, b])).toBeNull();
    // Two waiting in one Hermes session: neither is decidable from Atrium.
    expect(severalHermesApprovals(a, [a, b])).toBe(true);
    expect(severalHermesApprovals(a, [a, { ...b, status: "denied" }])).toBe(false);
    expect(severalHermesApprovals({ ...a, source: "openclaw.exec" }, [a, b])).toBe(false);
  });

  it("a request answered BY ID (Hermes server→client) is bound by no order and shows no invented countdown", () => {
    const a = row({ _id: "a", source: "hermes.approval", kind: "approval", seq: 1, answerById: true });
    const b = row({ _id: "b", source: "hermes.approval", kind: "approval", seq: 2, answerById: true });
    expect(blockedBy(b, [a, b])).toBeNull();
    expect(severalHermesApprovals(a, [a, b])).toBe(false);
    // …even beside an earlier one of the old, queue-addressed kind.
    const legacy = row({ _id: "old", source: "hermes.approval", kind: "approval", seq: 0, answerById: false });
    expect(blockedBy(b, [legacy, b])).toBeNull();
    expect(severalHermesApprovals(b, [legacy, b])).toBe(false);
    // …nor does a by-id one make a queue-addressed one look "several" (codex, 0.21.5 pass 1).
    expect(severalHermesApprovals(legacy, [legacy, b])).toBe(false);
    expect(blockedBy({ ...legacy, seq: 3 }, [b, { ...legacy, seq: 3 }])).toBeNull();
    expect(deadlineShown({ source: "hermes.clarify", answerById: true })).toBe(false);
    expect(deadlineShown({ source: "hermes.clarify", answerById: false })).toBe(true);
  });

  it("…per QUEUE: another gateway's approval with the same session id blocks nothing (codex P2, pass 27)", () => {
    const a = row({ _id: "a", source: "hermes.approval", kind: "approval", seq: 1, queueKey: "other\u0000s" });
    const b = row({ _id: "b", source: "hermes.approval", kind: "approval", seq: 2 });
    expect(blockedBy(b, [a, b])).toBeNull();
    expect(severalHermesApprovals(b, [a, b])).toBe(false);
  });
});

describe("outcomes", () => {
  it("names who decided, and what", () => {
    expect(outcomeOf({ status: "allowed", decision: "allow-always", resolvedElsewhere: false, answeredByMe: true, expiresAt: NOW }, NOW)).toBe("allowed_always");
    expect(outcomeOf({ status: "allowed", decision: null, resolvedElsewhere: true, answeredByMe: false, expiresAt: NOW }, NOW)).toBe("allowed_elsewhere");
    expect(outcomeOf({ status: "cancelled", decision: null, resolvedElsewhere: false, answeredByMe: true, expiresAt: NOW }, NOW)).toBe("skipped");
    expect(outcomeOf({ status: "cancelled", decision: null, resolvedElsewhere: false, answeredByMe: false, expiresAt: NOW }, NOW)).toBe("cancelled");
    expect(outcomeOf({ status: "pending", decision: null, resolvedElsewhere: false, answeredByMe: false, expiresAt: NOW + 1 }, NOW)).toBeNull();
    // The sweep has not run yet: the deadline alone says it.
    expect(outcomeOf({ status: "pending", decision: null, resolvedElsewhere: false, answeredByMe: false, expiresAt: NOW }, NOW)).toBe("expired");
  });

  it("the folded line says what was asked", () => {
    expect(oneLiner(row({}))).toBe("Quel format ?");
    expect(oneLiner(row({ kind: "approval", questions: null, approval: { command: "rm -rf build", decisions: ["deny"] } }))).toBe("rm -rf build");
  });
});
