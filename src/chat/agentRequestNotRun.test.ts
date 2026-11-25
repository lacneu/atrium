/// <reference types="vite/client" />
//
// AN AUTHORISATION THE GATEWAY DID NOT HONOUR — what the card shows.
//
// OpenClaw (2026.9.36 and 2026.10.33, upstream openclaw/openclaw#170994) can accept an
// "allow" and then refuse the command it was given for. The row then carries both facts —
// `status: "allowed"` and `gatewayFailed` — and the card must not read "allowed".
// SSR render, no jsdom: the card that is asserted is the component the thread mounts.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { m } from "@/paraglide/messages.js";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { AgentRequestCard } from "./AgentRequests";
import { explainsOutcome, outcomeOf, type AgentRequestView } from "./agentRequestsView";

const NOW = Date.now();

function approval(over: Partial<AgentRequestView>): AgentRequestView {
  return {
    _id: "r1",
    messageId: "m1",
    source: "openclaw.exec",
    kind: "approval",
    agentId: "alice",
    status: "allowed",
    createdAt: NOW - 30_000,
    expiresAt: NOW + 900_000,
    resolvedAt: NOW - 1_000,
    resolvedElsewhere: false,
    answeredByMe: true,
    seq: null,
    queueKey: null,
    answerById: false,
    questions: null,
    approval: { command: "make deploy", decisions: ["allow-once", "allow-always", "deny"] },
    credential: null,
    answers: null,
    decision: "allow-once",
    failureCode: null,
    gatewayFailed: false,
    canAnswer: true,
    ...over,
  };
}

const render = (r: AgentRequestView): string =>
  // The markup escapes apostrophes; the assertions compare text.
  renderToStaticMarkup(createElement(AgentRequestCard, { request: r, mode: "inline" })).replaceAll("&#x27;", "'");

describe("the outcome", () => {
  test("allowed + the gateway's word = not run, whoever allowed and whatever the scope", () => {
    for (const decision of ["allow-once", "allow-always", "allow-session"] as const) {
      for (const resolvedElsewhere of [false, true]) {
        const r = approval({ decision, resolvedElsewhere, gatewayFailed: true });
        expect(outcomeOf(r, NOW), `${decision} elsewhere=${resolvedElsewhere}`).toBe("not_run");
      }
    }
  });

  test("the gateway's word beside any other status changes nothing", () => {
    const cases: Array<[Partial<AgentRequestView>, string | null]> = [
      [{ status: "pending" }, null],
      [{ status: "submitting" }, null],
      [{ status: "denied", decision: "deny" }, "denied"],
      [{ status: "expired", decision: null }, "expired"],
      [{ status: "cancelled", decision: null, answeredByMe: false }, "cancelled"],
    ];
    for (const [over, expected] of cases) {
      expect(outcomeOf(approval({ ...over, gatewayFailed: true }), NOW)).toBe(
        outcomeOf(approval({ ...over, gatewayFailed: false }), NOW),
      );
      expect(outcomeOf(approval({ ...over, gatewayFailed: true }), NOW)).toBe(expected);
    }
  });

  test("a row from a deployment that does not serve the field reads as before", () => {
    const { gatewayFailed: _absent, ...older } = approval({});
    expect(outcomeOf(older, NOW)).toBe("allowed_once");
  });

  test("only this outcome opens a settled card by itself", () => {
    expect(explainsOutcome("not_run")).toBe(true);
    for (const o of ["allowed_once", "allowed_elsewhere", "denied", "expired", "cancelled", null] as const) {
      expect(explainsOutcome(o)).toBe(false);
    }
  });
});

describe("the card", () => {
  test("an authorisation the gateway did not honour is not shown as allowed, and says what is established", () => {
    const html = render(approval({ gatewayFailed: true }));
    expect(html).toContain("oc-areq__outcome--not_run");
    expect(html).toContain(m.areq_outcome_not_run());
    expect(html).not.toContain(m.areq_outcome_allowed_once());
    expect(html).not.toContain("oc-areq__outcome--allowed");
    // Open by itself: the sentence is on screen without a click, beside the command.
    expect(html).toContain(m.areq_not_run_note());
    expect(html).toContain("make deploy");
    // Information only: nothing here re-runs the command or asks again in anyone's place.
    expect(html).not.toContain(m.areq_decision_allow_once());
    expect(html).not.toContain(m.areq_decision_deny());
  });

  test("an authorisation that stands is shown as before, folded, with no such sentence", () => {
    const html = render(approval({}));
    expect(html).toContain(m.areq_outcome_allowed_once());
    expect(html).not.toContain(m.areq_outcome_not_run());
    expect(html).not.toContain(m.areq_not_run_note());
  });
});

describe("the wording, in both languages", () => {
  test("says the three established facts and one thing the person can do — nothing about a cause", () => {
    expect(fr.areq_outcome_not_run).toBe("Autorisé, non exécuté");
    expect(en.areq_outcome_not_run).toBe("Allowed, not run");
    expect(fr.areq_not_run_note).toBe(
      "L'autorisation a été donnée, mais la passerelle l'a invalidée avant d'exécuter la commande. La commande n'a pas été lancée. Pour qu'elle le soit, demandez-la de nouveau à l'agent.",
    );
    expect(en.areq_not_run_note).toBe(
      "The authorization was given, but the gateway invalidated it before running the command. The command did not run. To have it run, ask the agent again.",
    );
  });
});
