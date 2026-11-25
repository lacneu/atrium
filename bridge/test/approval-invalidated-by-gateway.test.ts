/**
 * An exec approval a person ALLOWED and the gateway then did not honour.
 *
 * Upstream openclaw/openclaw#170994 (2026.9.36 and 2026.10.33 alike): the gateway accepts
 * the decision, then revokes the requester that was waiting for it; the exec ends refused
 * (`approval-request-failed`) and the command never runs. The card said "allowed".
 *
 * The one structured word about it is the `agent` event of stream `approval`:
 * `phase: "resolved"`, `kind: "exec"`, `status: "failed"`, naming the tool call
 * (src/agents/embedded-agent-subscribe.handlers.tools.completion.ts `handleToolExecutionEnd`).
 * `status` on a `resolved` is `failed` or `denied`; the type also allows `pending`,
 * `unavailable` (a `requested`) and `approved` (the Codex harness), and `kind` is
 * `exec` | `plugin` | `unknown` (src/infra/agent-events.types.ts AgentApprovalEventData).
 *
 * The fixture is an extract of the live capture where the defect occurred (bench run
 * 2026-11-25T00-13-54-548Z, scenario `approval-wait-vs-existing-session-claim`): what ONE
 * bridge socket received after its reconnection. That run is NO-GO, so the promoter
 * refuses it for the golden corpus; the sequence is replayed here instead.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  readOpenClawApprovalRequestFailed,
  type AgentRequestGatewayFailure,
  type AgentRequestRecord,
  type AgentRequestSettle,
} from "../src/core/agent-requests.js";
import { HttpConvexWriter } from "../src/convex-writer.js";
import { OpenClawAgentRequestObserver } from "../src/providers/openclaw/agent-request-observer.js";

interface Captured {
  capturedLine: number;
  answers?: string;
  frame: { type: string; event?: string; payload: unknown };
}

const CAPTURE: Captured[] = readFileSync(
  new URL("./fixtures/approval-invalidated-2026.10.33.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .map((line) => JSON.parse(line) as Captured);

const line = (n: number): Captured => {
  const found = CAPTURE.find((c) => c.capturedLine === n);
  if (found === undefined) throw new Error(`no captured line ${n}`);
  return found;
};

const SESSION = "agent:alice:atrium:chat:u-repro:turn-nx78nsrx8v526am2nk2krgegq58jwr53";
const APPROVAL = "daebea08-9639-4053-a8eb-b68ac2c22c61";
const CREATED = 1795567231887;
const TOOL_CALL =
  "tool_call:call_657432d8aaf04e7fb366cc25d5254abc_fc_02cfd842c5eff21a016b062e7f0b2887d195b0fd9dc9644ad2:1d41a8846a7b48d9a2b35741:exec:1";
const FAILED = line(314).frame;

function setup(
  opts: {
    list?: unknown;
    get?: () => Promise<unknown> | unknown;
    gatewayFailed?: (f: AgentRequestGatewayFailure) => Promise<unknown>;
    sessionKey?: string;
    /** The reply of `plugin.approval.list`, when a test holds it back. */
    pluginList?: () => Promise<unknown>;
    sameRun?: (a: string, b: string) => boolean;
    nowMs?: () => number;
  } = {},
) {
  const writes: string[] = [];
  const upserts: AgentRequestRecord[] = [];
  const settles: AgentRequestSettle[] = [];
  const failures: AgentRequestGatewayFailure[] = [];
  const obs = new OpenClawAgentRequestObserver({
    chatId: "c1",
    sessionKey: opts.sessionKey ?? SESSION,
    agentId: "alice",
    gateway: {
      request: async (method: string) => {
        const payload =
          method === "exec.approval.list"
            ? (opts.list ?? line(204).frame.payload)
            : method === "approval.get"
              ? await (opts.get ?? (() => line(209).frame.payload))()
              : method === "question.list"
                ? { questions: [] }
                : method === "plugin.approval.list" && opts.pluginList !== undefined
                  ? await opts.pluginList()
                  : [];
        return { type: "res", ok: true, payload };
      },
    },
    upsert: async (r) => {
      writes.push("card");
      upserts.push(r);
    },
    settle: async (s) => {
      writes.push("verdict");
      settles.push(s);
      return { outcome: "settled" };
    },
    gatewayFailed:
      opts.gatewayFailed ??
      (async (f) => {
        writes.push("gateway-failed");
        failures.push(f);
        return { outcome: "marked" };
      }),
    currentMessageId: () => "msg-1",
    noteQuestion: async () => false,
    noteQuestionSettled: async () => {},
    noteApprovalSettled: async () => {},
    wake: () => {},
    nowMs: opts.nowMs ?? (() => 1795567236000),
    ...(opts.sameRun !== undefined ? { sameRun: opts.sameRun } : {}),
  });
  /** As the session does: only a frame the observer says it handles reaches it. */
  const feed = async (frame: unknown): Promise<boolean> => {
    if (!OpenClawAgentRequestObserver.handles(frame)) return false;
    await obs.observe(frame);
    return true;
  };
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return { obs, feed, flush, writes, upserts, settles, failures };
}

const approvalFrame = (data: Record<string, unknown>, sessionKey: string | undefined = SESSION) => ({
  type: "event",
  event: "agent",
  payload: { runId: "webchat-1", ...(sessionKey !== undefined ? { sessionKey } : {}), stream: "approval", data },
});

describe("the fact, read from the frame alone", () => {
  it("the captured frame is read: the tool call and the session, nothing else", () => {
    expect(readOpenClawApprovalRequestFailed(FAILED)).toEqual({
      toolCallId: TOOL_CALL,
      sessionKey: SESSION,
      runId: "webchat-69495ecfa7f05ab4aa5f95a8629c03de146edbf551ca9c89bd83a452b3dd5169",
    });
  });

  it("only `resolved` / `exec` / `failed` is the fact — every other status, kind and phase reads as nothing", () => {
    const base = { phase: "resolved", kind: "exec", status: "failed", toolCallId: "tc-1" };
    expect(readOpenClawApprovalRequestFailed(approvalFrame(base))).not.toBeNull();
    for (const status of ["denied", "approved", "pending", "unavailable", "FAILED", undefined, 1]) {
      expect(readOpenClawApprovalRequestFailed(approvalFrame({ ...base, status })), String(status)).toBeNull();
    }
    for (const kind of ["plugin", "unknown", undefined]) {
      expect(readOpenClawApprovalRequestFailed(approvalFrame({ ...base, kind })), String(kind)).toBeNull();
    }
    expect(readOpenClawApprovalRequestFailed(approvalFrame({ ...base, phase: "requested" }))).toBeNull();
    // The Codex harness's frames name an item, never a tool call: nothing to join.
    expect(readOpenClawApprovalRequestFailed(approvalFrame({ ...base, toolCallId: undefined, itemId: "i-1" }))).toBeNull();
  });

  it("no sentence decides: the refusal's words on other frames are not the fact", () => {
    const words = "Exec denied (gateway id=x, approval-request-failed): <masked>";
    expect(
      readOpenClawApprovalRequestFailed(
        approvalFrame({ phase: "resolved", kind: "exec", status: "denied", toolCallId: "tc-1", message: words }),
      ),
    ).toBeNull();
    expect(
      readOpenClawApprovalRequestFailed({
        type: "event",
        event: "agent",
        payload: { sessionKey: SESSION, stream: "item", data: { phase: "end", status: "failed", toolCallId: "tc-1", error: words } },
      }),
    ).toBeNull();
    // …and the captured tool end, which carries them, is not even routed to the observer.
    expect(OpenClawAgentRequestObserver.handles(line(309).frame)).toBe(false);
  });
});

describe("the captured sequence, replayed on one socket", () => {
  it("allowed by a person, then failed on the gateway: the card is settled allowed, THEN marked", async () => {
    const t = setup();
    // The socket reconnected while the request waited: it learns it from the pending list.
    await t.obs.replayPending();
    await t.flush();
    const routed: number[] = [];
    for (const n of [305, 306, 309, 314]) if (await t.feed(line(n).frame)) routed.push(n);
    await t.flush();

    expect(routed).toEqual([305, 314]);
    expect(t.upserts.map((u) => [u.source, u.providerRequestId, u.providerCreatedAt])).toEqual([
      ["openclaw.exec", APPROVAL, CREATED],
    ]);
    expect(t.settles).toEqual([
      { chatId: "c1", providerRequestId: APPROVAL, family: "approval", providerCreatedAt: CREATED, status: "allowed", decision: "allow-once" },
    ]);
    // Which card, and nothing else: neither the command nor any text of the frame.
    expect(t.failures).toEqual([{ chatId: "c1", providerRequestId: APPROVAL, providerCreatedAt: CREATED }]);
    expect(t.writes).toEqual(["card", "verdict", "gateway-failed"]);
  });

  it("the mark waits for a card still being written", async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => (release = r));
    const t = setup({ get: () => slow });
    await t.obs.replayPending();
    await t.feed(FAILED);
    await t.flush();
    expect(t.writes).toEqual([]);
    release(line(209).frame.payload);
    await t.flush();
    expect(t.writes).toEqual(["card", "gateway-failed"]);
  });

  it("without the frame, nothing is marked: the card stays what the resolution made it", async () => {
    const t = setup();
    await t.obs.replayPending();
    for (const n of [305, 306, 309]) await t.feed(line(n).frame);
    await t.flush();
    expect(t.settles.map((s) => s.status)).toEqual(["allowed"]);
    expect(t.failures).toEqual([]);
  });
});

// The three pending lists are awaited TOGETHER (replayApprovals): while one of them is
// slow, the request another already returned can be allowed and then fail on the gateway.
// Its resolution waits for the entry (the early resolutions); its failure must too.
describe("the failure received while the pending lists are still being read", () => {
  const RUN = "webchat-69495ecfa7f05ab4aa5f95a8629c03de146edbf551ca9c89bd83a452b3dd5169";
  const failedFor = (over: { sessionKey?: string | undefined; runId?: string; toolCallId?: string }) => ({
    type: "event",
    event: "agent",
    payload: {
      runId: over.runId ?? RUN,
      ...("sessionKey" in over ? (over.sessionKey !== undefined ? { sessionKey: over.sessionKey } : {}) : { sessionKey: SESSION }),
      stream: "approval",
      data: { phase: "resolved", kind: "exec", status: "failed", toolCallId: over.toolCallId ?? TOOL_CALL },
    },
  });
  /** A replay whose plugin list is held back; `during` runs while it waits. */
  async function replayWith(t: ReturnType<typeof setup>, release: () => void, during: () => Promise<void>) {
    const replay = t.obs.replayPending();
    await t.flush();
    await during();
    await t.flush();
    release();
    await replay;
    await t.flush();
  }
  function held(extra: Parameters<typeof setup>[0] = {}) {
    let release: () => void = () => {};
    const slow = new Promise<unknown>((r) => (release = () => r([])));
    const t = setup({ pluginList: () => slow, ...extra });
    return { t, release: () => release() };
  }

  it("allowed, then failed, BEFORE the lists are read: the card is settled allowed, then marked", async () => {
    const { t, release } = held();
    await replayWith(t, release, async () => {
      for (const n of [305, 306, 309, 314]) await t.feed(line(n).frame);
      // The request is not announced here yet: no card to mark so far.
      expect(t.failures).toEqual([]);
    });
    // The verdict is written by the resolution, and again when its entry is read (the same
    // settle, idempotent in Convex) — the mark comes after both.
    expect(new Set(t.settles.map((s) => `${s.providerRequestId}:${s.status}`))).toEqual(new Set([`${APPROVAL}:allowed`]));
    expect(t.failures).toEqual([{ chatId: "c1", providerRequestId: APPROVAL, providerCreatedAt: CREATED }]);
    expect(t.writes.indexOf("gateway-failed")).toBeGreaterThan(t.writes.lastIndexOf("verdict"));
    expect(t.writes.filter((w) => w === "gateway-failed")).toHaveLength(1);
  });

  it("kept for the request of THAT tool call only: another call's failure marks nothing", async () => {
    const { t, release } = held();
    await replayWith(t, release, async () => {
      await t.feed(failedFor({ toolCallId: "tool_call:another:exec:1" }));
    });
    expect(t.failures).toEqual([]);
  });

  it("a failure that names another session, or none, is not kept", async () => {
    for (const sessionKey of ["agent:alice:atrium:chat:u-other:turn-x", undefined]) {
      const { t, release } = held();
      await replayWith(t, release, async () => {
        await t.feed(failedFor({ sessionKey }));
      });
      expect(t.failures, String(sessionKey)).toEqual([]);
    }
  });

  it("a failure of ANOTHER run that reused the tool call id is not joined; the same run under its other name is", async () => {
    const other = held();
    await replayWith(other.t, other.release, async () => {
      await other.t.feed(failedFor({ runId: "another-run" }));
    });
    expect(other.t.failures).toEqual([]);
    // One run, two names (a queued input's execution, 2026.10.33): the session says so.
    const linked = held({ sameRun: (a, b) => a === b || (a === "execution-run" && b === RUN) || (b === "execution-run" && a === RUN) });
    await replayWith(linked.t, linked.release, async () => {
      await linked.t.feed(failedFor({ runId: "execution-run" }));
    });
    expect(linked.t.failures.map((f) => f.providerRequestId)).toEqual([APPROVAL]);
  });

  it("bounded in time: a failure older than the wait a replay can take is not joined", async () => {
    let now = 1795567236000;
    const { t, release } = held({ nowMs: () => now });
    await replayWith(t, release, async () => {
      await t.feed(FAILED);
      now += 10 * 60_000;
    });
    expect(t.failures).toEqual([]);
  });

  it("bounded in number: the oldest kept failures give way", async () => {
    const { t, release } = held();
    await replayWith(t, release, async () => {
      await t.feed(FAILED);
      for (let i = 0; i < 200; i += 1) await t.feed(failedFor({ toolCallId: `tool_call:flood-${i}:exec:1` }));
    });
    expect(t.failures).toEqual([]);
  });

  it("joined once: the same request listed again is not marked a second time", async () => {
    const { t, release } = held();
    await replayWith(t, release, async () => {
      await t.feed(FAILED);
    });
    expect(t.failures).toHaveLength(1);
    await t.obs.replayPending();
    await t.flush();
    expect(t.failures).toHaveLength(1);
  });
});

describe("what is NOT marked", () => {
  it("a `denied` on the same stream (a person's deny, an expiry, an aborted run)", async () => {
    const t = setup();
    await t.obs.replayPending();
    const denied = approvalFrame({ phase: "resolved", kind: "exec", status: "denied", toolCallId: TOOL_CALL });
    expect(await t.feed(denied)).toBe(false);
    await t.flush();
    expect(t.failures).toEqual([]);
  });

  it("a tool call this socket announced no exec request for", async () => {
    const t = setup({ list: [] });
    await t.obs.replayPending();
    await t.feed(FAILED);
    await t.flush();
    expect(t.failures).toEqual([]);
  });

  it("another conversation's frame, even for a tool call id known here", async () => {
    const t = setup();
    await t.obs.replayPending();
    await t.feed(
      approvalFrame(
        { phase: "resolved", kind: "exec", status: "failed", toolCallId: TOOL_CALL },
        "agent:alice:atrium:chat:u-other:turn-x",
      ),
    );
    await t.flush();
    expect(t.failures).toEqual([]);
  });

  it("a PLUGIN approval naming the same tool call: only an exec request is joined", async () => {
    const t = setup({ list: [] });
    const entry = (line(204).frame.payload as Array<Record<string, unknown>>)[0]!;
    await t.feed({ type: "event", event: "plugin.approval.requested", payload: entry });
    await t.feed(FAILED);
    await t.flush();
    expect(t.failures).toEqual([]);
  });
});

describe("the write to Convex", () => {
  it("is tried again on the settle's back-off while Convex holds no card yet, then stops once marked", async () => {
    vi.useFakeTimers();
    try {
      const answers = ["none", "marked", "marked"];
      const seen: AgentRequestGatewayFailure[] = [];
      const t = setup({
        gatewayFailed: async (f) => {
          seen.push(f);
          return { outcome: answers.shift() };
        },
      });
      await t.obs.replayPending();
      await vi.advanceTimersByTimeAsync(0);
      await t.feed(FAILED);
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(seen).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts the op with the card's identity only, and reads what Convex did", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const replies: unknown[] = [{ ok: true, outcome: "marked" }, { ok: true, outcome: "none" }, { ok: true }];
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true, json: async () => replies.shift() } as unknown as Response;
    }) as unknown as typeof fetch;
    const w = new HttpConvexWriter({ convexHttpActionsUrl: "http://test.invalid", ingestSecret: "s", fetchImpl });
    const failure = { chatId: "c1", providerRequestId: APPROVAL, providerCreatedAt: CREATED };
    expect(await w.agentRequestGatewayFailed(failure)).toEqual({ outcome: "marked" });
    expect(await w.agentRequestGatewayFailed(failure)).toEqual({ outcome: "none" });
    // An answer that does not say: never taken for marked.
    expect(await w.agentRequestGatewayFailed(failure)).toEqual({ outcome: "none" });
    expect(bodies[0]).toEqual({ op: "agentRequestGatewayFailed", ...failure });
  });
});
