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

describe("a suspect session is quarantined until its clear is confirmed (lot 30)", () => {
  // The in-memory forget is not enough: the send path prefers the PERSISTED
  // `openclawChatId` over the registry, so between a timeout and a successful
  // `clearProviderChat` — a window a concurrent Stop widens by releasing the chat — the
  // next send would resume exactly the session whose run may never have stopped.

  const TARGET = "inst\u0000agent\u0000c1";

  it("a QUARANTINED chat gets a fresh session even with a persisted id", () => {
    const r = new HermesTurnRegistry();
    r.rememberSession(TARGET, "api_1_dead");
    const body = { chatId: "c1", openclawChatId: "api_1_dead" };
    expect(selectPriorSession(r, body, TARGET)).toBe("api_1_dead");
    r.quarantine("c1");
    expect(selectPriorSession(r, body, TARGET)).toBeNull();
    r.releaseQuarantine("c1");
    expect(selectPriorSession(r, body, TARGET)).toBe("api_1_dead");
  });

  it("quarantine also overrides the in-memory fallback", () => {
    const r = new HermesTurnRegistry();
    r.rememberSession(TARGET, "api_2_beef");
    const body = { chatId: "c1", openclawChatId: null };
    expect(selectPriorSession(r, body, TARGET)).toBe("api_2_beef");
    r.quarantine("c1");
    expect(selectPriorSession(r, body, TARGET)).toBeNull();
  });

  it("the WS transport — the DEFAULT — obeys the quarantine too", () => {
    // The first version hard-coded the REST validator, so the WS path kept its own copy
    // of the selection and never consulted the quarantine at all. Same blind spot, third
    // time in one programme.
    const r = new HermesTurnRegistry();
    const stored = "20260706_212939_aee24e"; // the WS stored_session_id shape
    const body = { chatId: "c1", openclawChatId: stored };
    expect(selectPriorSession(r, body, TARGET, isHermesWsStoredSessionId)).toBe(stored);
    r.quarantine("c1");
    expect(selectPriorSession(r, body, TARGET, isHermesWsStoredSessionId)).toBeNull();
  });

  it("neither transport continues the OTHER's id shape", () => {
    const r = new HermesTurnRegistry();
    expect(
      selectPriorSession(r, { chatId: "c1", openclawChatId: "api_1_dead" }, TARGET, isHermesWsStoredSessionId),
    ).toBeNull();
  });

  it("BOTH transports go through the shared selector — no second copy", () => {
    // The tests above drive the FUNCTION. They stayed green when the WS call site was
    // replaced by its own inline ternary, which is exactly how the blind spot survived
    // the first time: a decision proven correct in isolation, and a caller that does not
    // use it. This checks the wiring.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/providers/hermes/dispatch.ts"),
      "utf8",
    );
    const calls = src.split("selectPriorSession(").length - 1;
    // one declaration + one call per transport
    expect(calls).toBe(3);
    // …and no hand-rolled continuity ternary survives anywhere else.
    expect(src).not.toMatch(/isHermes(Ws)?(Stored)?SessionId\(body\.openclawChatId\)\s*\n?\s*\?/);
  });

  it("the registry refuses a quarantined chat until released", () => {
    const r = new HermesTurnRegistry();
    expect(r.isQuarantined("c1")).toBe(false);
    r.quarantine("c1");
    expect(r.isQuarantined("c1")).toBe(true);
    r.releaseQuarantine("c1");
    expect(r.isQuarantined("c1")).toBe(false);
  });

  it("quarantine is per chat — one timeout does not blind the others", () => {
    const r = new HermesTurnRegistry();
    r.quarantine("c1");
    expect(r.isQuarantined("c2")).toBe(false);
  });
});
