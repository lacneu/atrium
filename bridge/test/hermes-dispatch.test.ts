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
  selectPriorSession,
} from "../src/providers/hermes/dispatch.js";
import { isHermesWsStoredSessionId } from "../src/providers/hermes/ws-turn.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      run: {
        accepted: Promise.resolve(),
        done: Promise.resolve(),
        runId: () => rid,
        storedSessionId: () => null,
        markSessionUntrusted: () => {},
        settledBindings: () => Promise.resolve(),
      },
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
        ? { content: files[name]!.content, missing: false, decoded: true }
        : { content: "", missing: true, decoded: false },
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

  it("get REFUSES to present an unreadable existing file as empty", async () => {
    // An undecodable 200 used to arrive as `{content: "", missing: false}`, so the editor
    // opened a blank document over a file that exists — and saving it, with the current
    // mtime satisfying the compare-and-set, overwrote real content with nothing.
    const f = mkFetcher({ "SOUL.md": { content: "soul", mtime: 111 } });
    const unreadable = {
      ...f,
      readAgentFile: async () => ({ content: "", missing: false, decoded: false }),
    };
    const r = await performHermesAgentFilesOp(
      cfg, regFor(unreadable), { op: "get", agentId: "a", name: "SOUL.md" }, NAMES,
    );
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: { code: "UNREADABLE" } });
    // A genuinely MISSING file is still the editable create path, not an error.
    const missing = await performHermesAgentFilesOp(
      cfg, regFor(f), { op: "get", agentId: "a", name: "AGENTS.md" }, NAMES,
    );
    expect(missing.status).toBe(200);
  });

  it("set REFUSES to overwrite an existing file it could not read", async () => {
    // The `get` refusal alone was not enough: an admin action can call the write directly
    // with an `updatedAtMs` obtained from `list`, never having read the file. The CAS
    // would pass on a matching mtime and destroy real content, reporting `before: ""`.
    const f = mkFetcher({ "SOUL.md": { content: "soul", mtime: 111_000 } });
    let wrote = false;
    const unreadable = {
      ...f,
      readAgentFile: async () => ({ content: "", missing: false, decoded: false }),
      writeAgentFile: async () => {
        wrote = true;
      },
    };
    const r = await performHermesAgentFilesOp(
      cfg, regFor(unreadable),
      { op: "set", agentId: "a", name: "SOUL.md", content: "v2", baseUpdatedAtMs: 111_000 },
      NAMES,
    );
    expect(r.status).toBe(502);
    expect(wrote, "it must refuse BEFORE writing").toBe(false);
  });

  it("set still CREATES a file that does not exist yet", async () => {
    // The refusal must not break the create path: a missing file has nothing to read.
    const f = mkFetcher({});
    const r = await performHermesAgentFilesOp(
      cfg, regFor(f),
      { op: "set", agentId: "a", name: "AGENTS.md", content: "v1", baseUpdatedAtMs: null },
      NAMES,
    );
    expect(r.status).toBe(200);
  });

  it("set CONFIRMS the write from the filesystem, in the same shape as OpenClaw", async () =>{
    // Convex decides whether a write landed from `confirmed.content` and `file.missing`
    // (writeLanded). This path used to answer `missing: false` unconditionally and send
    // no confirmation at all, so an acknowledged write that never landed read as a
    // success — the editor showed "saved" and an approved curation purged its proposal.
    // A guarantee that holds for one provider and not the other is not a guarantee.
    const f = mkFetcher({ "SOUL.md": { content: "soul", mtime: 111_000 } });
    const r = await performHermesAgentFilesOp(
      cfg, regFor(f),
      { op: "set", agentId: "a", name: "SOUL.md", content: "v2", baseUpdatedAtMs: 111_000 },
      NAMES,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      before: { content: "soul" },
      confirmed: { content: "v2" },
      file: { name: "SOUL.md", missing: false },
    });
  });

  it("set reports missing when the write did NOT land", async () => {
    // A writer that silently drops the write: the response must SAY the file is absent
    // rather than assert success.
    const f = mkFetcher({});
    const swallowed = { ...f, writeAgentFile: async () => {} };
    const r = await performHermesAgentFilesOp(
      cfg, regFor(swallowed),
      { op: "set", agentId: "a", name: "AGENTS.md", content: "v1", baseUpdatedAtMs: null },
      NAMES,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      file: { missing: true },
      confirmed: { content: null },
    });
  });

  it("an UNDECODABLE read-back is reported as unverifiable, not as an empty match", async () => {
    // The Hermes read turns a malformed 200 into `content: ""`. That is
    // indistinguishable from a genuinely empty file, so a write of "" used to confirm
    // itself against a response that carried nothing at all — and Convex would mark the
    // save (or an approved curation) as landed. `decoded: false` must yield NO
    // confirmation: unverifiable, which is not the same as a match.
    const f = mkFetcher({ "AGENTS.md": { content: "", mtime: 1 } });
    // The PRE-write read decodes (else the write is refused outright, which is a
    // different guard); only the POST-write read-back is undecodable.
    let reads = 0;
    const undecodable = {
      ...f,
      readAgentFile: async () => {
        reads += 1;
        return reads === 1
          ? { content: "", missing: false, decoded: true }
          : { content: "", missing: false, decoded: false };
      },
      listFilesStrict: async () => [
        { name: "AGENTS.md", path: "/opt/data/AGENTS.md", mtime: 1, size: 0 },
      ],
    };
    const r = await performHermesAgentFilesOp(
      cfg, regFor(undecodable),
      { op: "set", agentId: "a", name: "AGENTS.md", content: "", baseUpdatedAtMs: 1 },
      NAMES,
    );
    expect(r.status).toBe(200);
    expect((r.body as { confirmed: { content: string | null } }).confirmed.content).toBe(
      null,
    );
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

describe("both transports share ONE continuity decision (lot 30)", () => {
  const TARGET = "inst\u0000agent\u0000c1";

  it("each transport continues only its OWN id shape", () => {
    const r = new HermesTurnRegistry();
    const rest = "api_1_dead";
    const ws = "20260706_212939_aee24e";
    expect(selectPriorSession(r, { chatId: "c1", openclawChatId: rest }, TARGET)).toBe(rest);
    expect(
      selectPriorSession(r, { chatId: "c1", openclawChatId: rest }, TARGET, isHermesWsStoredSessionId),
    ).toBeNull();
    expect(
      selectPriorSession(r, { chatId: "c1", openclawChatId: ws }, TARGET, isHermesWsStoredSessionId),
    ).toBe(ws);
  });

  it("a rotation nonce always means FRESH", () => {
    const r = new HermesTurnRegistry();
    r.rememberSession(TARGET, "api_9_cafe");
    expect(
      selectPriorSession(r, { chatId: "c1", openclawChatId: "summarize:x" }, TARGET),
    ).toBeNull();
  });

  it("after a drop, the MEMORY cache cannot hand the session back", () => {
    // The durable clear empties the Convex slot only. Inside the same bridge process the
    // registry still held the id, and the selector falls back to it precisely when the
    // durable field is null — so the next send resumed the very session the finalize had
    // just declared untrusted.
    const r = new HermesTurnRegistry();
    r.rememberSession(TARGET, "api_1_dead");
    // The durable clear has landed: Convex now reports no session.
    const afterClear = { chatId: "c1", openclawChatId: null };
    expect(selectPriorSession(r, afterClear, TARGET)).toBe("api_1_dead"); // the cache
    r.forgetChat("c1"); // …which the turn must also drop
    expect(selectPriorSession(r, afterClear, TARGET)).toBeNull();
  });

  it("BOTH transports call the cache drop on a silence timeout", () => {
    // Wiring, not behaviour: the test above proves the registry forgets; this proves the
    // turns ask it to. Both transports, because one of them missing it is invisible.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/providers/hermes/dispatch.ts"),
      "utf8",
    );
    expect(src.split("onSessionForgotten:").length - 1).toBe(2);
  });

  it("BOTH transports go through the shared selector — no second copy", () => {
    // A decision proven correct in isolation, and a caller that does not use it, is how
    // the WS path missed the rule the REST path had. This checks the wiring.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/providers/hermes/dispatch.ts"),
      "utf8",
    );
    expect(src.split("selectPriorSession(").length - 1).toBe(3);
    expect(src).not.toMatch(/isHermes(Ws)?(Stored)?SessionId\(body\.openclawChatId\)\s*\n?\s*\?/);
  });
});
