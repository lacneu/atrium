/// <reference types="vitest" />
// The chat's openclawChatId slot is shared with OpenClaw routing segments; only
// a REAL Hermes session id (api_<ts>_<hex>) may be reused as a Hermes session
// (codex P1) — a routing segment must mint a fresh session, not POST to a
// non-existent one.
import { describe, expect, it } from "vitest";
import {
  isHermesSessionId,
  performHermesAgentFilesOp,
  HermesTurnRegistry,
} from "../src/providers/hermes/dispatch.js";

describe("isHermesSessionId", () => {
  it("accepts the real Hermes session-id shape", () => {
    expect(isHermesSessionId("api_1783351043_b99e6df2")).toBe(true);
  });
  it("rejects OpenClaw per-turn + documentary routing segments (they carry a colon)", () => {
    expect(isHermesSessionId("turn:alice:msg_123")).toBe(false);
    expect(isHermesSessionId("documentary:msg_123")).toBe(false);
  });
  it("rejects null / empty / arbitrary strings", () => {
    expect(isHermesSessionId(null)).toBe(false);
    expect(isHermesSessionId("")).toBe(false);
    expect(isHermesSessionId("hello")).toBe(false);
  });
});

describe("HermesTurnRegistry abort targeting", () => {
  it("peek/take + deleteIf are identity-guarded (a stale cleanup keeps a newer turn)", async () => {
    const reg = new HermesTurnRegistry();
    const mk = (rid: string | null) => ({
      abort: new AbortController(),
      run: { accepted: Promise.resolve(), done: Promise.resolve(), runId: () => rid },
    });
    const t1 = mk("run-1");
    reg.set("c1", t1);
    // Old turn's stale cleanup after a newer turn registered: deleteIf must NOT
    // evict the newer entry.
    const t2 = mk("run-2");
    reg.set("c1", t2);
    reg.deleteIf("c1", t1);
    expect(reg.peek("c1")).toBe(t2);
  });
});

describe("fresh-session rotation nonces", () => {
  it("isHermesSessionId rejects rotation nonces (they must mint fresh)", async () => {
    expect(isHermesSessionId("summarize:chat_1:1700000000")).toBe(false);
    expect(isHermesSessionId("documentary:msg_1")).toBe(false);
    expect(isHermesSessionId("curate:agent_1:1700000000")).toBe(false);
  });
});

describe("performHermesAgentFilesOp (managed-files mapping)", () => {
  const mkFetcher = (files: Record<string, { content: string; mtime: number }>) => ({
    agentFilesRoot: async () => "/opt/data",
    listFiles: async () =>
      Object.entries(files).map(([name, f]) => ({
        name,
        path: `/opt/data/${name}`,
        mtime: f.mtime,
        size: f.content.length,
      })),
    listFilesStrict: async () =>
      Object.entries(files).map(([name, f]) => ({
        name,
        path: `/opt/data/${name}`,
        mtime: f.mtime,
        size: f.content.length,
      })),
    readAgentFile: async (name: string) =>
      name in files
        ? { content: files[name]!.content, missing: false }
        : { content: "", missing: true },
    writeAgentFile: async (name: string, content: string) => {
      files[name] = { content, mtime: (files[name]?.mtime ?? 0) + 5_000 };
    },
  });
  const regFor = (fetcher: unknown) =>
    ({ filesFetcherFor: () => fetcher }) as never;
  const cfg = { instanceName: "h" } as never;
  const NAMES = ["SOUL.md", "AGENTS.md"] as const;

  it("list surfaces only allowlisted files with mtime as updatedAtMs", async () => {
    const f = mkFetcher({ "SOUL.md": { content: "soul", mtime: 111 }, "notes.md": { content: "x", mtime: 2 } });
    const r = await performHermesAgentFilesOp(cfg, regFor(f), { op: "list", agentId: "a" }, NAMES);
    expect(r.status).toBe(200);
    expect((r.body as { files: unknown[] }).files).toEqual([
      { name: "SOUL.md", missing: false, updatedAtMs: 111, size: 4 },
      // An absent allowlisted file is LISTED as missing — the UI's create path.
      { name: "AGENTS.md", missing: true, updatedAtMs: null, size: null },
    ]);
  });

  it("get returns decoded content; a missing file is empty+missing", async () => {
    const f = mkFetcher({ "SOUL.md": { content: "soul", mtime: 111 } });
    const g = await performHermesAgentFilesOp(cfg, regFor(f), { op: "get", agentId: "a", name: "SOUL.md" }, NAMES);
    expect((g.body as { file: { content: string } }).file.content).toBe("soul");
    const miss = await performHermesAgentFilesOp(cfg, regFor(f), { op: "get", agentId: "a", name: "AGENTS.md" }, NAMES);
    expect((miss.body as { file: { missing: boolean } }).file.missing).toBe(true);
  });

  it("set enforces compare-and-set on mtime (stale base -> 409)", async () => {
    const f = mkFetcher({ "SOUL.md": { content: "soul", mtime: 111_000 } });
    const ok = await performHermesAgentFilesOp(
      cfg, regFor(f),
      { op: "set", agentId: "a", name: "SOUL.md", content: "v2", baseUpdatedAtMs: 111_000 },
      NAMES,
    );
    expect(ok.status).toBe(200);
    const stale = await performHermesAgentFilesOp(
      cfg, regFor(f),
      { op: "set", agentId: "a", name: "SOUL.md", content: "v3", baseUpdatedAtMs: 111_000 },
      NAMES,
    );
    expect(stale.status).toBe(409);
    // create-only (base null) on an EXISTING file also conflicts.
    const createOnExisting = await performHermesAgentFilesOp(
      cfg, regFor(f),
      { op: "set", agentId: "a", name: "SOUL.md", content: "v4", baseUpdatedAtMs: null },
      NAMES,
    );
    expect(createOnExisting.status).toBe(409);
  });
});
