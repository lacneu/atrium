/**
 * CONF-4c `/agent-files`: parser allowlist + the gateway op sequences against a
 * mock requester (no socket). Pins the load-bearing behaviors a live run does
 * not exercise cheaply: the STRICT name allowlist (the gateway re-validates,
 * but the bridge must refuse first), the 64k content cap, the compare-and-set
 * 409 (set must NOT be sent on a conflict) and the before/after projection
 * (no `path`, no content echo in `file`, `before.content` for audit/rollback).
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_FILE_NAMES,
  MAX_AGENT_FILE_CONTENT_CHARS,
  parseAgentFilesBody,
  performAgentFilesOp,
  type GatewayRequester,
} from "../src/conf.js";

/** Scripted gateway: replies per-method (get replies pop a FIFO queue so the
 *  set op's pre-get and post-get can differ), records every call in order. */
function mockGateway(opts: {
  files?: unknown;
  gets?: Record<string, unknown>[];
  failOn?: string;
}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const gets = [...(opts.gets ?? [])];
  const conn: GatewayRequester = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === opts.failOn) throw new Error(`${method} failed`);
      if (method === "agents.files.list") return { payload: { agentId: "a", files: opts.files } };
      if (method === "agents.files.get") return { payload: { agentId: "a", file: gets.shift() } };
      if (method === "agents.files.set") return { payload: { ok: true } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { conn, calls };
}

const FILE = {
  name: "AGENTS.md",
  path: "/work/agents/a/AGENTS.md",
  missing: false,
  size: 12,
  updatedAtMs: 1111,
  content: "old content",
};

describe("parseAgentFilesBody (strict allowlists)", () => {
  it("parses list / get / set", () => {
    expect(parseAgentFilesBody(JSON.stringify({ op: "list", agentId: "a" }))).toEqual({
      op: "list",
      instanceName: null,
      agentId: "a",
    });
    expect(
      parseAgentFilesBody(JSON.stringify({ op: "get", agentId: "a", name: "SOUL.md" })),
    ).toEqual({ op: "get", instanceName: null, agentId: "a", name: "SOUL.md" });
    expect(
      parseAgentFilesBody(
        JSON.stringify({ op: "set", agentId: "a", name: "MEMORY.md", content: "x", baseUpdatedAtMs: 5 }),
      ),
    ).toEqual({
      op: "set",
      instanceName: null,
      agentId: "a",
      name: "MEMORY.md",
      content: "x",
      baseUpdatedAtMs: 5,
    });
  });

  it("accepts baseUpdatedAtMs: null as the CREATE / skip-CAS shape (Convex sends `?? null`)", () => {
    // convex/agentFiles.ts setAgentFile sends `baseUpdatedAtMs: baseUpdatedAtMs ?? null`
    // for a missing (not-yet-created) bootstrap file. The parser must accept the
    // explicit null (not just an absent field), else POST /agent-files -> 400 and
    // admins cannot create/edit missing files.
    expect(
      parseAgentFilesBody(
        JSON.stringify({ op: "set", agentId: "a", name: "MEMORY.md", content: "x", baseUpdatedAtMs: null }),
      ),
    ).toEqual({
      op: "set",
      instanceName: null,
      agentId: "a",
      name: "MEMORY.md",
      content: "x",
      baseUpdatedAtMs: null,
    });
    // An absent field is the same skip-CAS shape, normalized to null.
    expect(
      parseAgentFilesBody(
        JSON.stringify({ op: "set", agentId: "a", name: "MEMORY.md", content: "x" }),
      ),
    ).toMatchObject({ op: "set", baseUpdatedAtMs: null });
  });

  it("carries instanceName through for the route's instance guard (P2-3)", () => {
    expect(
      parseAgentFilesBody(
        JSON.stringify({ op: "list", agentId: "a", instanceName: "main" }),
      ),
    ).toEqual({ op: "list", instanceName: "main", agentId: "a" });
  });

  it("accepts every bootstrap file name in the allowlist", () => {
    for (const name of AGENT_FILE_NAMES) {
      expect(parseAgentFilesBody(JSON.stringify({ op: "get", agentId: "a", name }))).not.toBeNull();
    }
  });

  it("REJECTS a name outside the allowlist (incl. traversal-shaped ones)", () => {
    for (const name of ["EVIL.md", "../AGENTS.md", "memory/2026-06-11.md", "agents.md", ""]) {
      expect(
        parseAgentFilesBody(JSON.stringify({ op: "get", agentId: "a", name })),
      ).toBeNull();
      expect(
        parseAgentFilesBody(JSON.stringify({ op: "set", agentId: "a", name, content: "x" })),
      ).toBeNull();
    }
  });

  it("rejects an unknown op, a missing agentId, and malformed JSON", () => {
    expect(parseAgentFilesBody(JSON.stringify({ op: "delete", agentId: "a" }))).toBeNull();
    expect(parseAgentFilesBody(JSON.stringify({ op: "list" }))).toBeNull();
    expect(parseAgentFilesBody(JSON.stringify({ op: "get", agentId: "a" }))).toBeNull(); // no name
    expect(parseAgentFilesBody("{not json")).toBeNull();
    expect(parseAgentFilesBody("null")).toBeNull();
  });

  it("rejects a set without content, with oversized content, or a non-numeric base", () => {
    expect(
      parseAgentFilesBody(JSON.stringify({ op: "set", agentId: "a", name: "AGENTS.md" })),
    ).toBeNull();
    const huge = "x".repeat(MAX_AGENT_FILE_CONTENT_CHARS + 1);
    expect(
      parseAgentFilesBody(JSON.stringify({ op: "set", agentId: "a", name: "AGENTS.md", content: huge })),
    ).toBeNull();
    expect(
      parseAgentFilesBody(
        JSON.stringify({ op: "set", agentId: "a", name: "AGENTS.md", content: "x", baseUpdatedAtMs: "5" }),
      ),
    ).toBeNull();
    // exactly at the cap is allowed
    const max = "x".repeat(MAX_AGENT_FILE_CONTENT_CHARS);
    expect(
      parseAgentFilesBody(JSON.stringify({ op: "set", agentId: "a", name: "AGENTS.md", content: max })),
    ).not.toBeNull();
  });
});

describe("performAgentFilesOp — list", () => {
  it("calls agents.files.list {agentId} and projects entries WITHOUT path (P2-2)", async () => {
    const { conn, calls } = mockGateway({ files: [FILE] });
    const res = await performAgentFilesOp(conn, {
      op: "list",
      instanceName: null,
      agentId: "a",
    });
    expect(calls).toEqual([{ method: "agents.files.list", params: { agentId: "a" } }]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      files: [{ name: "AGENTS.md", missing: false, size: 12, updatedAtMs: 1111 }],
    });
    expect(JSON.stringify(res.body)).not.toContain("/work/agents");
  });

  it("degrades a shapeless payload to an empty list and drops non-object entries", async () => {
    const { conn } = mockGateway({ files: undefined });
    const res = await performAgentFilesOp(conn, {
      op: "list",
      instanceName: null,
      agentId: "a",
    });
    expect(res.body).toEqual({ ok: true, files: [] });

    const { conn: conn2 } = mockGateway({ files: [FILE, "junk", 7, null] });
    const res2 = await performAgentFilesOp(conn2, {
      op: "list",
      instanceName: null,
      agentId: "a",
    });
    expect((res2.body.files as unknown[]).length).toBe(1);
  });
});

describe("performAgentFilesOp — get", () => {
  it("projects name/missing/size/updatedAtMs/content (never the server path)", async () => {
    const { conn, calls } = mockGateway({ gets: [FILE] });
    const res = await performAgentFilesOp(conn, {
      op: "get",
      instanceName: null,
      agentId: "a",
      name: "AGENTS.md",
    });
    expect(calls).toEqual([
      { method: "agents.files.get", params: { agentId: "a", name: "AGENTS.md" } },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      file: {
        name: "AGENTS.md",
        missing: false,
        size: 12,
        updatedAtMs: 1111,
        content: "old content",
      },
    });
  });

  it("reports a missing file with EMPTY content (editable, save = create — P3-2)", async () => {
    const { conn } = mockGateway({
      gets: [{ name: "HEARTBEAT.md", missing: true }],
    });
    const res = await performAgentFilesOp(conn, {
      op: "get",
      instanceName: null,
      agentId: "a",
      name: "HEARTBEAT.md",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      file: {
        name: "HEARTBEAT.md",
        missing: true,
        size: null,
        updatedAtMs: null,
        content: "",
      },
    });
  });
});

describe("performAgentFilesOp — set (compare-and-set)", () => {
  const setBody = {
    op: "set" as const,
    instanceName: null,
    agentId: "a",
    name: "AGENTS.md",
    content: "new content",
    baseUpdatedAtMs: 1111,
  };

  it("happy path: get -> set -> re-get; reports confirmed meta + before content", async () => {
    const after = { ...FILE, size: 11, updatedAtMs: 2222, content: "new content" };
    const { conn, calls } = mockGateway({ gets: [FILE, after] });
    const res = await performAgentFilesOp(conn, setBody);
    expect(calls.map((c) => c.method)).toEqual([
      "agents.files.get",
      "agents.files.set",
      "agents.files.get",
    ]);
    expect(calls[1]!.params).toEqual({ agentId: "a", name: "AGENTS.md", content: "new content" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      // post-write CONFIRMED meta, content intentionally omitted
      file: { name: "AGENTS.md", missing: false, size: 11, updatedAtMs: 2222 },
      // pre-write content, for the Convex-side audit/rollback record
      before: { content: "old content" },
    });
  });

  it("CONFLICT: a moved updatedAtMs -> 409 and agents.files.set is NEVER sent", async () => {
    const moved = { ...FILE, updatedAtMs: 9999 };
    const { conn, calls } = mockGateway({ gets: [moved] });
    const res = await performAgentFilesOp(conn, setBody);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "CONFLICT", currentUpdatedAtMs: 9999 },
    });
    expect(calls.map((c) => c.method)).toEqual(["agents.files.get"]); // no set, no re-get
  });

  it("CREATE (baseUpdatedAtMs null) on a still-MISSING file -> 200 + set", async () => {
    // base null = "I expect the file to still be missing" (the create path).
    const missing = { name: "AGENTS.md", missing: true };
    const created = { ...FILE, content: "new content", updatedAtMs: 2222 };
    const { conn, calls } = mockGateway({ gets: [missing, created] });
    const res = await performAgentFilesOp(conn, { ...setBody, baseUpdatedAtMs: null });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.method)).toContain("agents.files.set");
  });

  it("CREATE (baseUpdatedAtMs null) but the file was created CONCURRENTLY -> 409, set NEVER sent", async () => {
    // Another admin created it between the editor's get and this set: current is
    // now a number != the expected-missing null -> conflict, NOT a silent clobber.
    const { conn, calls } = mockGateway({ gets: [{ ...FILE, updatedAtMs: 5555 }] });
    const res = await performAgentFilesOp(conn, { ...setBody, baseUpdatedAtMs: null });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: "CONFLICT", currentUpdatedAtMs: 5555 },
    });
    expect(calls.map((c) => c.method)).toEqual(["agents.files.get"]); // no set
  });

  it("a gateway failure propagates (the route classifies it to 502)", async () => {
    const { conn } = mockGateway({ gets: [FILE, FILE], failOn: "agents.files.set" });
    await expect(performAgentFilesOp(conn, setBody)).rejects.toThrow("agents.files.set failed");
  });
});
