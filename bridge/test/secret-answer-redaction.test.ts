// A question's secret answer never reaches a frame diagnostic (the dev capture that
// feeds the golden corpus, the debug first-shape sample). Frames are the ones the
// 2026.9.5 bench captured (agent-request-question), with a secret question added.
import { describe, expect, it } from "vitest";
import {
  SecretAnswerRedactor,
  redactAllQuestionAnswers,
} from "../src/core/secret-answer-redaction.js";
import { captureLine, clip } from "../src/providers/openclaw/openclaw-client.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { vi } from "vitest";

const requested = (questions: unknown[]) => ({
  type: "event",
  event: "question.requested",
  payload: { id: "ask_1", questions, sessionKey: "agent:alice:atrium:chat:u:c1", status: "pending", createdAtMs: 1, expiresAtMs: 2 },
});
const resolved = (answers: Record<string, string[]>, id = "ask_1") => ({
  type: "event",
  event: "question.resolved",
  payload: { id, status: "answered", answers: { answers } },
});
const COULEUR = { questionId: "couleur", header: "Couleur", question: "Quelle couleur ?", options: [{ label: "ROUGE" }, { label: "BLEU" }], isOther: true };
const TOKEN = { questionId: "token", header: "Jeton", question: "Jeton ?", options: [], isSecret: true };
const STORED = { questionId: "key", header: "Clé", question: "Clé ?", options: [], secretStore: { name: "API_KEY", kind: "secret" } };

describe("the capture keeps what is ordinary and hides what is secret", () => {
  it("a question announced on this socket: only its secret answers are hidden", () => {
    const r = new SecretAnswerRedactor();
    r.redact(requested([COULEUR, TOKEN, STORED]));
    const out = r.redact(resolved({ couleur: ["BLEU"], token: ["sk-live-123"], key: ["s3cr3t"] })) as never;
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
    expect((out as { payload: { answers: { answers: Record<string, string[]> } } }).payload.answers.answers).toEqual({
      couleur: ["BLEU"],
      token: ["[redacted]"],
      key: ["[redacted]"],
    });
  });

  it("a resolution for a question this socket never saw hides EVERY value (fail closed)", () => {
    const out = new SecretAnswerRedactor().redact(resolved({ couleur: ["BLEU"], token: ["sk-live-123"] }, "ask_unknown"));
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
    expect(JSON.stringify(out)).not.toContain("BLEU");
  });

  it("records returned by question.get / question.list carry their own questions", () => {
    const record = { ...requested([COULEUR, TOKEN]).payload, status: "answered", answers: { answers: { couleur: ["ROUGE"], token: ["sk-live-123"] } } };
    const r = new SecretAnswerRedactor();
    const got = JSON.stringify(r.redact({ type: "res", id: "1", ok: true, payload: { question: record } }));
    const list = JSON.stringify(r.redact({ type: "res", id: "2", ok: true, payload: { questions: [record] } }));
    for (const s of [got, list]) {
      expect(s).not.toContain("sk-live-123");
      expect(s).toContain("ROUGE");
    }
  });

  it("a questions list with ONE unreadable entry hides every answer too", () => {
    const record = { id: "ask_8", status: "answered", questions: [{}], answers: { answers: { password: ["TOP-SECRET"] } } };
    expect(JSON.stringify(redactAllQuestionAnswers({ type: "res", id: "1", ok: true, payload: { question: record } }))).not.toContain("TOP-SECRET");
    const r = new SecretAnswerRedactor();
    r.redact({ type: "event", event: "question.requested", payload: { id: "ask_8", questions: [{}] } });
    expect(JSON.stringify(r.redact({ type: "event", event: "question.resolved", payload: { id: "ask_8", status: "answered", answers: { answers: { password: ["TOP-SECRET-2"] } } } }))).not.toContain("TOP-SECRET-2");
  });

  it("a record whose questions cannot be read hides every answer (fail closed)", () => {
    const record = { id: "ask_9", status: "answered", answers: { answers: { password: ["TOP-SECRET"] } } };
    for (const out of [
      new SecretAnswerRedactor().redact({ type: "res", id: "1", ok: true, payload: { question: record } }),
      redactAllQuestionAnswers({ type: "res", id: "1", ok: true, payload: { question: record } }),
    ]) {
      expect(JSON.stringify(out)).not.toContain("TOP-SECRET");
    }
  });

  it("question.resolve's own echo names no question: every value hidden", () => {
    const out = new SecretAnswerRedactor().redact({ type: "res", id: "3", ok: true, payload: { status: "answered", answers: { answers: { token: ["sk-live-123"] } } } });
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
  });
});

describe("the debug sample hides every answer", () => {
  it("whatever the question was", () => {
    expect(JSON.stringify(redactAllQuestionAnswers(resolved({ token: ["sk-live-123"] })))).not.toContain("sk-live-123");
    // Anything else passes through untouched.
    const chat = { type: "event", event: "chat", payload: { state: "delta", deltaText: "x" } };
    expect(redactAllQuestionAnswers(chat)).toBe(chat);
  });
});

describe("the capture line itself", () => {
  it("is written through the connection's redactor", () => {
    const r = new SecretAnswerRedactor();
    captureLine("c", requested([TOKEN]), r, 1);
    const line = captureLine("c", resolved({ token: ["sk-live-123"] }), r, 2);
    expect(line).not.toContain("sk-live-123");
    expect(JSON.parse(line)).toMatchObject({ receivedAt: 2, connection: "c" });
  });
});

describe("the debug logs", () => {
  it("BRIDGE_DEBUG's frame and response text never carries an answer", () => {
    expect(clip(resolved({ token: ["sk-live-123"] }))).not.toContain("sk-live-123");
    expect(clip({ type: "res", id: "1", ok: true, payload: { status: "answered", answers: { answers: { t: ["sk-live-123"] } } } })).not.toContain("sk-live-123");
  });

  it("BRIDGE_FRAME_DUMP never prints one, even when asked for question frames by name", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    const prev = process.env.BRIDGE_FRAME_DUMP;
    process.env.BRIDGE_FRAME_DUMP = "question.resolved";
    try {
      const rm = new RunManager("c1", "agent:alice:atrium:chat:u:c1", {} as never);
      // The tally every frame of a live turn goes through (feed calls it per frame).
      (rm as unknown as { tallyFrame(f: unknown): void }).tallyFrame(resolved({ token: ["sk-live-123"] }));
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_FRAME_DUMP;
      else process.env.BRIDGE_FRAME_DUMP = prev;
      spy.mockRestore();
    }
    expect(logs.some((l) => l.includes("[frame-dump]"))).toBe(true);
    expect(logs.join("\n")).not.toContain("sk-live-123");
  });
});
