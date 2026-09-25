// The provider frames an agent request is read from, pinned against the upstream
// SCHEMAS they come from (OpenClaw v2026.9.5 `packages/gateway-protocol/src/schema/
// questions.ts` / `approvals.ts`; Hermes v2026.7.20 `tui_gateway/server.py`). Every
// fixture below is a shape those sources emit, field for field.
import { describe, expect, it } from "vitest";
import {
  hermesChoice,
  openClawDecision,
  openClawQuestionAnswers,
  readHermesApproval,
  readHermesClarify,
  readHermesCredential,
  readOpenClawApprovalPresentation,
  readOpenClawApprovalRequested,
  readOpenClawApprovalResolved,
  readOpenClawQuestionRequested,
  questionShape,
  readOpenClawQuestionResolved,
} from "../src/core/agent-requests.js";

// QuestionRecord (questions.ts QuestionRecordSchema), as ask_user registers it.
const QUESTION_RECORD = {
  id: "ask_4f2a",
  questions: [
    {
      questionId: "format",
      header: "Format",
      question: "Quel format veux-tu ?",
      options: [{ label: "PDF" }, { label: "Word", description: "éditable" }],
      multiSelect: false,
      isOther: true,
    },
    { questionId: "note", header: "Note", question: "Une précision ?", options: [] },
  ],
  agentId: "denis",
  sessionKey: "agent:denis:atrium:chat:denis:c1",
  runId: "webchat-1",
  createdAtMs: 1_790_110_000_000,
  expiresAtMs: 1_790_110_900_000,
  status: "pending",
};

describe("OpenClaw questions", () => {
  it("a QuestionRecord reads into questions the card can render", () => {
    const q = readOpenClawQuestionRequested(QUESTION_RECORD);
    expect(q).toMatchObject({
      id: "ask_4f2a",
      sessionKey: "agent:denis:atrium:chat:denis:c1",
      runId: "webchat-1",
      expiresAtMs: 1_790_110_900_000,
      secret: false,
    });
    expect(q!.questions).toEqual([
      {
        id: "format",
        header: "Format",
        text: "Quel format veux-tu ?",
        options: [{ label: "PDF" }, { label: "Word", description: "éditable" }],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
      // No options = free text (question-manager.ts:367 validates options only when
      // there are some).
      { id: "note", header: "Note", text: "Une précision ?", options: [], multiSelect: false, allowOther: true, secret: false },
    ]);
  });

  it("the provider's id is its ADDRESS: kept byte for byte, refused rather than cut", () => {
    // " q" and "q" are two questions on the gateway; trimmed, an answer for one would
    // settle the other (codex P1).
    expect(readOpenClawQuestionRequested({ ...QUESTION_RECORD, id: " ask_4f2a" })!.id).toBe(" ask_4f2a");
    expect(readOpenClawQuestionRequested({ ...QUESTION_RECORD, id: "x".repeat(513) })).toBeNull();
    expect(readOpenClawQuestionResolved({ id: "q ", status: "cancelled" })!.id).toBe("q ");
  });

  it("a closed question keeps its nature even when an option is unreadable", () => {
    const q = readOpenClawQuestionRequested({
      ...QUESTION_RECORD,
      questions: [{ questionId: "c", header: "C", question: "?", options: [{ label: "" }], isOther: false }],
    });
    // Free text there would be an answer the gateway refuses.
    expect(q!.questions[0]!.allowOther).toBe(false);
  });

  it("a record that is no longer pending is not a request", () => {
    expect(readOpenClawQuestionRequested({ ...QUESTION_RECORD, status: "answered" })).toBeNull();
  });

  it("a secret question is flagged — it is shown as a credential", () => {
    const q = readOpenClawQuestionRequested({
      ...QUESTION_RECORD,
      questions: [{ questionId: "token", header: "Token", question: "Jeton ?", options: [], isSecret: true }],
    });
    expect(q!.secret).toBe(true);
  });

  it("a store-bound question shows WHERE the secret goes — a name and its hosts, never a value", () => {
    // QuestionSecretStoreBinding + QuestionSecretStoreExisting (questions.ts). Upstream
    // resolves such a question by writing the one value to the store under `name`
    // (server-methods/question.ts), so it is a secret even without `isSecret`.
    const q = readOpenClawQuestionRequested({
      ...QUESTION_RECORD,
      questions: [
        {
          questionId: "hosting_key",
          header: "Clé",
          question: "Clé API d'hébergement ?",
          options: [],
          secretStore: { name: "HOSTING_API_KEY", kind: "secret", allowedHosts: ["api.host.example"], reason: "publier le rapport" },
          secretStoreExisting: { updatedAtMs: 1_790_000_000_000, updatedBy: "device:x" },
        },
      ],
    });
    expect(q!.secret).toBe(true);
    expect(q!.questions[0]!.store).toEqual({
      name: "HOSTING_API_KEY",
      allowedHosts: ["api.host.example"],
      reason: "publier le rapport",
      replacesSinceMs: 1_790_000_000_000,
    });
    // A binding we cannot show in full — a name outside upstream's pattern, a host we
    // cannot print exactly — makes the whole request unshowable: not recorded.
    for (const secretStore of [
      { name: "lower", kind: "secret" },
      { name: "KEY", kind: "secret", allowedHosts: ["ok.example", 42] },
      { name: "KEY", kind: "secret", allowedHosts: Array.from({ length: 129 }, (_, i) => `h${i}.example`) },
    ]) {
      expect(
        readOpenClawQuestionRequested({ ...QUESTION_RECORD, questions: [{ questionId: "k", header: "K", question: "?", options: [], secretStore }] }),
      ).toBeNull();
    }
  });

  it("an `answered` resolution without readable answers is not read (nothing invented)", () => {
    expect(readOpenClawQuestionResolved({ id: "q", status: "answered" })).toBeNull();
    expect(readOpenClawQuestionResolved({ id: "q", status: "answered", answers: { answers: { format: [1] } } })).toBeNull();
    expect(readOpenClawQuestionResolved({ id: "q", status: "answered", answers: { answers: { format: ["PDF"] } } })).toEqual({
      id: "q",
      status: "answered",
      answers: [{ id: "format", values: ["PDF"] }],
    });
  });

  it("question.resolved carries the answers only when answered", () => {
    expect(
      readOpenClawQuestionResolved({ id: "ask_4f2a", status: "answered", answers: { answers: { format: ["PDF"] } } }),
    ).toEqual({ id: "ask_4f2a", status: "answered", answers: [{ id: "format", values: ["PDF"] }] });
    expect(readOpenClawQuestionResolved({ id: "ask_4f2a", status: "expired" })).toEqual({
      id: "ask_4f2a",
      status: "expired",
    });
    expect(readOpenClawQuestionResolved({ id: "ask_4f2a", status: "bogus" })).toBeNull();
  });

  it("answers go back in the resolver's own shape", () => {
    expect(openClawQuestionAnswers([{ id: "format", values: ["PDF"] }, { id: "BAD-ID", values: ["x"] }])).toEqual({
      answers: { format: ["PDF"] },
    });
  });
});

describe("OpenClaw approvals", () => {
  it("the broadcast is read for ROUTING only — which session asked, until when", () => {
    const a = readOpenClawApprovalRequested("exec.approval.requested", {
      id: "appr-1",
      request: {
        command: "rm -rf /srv/build",
        cwd: "/secret/place",
        sessionKey: "agent:denis:atrium:chat:denis:c1",
        agentId: "denis",
        runId: "webchat-1",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    expect(a).toEqual({
      id: "appr-1",
      kind: "exec",
      sessionKey: "agent:denis:atrium:chat:denis:c1",
      agentId: "denis",
      runId: "webchat-1",
      expiresAtMs: 2,
    });
    // Nothing of the raw request (cwd, command) is carried: the card shows the
    // reviewer-safe presentation instead.
    expect(JSON.stringify(a)).not.toContain("/secret/place");
  });

  it("an exec presentation names the NODE it runs on (codex P1, pass 30)", () => {
    // `host: "node"` alone makes a production node and a test node look the same.
    const p = readOpenClawApprovalPresentation({
      approval: {
        id: "appr-n",
        createdAtMs: 1,
        expiresAtMs: 99,
        status: "pending",
        presentation: {
          kind: "exec",
          commandText: "deploy",
          host: "node",
          nodeId: "prod-eu-west",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    expect(p?.approval).toMatchObject({ command: "deploy", host: "node", nodeId: "prod-eu-west" });
  });

  it("an exec presentation shows the WHOLE command the allow authorises, never the shorter preview (codex P1, pass 28)", () => {
    // `commandText` is already redacted upstream (approval-presentation.ts →
    // resolveExecApprovalCommandDisplay → sanitizeExecApprovalDisplayText); the preview
    // is only SHORTER, and a card showing it hides what the allow runs.
    const got = {
      approval: {
        id: "appr-1",
        urlPath: "/approval/appr-1",
        createdAtMs: 1,
        expiresAtMs: 99,
        status: "pending",
        presentation: {
          kind: "exec",
          commandText: "curl -H 'Authorization: Bearer ***' https://api && rm -rf /srv",
          commandPreview: "curl -H 'Authorization: Bearer ***' https://api",
          warningText: "network egress",
          host: "gateway",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    };
    const p = readOpenClawApprovalPresentation(got);
    expect(p).toEqual({
      expiresAtMs: 99,
      // The generation the answer path will re-check (agent-request-respond.ts).
      createdAtMs: 1,
      approval: {
        command: "curl -H 'Authorization: Bearer ***' https://api && rm -rf /srv",
        warning: "network egress",
        host: "gateway",
        decisions: ["allow-once", "allow-always", "deny"],
      },
    });
  });

  it("a plugin presentation keeps its severity and blast radius", () => {
    const p = readOpenClawApprovalPresentation({
      approval: {
        status: "pending",
        expiresAtMs: 5,
        presentation: {
          kind: "plugin",
          title: "Envoyer la campagne",
          description: "Le plugin Wix veut publier un e-mail",
          severity: "critical",
          pluginId: "wix-openclaw",
          toolName: "wix_email_send",
          scope: { kind: "message-send", target: "newsletter", recipientCount: 1200, audience: "external" },
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    expect(p!.approval).toMatchObject({
      title: "Envoyer la campagne",
      severity: "critical",
      pluginId: "wix-openclaw",
      // An EXTERNAL audience is the riskier send: carried as its own fact.
      scope: { kind: "message-send", summary: "newsletter · ×1200", external: true },
      decisions: ["allow-once", "deny"],
    });
  });

  it("a standing grant says how long allow-always lasts", () => {
    const p = readOpenClawApprovalPresentation({
      approval: {
        status: "pending",
        presentation: {
          kind: "exec",
          commandText: "backup.sh",
          scope: { kind: "standing-grant", automation: "nightly", command: "backup.sh", expiresInDays: 30 },
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    });
    expect(p!.approval.scope).toEqual({ kind: "standing-grant", summary: "nightly · backup.sh", grantDays: 30 });
    const internal = readOpenClawApprovalPresentation({
      approval: {
        status: "pending",
        presentation: {
          kind: "exec",
          commandText: "mail.sh",
          scope: { kind: "message-send", target: "équipe", recipientCount: 3, audience: "internal" },
          allowedDecisions: ["deny"],
        },
      },
    });
    expect(internal!.approval.scope).toEqual({ kind: "message-send", summary: "équipe · ×3" });
  });

  it("deny is always offered — even when the presentation forgot it", () => {
    const p = readOpenClawApprovalPresentation({
      approval: {
        status: "pending",
        presentation: { kind: "system-agent", title: "Redémarrer", description: "x", proposalHash: "a".repeat(64), allowedDecisions: ["allow-once"] },
      },
    });
    expect(p!.approval.decisions).toEqual(["allow-once", "deny"]);
  });

  it("a snapshot that is no longer pending is nothing to ask", () => {
    expect(readOpenClawApprovalPresentation({ approval: { status: "allowed", presentation: { kind: "exec", commandText: "ls", allowedDecisions: ["deny"] } } })).toBeNull();
  });

  it("the resolved broadcast maps to our verdicts", () => {
    expect(readOpenClawApprovalResolved("exec.approval.resolved", { id: "a", decision: "allow-once" })).toEqual({ id: "a", status: "allowed", decision: "allow-once" });
    // A deny is UNCONFIRMED: upstream publishes an expired exec/plugin approval as
    // `{decision:"deny"}` too (approval-publication.ts `record.decision ?? "deny"`).
    expect(readOpenClawApprovalResolved("plugin.approval.resolved", { id: "a", decision: "deny", resolvedBy: "cli" })).toEqual({
      id: "a",
      status: "denied",
      decision: "deny",
      denyUnconfirmed: true,
      resolvedBy: "cli",
    });
    expect(readOpenClawApprovalResolved("openclaw.approval.resolved", { id: "a", decision: "deny", terminalStatus: "expired" })).toEqual({ id: "a", status: "expired" });
  });

  it("a session scope does not exist on OpenClaw", () => {
    expect(openClawDecision("allow-session")).toBe("allow-once");
    expect(openClawDecision("allow-always")).toBe("allow-always");
  });
});

describe("Hermes prompts", () => {
  it("approval choices map both ways", () => {
    expect(readHermesApproval({ command: "rm x", description: "delete", choices: ["once", "session", "always", "deny"] })).toEqual({
      command: "rm x",
      description: "delete",
      decisions: ["allow-once", "allow-session", "allow-always", "deny"],
    });
    expect(hermesChoice("allow-session")).toBe("session");
    expect(hermesChoice("deny")).toBe("deny");
  });

  it("without `choices`, the gateway's own rules apply (server.py:1394-1401)", () => {
    expect(readHermesApproval({ command: "x", smart_denied: true })!.decisions).toEqual(["allow-once", "deny"]);
    expect(readHermesApproval({ command: "x", allow_permanent: false })!.decisions).toEqual(["allow-once", "allow-session", "deny"]);
  });

  it("a smart-denied override is shown as critical", () => {
    expect(readHermesApproval({ command: "x", smart_denied: true })!.severity).toBe("critical");
  });

  it("clarify is one free-text question, choices offered as options", () => {
    expect(readHermesClarify({ question: "Quelle base ?", choices: ["postgres", "sqlite"] })).toEqual([
      { id: "answer", text: "Quelle base ?", options: [{ label: "postgres" }, { label: "sqlite" }], multiSelect: false, allowOther: true, secret: false },
    ]);
    expect(readHermesClarify({ choices: ["a"] })).toBeNull();
  });

  it("a credential names the variable, never a value", () => {
    expect(readHermesCredential("secret.request", { prompt: "Clé", env_var: "KEY", metadata: { x: 1 } })).toEqual({ prompt: "Clé", envVar: "KEY" });
    expect(readHermesCredential("sudo.request", {})).toEqual({});
  });
});

describe("option labels are kept VERBATIM (codex, 0.21.5 pass 13)", () => {
  it("an OpenClaw label with surrounding spaces is the answer value the gateway canonicalizes to", () => {
    const q = readOpenClawQuestionRequested({
      id: "ask_sp",
      sessionKey: "s",
      createdAtMs: 1,
      status: "pending",
      questions: [
        {
          questionId: "ok",
          question: "D'accord ?",
          options: [{ label: "  Yes  " }, { label: "No" }, { label: "   " }],
        },
      ],
    });
    expect(q?.questions[0]?.options.map((o) => o.label)).toEqual(["  Yes  ", "No"]);
  });

  it("a Hermes clarify choice likewise", () => {
    expect(readHermesClarify({ question: "?", choices: [" A ", "B"] })?.[0]?.options.map((o) => o.label)).toEqual([
      " A ",
      "B",
    ]);
  });
});

describe("the question shape both sides compare (codex, 0.21.5 pass 15)", () => {
  it("is pinned — convex/lib/agentRequests.ts questionShape must produce the same string", () => {
    expect(
      questionShape([
        {
          id: "token",
          header: "  Jeton  ",
          text: `  ${"x".repeat(4100)}`,
          secret: true,
          multiSelect: false,
          options: [],
          url: "javascript:alert(1)",
          store: { name: "API_KEY", allowedHosts: ["api.example"], reason: " pour l'API " },
        },
        {
          id: "fmt",
          text: "Format ?",
          secret: false,
          multiSelect: true,
          options: [{ label: "  PDF ", description: " lisible " }, { label: "Word" }],
          url: "https://docs.example/fmt",
        },
      ]),
    ).toBe(
      JSON.stringify([
        ["token", true, false, [], ["API_KEY", ["api.example"]], ["Jeton", `${"x".repeat(3999)}…`, [], null, "pour l'API"]],
        ["fmt", false, true, ["  PDF ", "Word"], null, [null, "Format ?", ["lisible", null], "https://docs.example/fmt", null]],
      ]),
    );
  });
});
