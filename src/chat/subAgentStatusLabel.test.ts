// What a sub-agent card says of its child (0.101.4): the session row's word, labelled and
// toned as the Control UI's badge does (ui/src/pages/sessions/session-status.ts:7-37 at
// v2026.9.33); a stopped child never reads "done"; a row-less child keeps the four states
// with the gateway's word (Hermes, rows written before 0.101.4).
import { describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import { statusTone, subAgentStatusLabel, subAgentStatusView } from "./subAgentActivityView";

describe("subAgentStatusView", () => {
  it("the row's badge, as the Control UI shows it", () => {
    // The state Convex stores beside each word (convex/lib/sessionRowStatus.ts).
    const stored = {
      queued: "running", live: "running", idle: "running", unknown: "running", done: "done",
      failed: "error", timeout: "error", killed: "aborted", interrupted: "aborted",
    } as const;
    const view = (display: keyof typeof stored) =>
      subAgentStatusView({ status: stored[display], gatewayRow: { display } });
    expect(view("queued")).toEqual({ tone: "running", label: "en file d’attente" });
    expect(view("live")).toEqual({ tone: "running", label: "en cours" });
    expect(view("idle")).toEqual({ tone: "aborted", label: "inactif" });
    expect(view("unknown")).toEqual({ tone: "aborted", label: "inconnu" });
    expect(view("done")).toEqual({ tone: "done", label: "terminé" });
    expect(view("failed")).toEqual({ tone: "failed", label: "en échec" });
    expect(view("timeout")).toEqual({ tone: "failed", label: "délai dépassé" });
    expect(view("killed")).toEqual({ tone: "failed", label: "arrêt forcé" });
    expect(view("interrupted")).toEqual({ tone: "aborted", label: "interrompu" });
  });

  it("a settle Convex applied after the last read speaks until the next one", () => {
    // The announce proved the child finished while the last read said live.
    expect(subAgentStatusView({ status: "done", gatewayRow: { display: "live" } })).toEqual({
      tone: "done",
      label: "terminé",
    });
    // idle / unknown leave the state alone: the badge stands.
    expect(subAgentStatusView({ status: "done", gatewayRow: { display: "idle" } })).toEqual({
      tone: "aborted",
      label: "inactif",
    });
  });

  it("the reader's Stop reads « arrêté » whatever the row says of the stopped run", () => {
    const stopped = { stopRequestedAt: 5, childRunId: "r1" } as const;
    expect(subAgentStatusView({ ...stopped, status: "aborted" })).toEqual({ tone: "aborted", label: "arrêté" });
    expect(
      subAgentStatusView({ ...stopped, status: "done", gatewayRow: { display: "done", runId: "r1" } }),
    ).toEqual({ tone: "aborted", label: "arrêté" });
    // A later run (an « Interagir » turn) speaks for itself.
    expect(
      subAgentStatusView({ ...stopped, status: "done", gatewayRow: { display: "done", runId: "interaction-1" } }),
    ).toEqual({ tone: "done", label: "terminé" });
    // The stopped run is the one a read after the Stop proved over — here a run later
    // than the delegation: its own `done` still reads « arrêté ».
    expect(
      subAgentStatusView({ ...stopped, stoppedRunId: "r2", status: "done", gatewayRow: { display: "done", runId: "r2" } }),
    ).toEqual({ tone: "aborted", label: "arrêté" });
    // Running again (an undeliverable kill handed the row back): not "stopped".
    expect(subAgentStatusView({ ...stopped, status: "running" })).toEqual({ tone: "running", label: "en cours" });
  });

  it("without a row read: the four states and the gateway's word", () => {
    expect([subAgentStatusLabel("running"), statusTone("running")]).toEqual([m.subagents_status_running(), "running"]);
    expect([subAgentStatusLabel("done"), statusTone("done")]).toEqual([m.subagents_status_done(), "done"]);
    expect([subAgentStatusLabel("error", "timeout"), statusTone("error", "timeout")]).toEqual([m.subagents_status_timeout(), "failed"]);
    expect([subAgentStatusLabel("error", "failed"), statusTone("error", "failed")]).toEqual([m.subagents_status_failed(), "failed"]);
    expect([subAgentStatusLabel("error"), statusTone("error")]).toEqual([m.subagents_status_failed(), "failed"]);
    expect([subAgentStatusLabel("aborted", "killed"), statusTone("aborted", "killed")]).toEqual([m.subagents_status_killed(), "failed"]);
    expect([subAgentStatusLabel("aborted", "interrupted"), statusTone("aborted", "interrupted")]).toEqual([m.subagents_status_interrupted(), "aborted"]);
    expect([subAgentStatusLabel("aborted"), statusTone("aborted")]).toEqual([m.subagents_status_stopped(), "aborted"]);
  });

  it("French labels are the Control UI's own (Délai dépassé, Arrêt forcé, Interrompu, Inactif)", () => {
    expect(m.subagents_status_timeout({}, { locale: "fr" })).toBe("délai dépassé");
    expect(m.subagents_status_killed({}, { locale: "fr" })).toBe("arrêt forcé");
    expect(m.subagents_status_interrupted({}, { locale: "fr" })).toBe("interrompu");
    expect(m.subagents_status_idle({}, { locale: "fr" })).toBe("inactif");
  });
});
