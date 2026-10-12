// THE LAUNCHES A TRANSCRIPT ROW STATES (redesign phase 5, design §14.1): the identities a
// delivery run is joined to its launcher by. Pinned against a REAL 2026.9.8 history row
// (a code-mode `sessions_spawn`, fixtures/transcript-spawn-rows-2026.9.8.json) and against
// the direct-call shape upstream writes (`jsonResult` of a `SpawnSubagentResult`,
// src/agents/tools/sessions-spawn-tool.ts:670 + tool-results.ts:10-12 at v2026.9.8).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { spawnFacts, toTranscriptRow } from "../src/providers/openclaw/transcript-rows.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/transcript-spawn-rows-2026.9.8.json"), "utf-8"),
) as { messages: Array<Record<string, unknown>> };
const NESTED = CAPTURE.messages[0]!;
const SK = "agent:alice:atrium:chat:u-repro:turn-x";

/** A direct call's result row, exactly as upstream builds it. */
const direct = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "sessions_spawn",
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  isError: false,
  __openclaw: { runId: "webchat-p", id: "row-1", seq: 7 },
  ...extra,
});
const ACCEPTED = { status: "accepted", childSessionKey: "agent:files:subagent:abc", runId: "child-run-1", mode: "run" };

describe("spawnFacts", () => {
  it("the nested-tool row of a code-mode call (captured, 9.8)", () => {
    expect(spawnFacts(NESTED)).toEqual([
      { childSessionKey: "agent:files:subagent:3b0e99f7-9148-4fe1-a921-aac84c1f42ef", childRunId: "6ddc400c-da16-464e-8e74-65deeafb9383" },
    ]);
  });

  it("a direct call's result row", () => {
    expect(spawnFacts(direct(ACCEPTED))).toEqual([{ childSessionKey: "agent:files:subagent:abc", childRunId: "child-run-1" }]);
  });

  it.each([
    ["a refused spawn", direct({ ...ACCEPTED, status: "forbidden" })],
    ["an errored spawn", direct({ ...ACCEPTED, status: "error" })],
    ["a tool error", direct(ACCEPTED, { isError: true })],
    ["a cut text (display limit)", { ...direct(ACCEPTED), content: [{ type: "text", text: '{ "status": "accepted", "childSess' }] }],
    ["a run id upstream never mints", direct({ ...ACCEPTED, runId: "a:b" })],
    ["another tool", { ...direct(ACCEPTED), toolName: "sessions_send" }],
    // The agent's own code printing the same JSON is NOT the tool's word.
    ["exec output", { ...direct({ output: [{ type: "json", value: ACCEPTED }] }), toolName: "exec" }],
    ["an assistant row quoting it", { role: "assistant", content: [{ type: "text", text: JSON.stringify(ACCEPTED) }] }],
  ])("%s states nothing", (_name, row) => {
    expect(spawnFacts(row)).toEqual([]);
  });

  it("a nested row whose result block is an error states nothing", () => {
    const row = structuredClone(NESTED) as { content: Array<Record<string, unknown>> };
    for (const b of row.content) if (b.type === "toolResult") b.isError = true;
    expect(spawnFacts(row)).toEqual([]);
  });
});

describe("toTranscriptRow — launches ride a row only when the read asked for what rows say (`on`)", () => {
  it("on: the nested row carries its run and its launch", () => {
    const row = toTranscriptRow(NESTED, undefined, { sessionKey: SK });
    expect(row?.runId).toBe("webchat-5b3d11b8cc701a668db42ba4925e40e295a2cbed279f8e6cc585b767a60c2c90");
    expect(row?.spawns).toEqual([
      { childSessionKey: "agent:files:subagent:3b0e99f7-9148-4fe1-a921-aac84c1f42ef", childRunId: "6ddc400c-da16-464e-8e74-65deeafb9383" },
    ]);
  });

  it("off / shadow: the very same payload as before phase 5 (no `spawns` key at all)", () => {
    const row = toTranscriptRow(NESTED);
    expect(row).not.toBeNull();
    expect(Object.keys(row!)).not.toContain("spawns");
    expect(Object.keys(toTranscriptRow(direct(ACCEPTED))!)).not.toContain("spawns");
  });
});
