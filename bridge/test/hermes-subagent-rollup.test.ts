/// <reference types="vitest" />
//
// A child that was STOPPED is not a child that broke (lot 43 — G-52).
//
// `delegate_tool` settles a delegated child as `completed`, `interrupted` or `failed` —
// and `timeout` on its own path. Atrium mapped everything that was not `completed` onto
// `error`, so a child the user stopped was reported as one that crashed, and a timeout was
// indistinguishable from a genuine failure.
//
// The same terminal carries per-branch ROLLUPS — tokens, api calls, duration — which were
// dropped entirely, so the monitor could not say what a delegation cost.

import { describe, expect, it } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { ConvexWriter, SubAgentRecord } from "../src/convex-writer.js";

async function childEndingWith(payload: Record<string, unknown>) {
  const records: SubAgentRecord[] = [];
  const client = {
    call: async (method: string) => {
      if (method === "session.create") {
        return { session_id: "rt-1", stored_session_id: "20260706_212939_aee24e" };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async () => {},
    addReasoningPart: async () => {},
    setPhase: () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async (r: SubAgentRecord) => {
      records.push(r);
    },
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: "c1",
      sessionKey: "k",
      providerChatId: null,
      text: "délègue ça",
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  lane("subagent.start", { child_session_id: "kid-1", goal: "chercher" });
  lane("subagent.complete", { child_session_id: "kid-1", ...payload });
  lane("message.complete", { text: "fini", status: "complete" });
  await run.done;
  return records.filter((r) => r.childSessionKey === "hermes:kid-1");
}

const last = (rs: SubAgentRecord[]) => rs[rs.length - 1]!;

describe("the child's terminal word survives", () => {
  it("`completed` is done", async () => {
    const rs = await childEndingWith({ status: "completed", summary: "trouvé" });
    expect(last(rs).status).toBe("done");
    expect(last(rs).providerStatus, "no distinction to keep on success").toBeUndefined();
  });

  it("`interrupted` is ABORTED, not error", async () => {
    // THE defect: a child the user stopped was reported as one that crashed.
    const rs = await childEndingWith({ status: "interrupted" });
    expect(last(rs).status).toBe("aborted");
    expect(last(rs).providerStatus).toBe("interrupted");
  });

  it("`timeout` stays distinguishable from a plain failure", async () => {
    // Both must land on `error` — the enum has nothing better — but a reader who cannot
    // tell them apart cannot act on either.
    const timedOut = await childEndingWith({ status: "timeout" });
    expect(last(timedOut).status).toBe("error");
    expect(last(timedOut).providerStatus).toBe("timeout");
    const failed = await childEndingWith({ status: "failed" });
    expect(last(failed).status).toBe("error");
    expect(last(failed).providerStatus).toBe("failed");
  });

  it("an UNKNOWN word is not stored — this value reaches storage", async () => {
    // Keeping the gateway's own word is worth doing; keeping an arbitrary
    // gateway-supplied string is not.
    const rs = await childEndingWith({ status: "exploded-somehow" });
    expect(last(rs).status).toBe("error");
    expect(last(rs).providerStatus).toBeUndefined();
  });
});

describe("what a delegation cost", () => {
  it("carries the rollup numbers", async () => {
    const rs = await childEndingWith({
      status: "completed",
      summary: "ok",
      input_tokens: 1200,
      output_tokens: 340,
      reasoning_tokens: 90,
      api_calls: 4,
      duration_seconds: 12.5,
    });
    expect(last(rs).rollup).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      reasoningTokens: 90,
      apiCalls: 4,
      durationSeconds: 12.5,
    });
  });

  it("takes NO paths and NO output fragments", async () => {
    // The same payload carries `files_read`/`files_written` (server paths) and
    // `output_tail` (fragments of the child's output). Those are content by any reading,
    // and the child's answer already reaches the thread through `resultText` — copying
    // them into a row that exists to hold measurements would duplicate content into the
    // wrong place.
    const rs = await childEndingWith({
      status: "completed",
      summary: "ok",
      input_tokens: 10,
      files_read: ["/opt/data/patients.csv"],
      files_written: ["/opt/data/rapport.pdf"],
      output_tail: [{ text: "extrait de la sortie" }],
    });
    const r = last(rs) as unknown as Record<string, unknown>;
    expect(JSON.stringify(r)).not.toContain("patients.csv");
    expect(JSON.stringify(r)).not.toContain("extrait de la sortie");
    expect(last(rs).rollup?.inputTokens).toBe(10);
  });

  it("a non-numeric or negative count is dropped, not coerced", async () => {
    const rs = await childEndingWith({
      status: "completed",
      summary: "ok",
      input_tokens: "beaucoup",
      output_tokens: -5,
      api_calls: Number.NaN,
      duration_seconds: 3,
    });
    expect(last(rs).rollup).toEqual({ durationSeconds: 3 });
  });
});
