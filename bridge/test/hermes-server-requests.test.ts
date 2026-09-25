/// <reference types="vitest" />
//
// SERVER→CLIENT REQUESTS (Hermes 0.21.3+, tui_gateway/server_requests.py).
//
// From v2026.9.14 Hermes no longer emits `approval.request` / `clarify.request` / … events
// answered by `*.respond` methods: it sends a JSON-RPC REQUEST frame (string id `srq-…`)
// and waits for the response carrying that id; `request.cancel {id, method, reason}`
// withdraws it. From v2026.9.21 a WebSocket client that never sent
// `client.capabilities {server_requests: true}` gets every such request failed at once —
// approvals withdrawn, clarify/sudo/secret answered empty — with nothing on the wire to
// show it. These tests pin each hop: the client says it answers, routes the frame, refuses
// what nobody can show; the turn raises a card answered BY ID and releases it on cancel;
// the answer goes back through `request.answer`, whose verdict is Hermes' own.

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  HERMES_SERVER_REQUEST_EVENT,
  HermesWsClient,
} from "../src/providers/hermes/ws-client.js";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import { respondHermes, type RespondBody } from "../src/agent-request-respond.js";
import { readHermesClarify } from "../src/core/agent-requests.js";
import { harvestLostReply } from "../src/providers/hermes/dispatch.js";
import type { ConvexWriter } from "../src/convex-writer.js";

// ── the client: advertise, route, refuse ─────────────────────────────────────────────

type Frame = Record<string, unknown>;

const servers: WebSocketServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A fake `hermes serve` /api/ws: `gateway.ready` on accept, then the test's handler. */
async function fakeServe(
  onFrame: (frame: Frame, socket: WsSocket) => void,
): Promise<{ base: string; received: Frame[]; socket: () => WsSocket }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const received: Frame[] = [];
  let last: WsSocket | null = null;
  wss.on("connection", (socket) => {
    last = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      received.push(frame);
      onFrame(frame, socket);
    });
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }),
    );
  });
  const { port } = wss.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, received, socket: () => last! };
}

const reply = (socket: WsSocket, id: unknown, result: Frame) =>
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));

describe("the client says it answers server→client requests", () => {
  it("sends client.capabilities {server_requests: true} before the connect resolves", async () => {
    const serve = await fakeServe((f, s) => {
      if (f.method === "client.capabilities") reply(s, f.id, { server_requests: ["approval"] });
    });
    const client = new HermesWsClient({ baseUrl: serve.base, credential: "tok", onEvent: () => {} });
    await client.connect();
    expect(serve.received).toEqual([
      expect.objectContaining({ method: "client.capabilities", params: { server_requests: true } }),
    ]);
    client.close();
  });

  it("an older Hermes refusing the method (RPC error) still connects — it sends prompts as events", async () => {
    const serve = await fakeServe((f, s) => {
      if (f.method === "client.capabilities") {
        s.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: "unknown method" } }));
      }
    });
    const client = new HermesWsClient({ baseUrl: serve.base, credential: "tok", onEvent: () => {} });
    await expect(client.connect()).resolves.toBeUndefined();
    client.close();
  });

  it("any OTHER failure of the advertisement fails the connect — no turn may run unable to hear its questions", async () => {
    // Silence (or a dead socket) is not "an older Hermes": running turns anyway would let
    // every approval be withdrawn and every clarify answered empty, invisibly.
    const serve = await fakeServe(() => {});
    const client = new HermesWsClient({
      baseUrl: serve.base,
      credential: "tok",
      requestTimeoutMs: 200,
      onEvent: () => {},
    });
    await expect(client.connect()).rejects.toThrow(/client\.capabilities timeout/);
    client.close();
  });

  it("ONLY -32601 means an older Hermes: any other RPC refusal fails the connect (codex, 0.21.5 pass 2)", async () => {
    const serve = await fakeServe((f, s) => {
      if (f.method === "client.capabilities") {
        s.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, error: { code: -32602, message: "invalid params" } }));
      }
    });
    const client = new HermesWsClient({ baseUrl: serve.base, credential: "tok", onEvent: () => {} });
    await expect(client.connect()).rejects.toThrow(/invalid params/);
    client.close();
  });

  it("a request frame reaches its session's handler; one nobody takes is refused -32601 at once", async () => {
    const serve = await fakeServe((f, s) => {
      if (f.method === "client.capabilities") reply(s, f.id, { server_requests: [] });
    });
    const seen: Array<[string, string, string, Frame]> = [];
    const client = new HermesWsClient({
      baseUrl: serve.base,
      credential: "tok",
      onEvent: () => {},
      onServerRequest: (sid, id, method, params) => {
        seen.push([sid, id, method, params]);
        return method === "approval";
      },
    });
    await client.connect();
    const sock = serve.socket();
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-aaaaaaaaaaaa",
        method: "approval",
        params: { session_id: "sid-1", request_id: "r1", command: "rm x" },
      }),
    );
    sock.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-bbbbbbbbbbbb",
        method: "vault.code",
        params: { session_id: "sid-1" },
      }),
    );
    await vi.waitFor(() => expect(serve.received.length).toBe(2));
    expect(seen.map(([sid, id, m]) => [sid, id, m])).toEqual([
      ["sid-1", "srq-aaaaaaaaaaaa", "approval"],
      ["sid-1", "srq-bbbbbbbbbbbb", "vault.code"],
    ]);
    expect(seen[0]![3]).toMatchObject({ request_id: "r1", command: "rm x" });
    // The taken one gets no frame from the client (the turn answers it); the other is refused.
    expect(serve.received[1]).toEqual({
      jsonrpc: "2.0",
      id: "srq-bbbbbbbbbbbb",
      error: expect.objectContaining({ code: -32601 }),
    });
    client.close();
  });
});

// ── the turn: a card answered by id, released on cancel ──────────────────────────────

type Raised = Record<string, unknown>;

async function turnWith(
  emit: (send: (t: string, p: Record<string, unknown>) => void) => void,
  opts: { finish?: boolean } = {},
) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const rejected: Array<[string, string]> = [];
  const raised: Raised[] = [];
  const settled: Raised[] = [];
  const parts: unknown[] = [];
  const client = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === "session.create") return { session_id: "cc4ebdee", stored_session_id: "stored-1" };
      if (method === "prompt.submit") return { status: "streaming" };
      if (method === "request.answer") return { status: "ok" };
      return {};
    },
    rejectServerRequest: (id: string, why: string) => rejected.push([id, why]),
  };
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async (_id: string, part: unknown) => {
      parts.push(part);
    },
    setPhase: () => {},
    finalize: async () => {},
    upsertAgentRequest: async (r: Raised) => {
      raised.push(r);
    },
    settleAgentRequest: async (r: Raised) => {
      settled.push(r);
    },
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    { client: client as never, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "go" },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  const sr = (id: string, method: string, params: Record<string, unknown>) =>
    lane(HERMES_SERVER_REQUEST_EVENT, { id, method, params: { session_id: "cc4ebdee", ...params } });
  emit((t, p) => (t === "sr" ? sr(String(p.id), String(p.method), p.params as never) : lane(t, p)));
  if (opts.finish !== false) {
    lane("message.complete", { text: "fini", status: "complete" });
    await run.done;
    await new Promise((r) => setTimeout(r, 0));
  }
  return { calls, rejected, raised, settled, parts, run };
}

const srq = (id: string, method: string, params: Record<string, unknown>) =>
  (send: (t: string, p: Record<string, unknown>) => void) => send("sr", { id, method, params });

describe("a server→client request becomes a card answered BY ID", () => {
  it("approval: the srq id is the address, no queue order binds it", async () => {
    const { raised } = await turnWith(
      srq("srq-000000000001", "approval", {
        request_id: "r1",
        command: "rm -rf build",
        description: "recursive delete",
        choices: ["once", "session", "deny"],
      }),
    );
    expect(raised).toEqual([
      expect.objectContaining({
        source: "hermes.approval",
        providerRequestId: "srq-000000000001",
        answerById: true,
        sessionKey: "cc4ebdee",
        approval: expect.objectContaining({
          command: "rm -rf build",
          decisions: ["allow-once", "allow-session", "deny"],
        }),
      }),
    ]);
  });

  it("clarify (batch, multi-select), sudo and secret become their cards", async () => {
    const { raised } = await turnWith((send) => {
      send("sr", {
        id: "srq-00000000000a",
        method: "clarify",
        params: {
          questions: [
            { qid: "q0", question: "Format ?", choices: ["PDF", "Word"], multi_select: false },
            { qid: "q1", question: "Sections ?", choices: ["A", "B"], multi_select: true },
          ],
        },
      });
      send("sr", { id: "srq-00000000000b", method: "sudo", params: { command: "apt install x" } });
      send("sr", { id: "srq-00000000000c", method: "secret", params: { env_var: "API_KEY", prompt: "Clé ?" } });
    });
    expect(raised.map((r) => [r.source, r.providerRequestId, r.answerById])).toEqual([
      ["hermes.clarify", "srq-00000000000a", true],
      ["hermes.sudo", "srq-00000000000b", true],
      ["hermes.secret", "srq-00000000000c", true],
    ]);
    expect((raised[0]!.questions as Array<{ id: string; multiSelect: boolean }>).map((q) => [q.id, q.multiSelect])).toEqual([
      ["q0", false],
      ["q1", true],
    ]);
    expect(raised[2]!.credential).toEqual({ prompt: "Clé ?", envVar: "API_KEY" });
    // The password is asked WITH what it unlocks (codex, 0.21.5 pass 3).
    expect(raised[1]!.credential).toEqual({ command: "apt install x" });
  });

  it("the turn holds each request with the questions Hermes reads as multi-select, until it ends (codex, 0.21.5 pass 18)", async () => {
    const { run } = await turnWith(
      (send) => {
        send("sr", {
          id: "srq-00000000aa01",
          method: "clarify",
          params: {
            questions: [
              { qid: "q0", question: "Ville ?", choices: ["Paris, TX"], multi_select: false },
              { qid: "q1", question: "Villes ?", choices: ["New York, NY", "Boston"], multi_select: true },
              { qid: "q2", question: "Libre ?", multi_select: true },
            ],
          },
        });
        send("sr", { id: "srq-00000000aa02", method: "clarify", params: { question: "?", choices: ["A"], multi_select: true } });
        send("sr", { id: "srq-00000000aa03", method: "approval", params: { request_id: "r", command: "ls" } });
      },
      { finish: false },
    );
    expect([...(run.heldServerRequest("srq-00000000aa01")?.multiSelect ?? ["NOT HELD"])]).toEqual(["q1"]);
    expect([...(run.heldServerRequest("srq-00000000aa02")?.multiSelect ?? ["NOT HELD"])]).toEqual(["answer"]);
    expect([...(run.heldServerRequest("srq-00000000aa03")?.multiSelect ?? ["NOT HELD"])]).toEqual([]);
    expect(run.heldServerRequest("srq-unknown")).toBeNull();
    run.noteServerRequestAnswered("srq-00000000aa02");
    expect(run.heldServerRequest("srq-00000000aa02")).toBeNull();
  });

  it("a FINALIZED turn holds nothing answerable, though still registered (0.21.5 pass 25)", async () => {
    const { run } = await turnWith(
      (send) => {
        send("sr", { id: "srq-00000000ff01", method: "clarify", params: { question: "?", choices: ["A"] } });
        send("clarify.request", { request_id: "legacy-f", question: "Lequel ?" });
      },
      { finish: false },
    );
    expect(run.heldServerRequest("srq-00000000ff01")).not.toBeNull();
    expect(run.holdsRequest("legacy-f")).toBe(true);
    // The turn ends (here: forced to settle, as a lost transport does) — nothing it raised is answerable through it.
    run.forceSettle(true);
    expect(run.heldServerRequest("srq-00000000ff01")).toBeNull();
    expect(run.holdsRequest("legacy-f")).toBe(false);
  });

  it("a ≤ 0.19 prompt is held by the turn that raised it, and only by it (codex, 0.21.5 pass 19)", async () => {
    const { run, raised } = await turnWith(
      (send) => send("clarify.request", { request_id: "legacy-1", question: "Lequel ?" }),
      { finish: false },
    );
    expect(raised.map((r) => r.providerRequestId)).toEqual(["legacy-1"]);
    expect(run.holdsRequest("legacy-1")).toBe(true);
    expect(run.holdsRequest("legacy-2")).toBe(false);
  });

  it("request.cancel closes the card: expired on a deadline, no longer awaited otherwise", async () => {
    const { settled } = await turnWith((send) => {
      send("sr", { id: "srq-0000000000d1", method: "clarify", params: { question: "Oui ?" } });
      send("sr", { id: "srq-0000000000d2", method: "approval", params: { request_id: "r", command: "ls" } });
      send("request.cancel", { id: "srq-0000000000d1", method: "clarify", reason: "timeout" });
      send("request.cancel", { id: "srq-0000000000d2", method: "approval", reason: "resolved" });
    });
    expect(settled.slice(0, 2)).toEqual([
      { chatId: "c1", providerRequestId: "srq-0000000000d1", status: "expired" },
      { chatId: "c1", providerRequestId: "srq-0000000000d2", status: "cancelled" },
    ]);
  });

  it("terminal.read is answered empty through request.answer; an unknown or unshowable request is REFUSED", async () => {
    const { calls, rejected, raised } = await turnWith((send) => {
      send("sr", { id: "srq-0000000000e1", method: "terminal.read", params: {} });
      send("sr", { id: "srq-0000000000e2", method: "approval", params: { request_id: "r" } });
    });
    expect(calls).toContainEqual(["request.answer", { id: "srq-0000000000e1", result: { value: "" } }]);
    expect(rejected.map(([id]) => id)).toEqual(["srq-0000000000e2"]);
    expect(raised).toEqual([]);
  });

  it("an open request HOLDS the turn past the silence deadline; its cancel releases it", async () => {
    vi.useFakeTimers();
    try {
      const { run } = await turnWith(
        (send) => send("sr", { id: "srq-0000000000f1", method: "clarify", params: { question: "?" } }),
        { finish: false },
      );
      let done = false;
      void run.done.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(done, "a person is being asked: not a silence").toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a connection card (manage_connections, Hermes 0.21) blocks the tool", () => {
  it("the turn outlasts the SERVER's deadline instead of dying first as a silence", async () => {
    vi.useFakeTimers();
    try {
      const { run, parts } = await turnWith(
        (send) => send("connection.request", { op_id: "op-1", seq: 1, deadline_at: 0, timeout_seconds: 300, targets: [] }),
        { finish: false },
      );
      let done = false;
      void run.done.then(() => {
        done = true;
      });
      // Past the ordinary 240 s silence deadline, inside the server's 300 s.
      await vi.advanceTimersByTimeAsync(280_000);
      expect(done).toBe(false);
      expect(JSON.stringify(parts)).toContain("hermes.connection");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── the answer: `request.answer {id, result}`, Hermes' own verdict ───────────────────

const body = (over: Partial<RespondBody>): RespondBody => ({
  chatId: "c1",
  instanceName: "hermes",
  provider: "hermes",
  source: "hermes.clarify",
  providerRequestId: "srq-000000000099",
  sessionKey: "cc4ebdee",
  skip: false,
  answerById: true,
  ...over,
});

describe("an answer by id goes back through request.answer", () => {
  const rpc = (status = "ok") => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const call = async (m: string, p: Record<string, unknown>) => {
      sent.push([m, p]);
      return { status };
    };
    return { sent, call };
  };
  /** The chat's live turn holding the request, with its multi-select question ids. */
  const holding = (multi: string[] = []) => ({
    head: () => null,
    ambiguity: () => null,
    answered: () => {},
    uncertain: () => {},
    held: (id: string) => (id === "srq-000000000099" ? { multiSelect: new Set(multi) } : null),
  });

  it("each kind answers with its contract's result shape", async () => {
    const cases: Array<[Partial<RespondBody>, Record<string, unknown>, string[]?]> = [
      [{ source: "hermes.approval", decision: "allow-session" }, { choice: "session" }],
      [{ answers: [{ id: "answer", values: ["PDF"] }] }, { answer: "PDF" }],
      [{ answers: [{ id: "answer", values: ["A", "B,C"] }] }, { answer: '["A","B,C"]' }, ["answer"]],
      [
        { answers: [{ id: "q0", values: ["PDF"] }, { id: "q1", values: ["A", "B"] }] },
        { answers: { q0: "PDF", q1: '["A","B"]' } },
        ["q1"],
      ],
      [{ skip: true, answers: [{ id: "answer", values: [] }] }, { answer: "" }],
      [{ skip: true, answers: [{ id: "q0", values: [] }] }, {}],
      [{ source: "hermes.sudo", secret: "pw" }, { value: "pw" }],
      [{ source: "hermes.secret", skip: true }, { value: "" }],
    ];
    for (const [over, result, multi] of cases) {
      const r = rpc();
      const out = await respondHermes(body(over), r.call as never, holding(multi));
      expect(out, JSON.stringify(over)).toEqual({ ok: true });
      expect(r.sent).toEqual([["request.answer", { id: "srq-000000000099", result }]]);
    }
  });

  it("`expired` means the request had already ended — gone, and the turn is released", async () => {
    const served: string[] = [];
    const r = rpc("expired");
    const out = await respondHermes(
      body({ source: "hermes.approval", decision: "deny" }),
      r.call as never,
      { ...holding(), served: (id) => served.push(id) },
    );
    expect(out).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
    expect(served).toEqual(["srq-000000000099"]);
  });

  it("a retry after a LOST reply is told the request is over AS ANSWERED, never expired (codex, 0.21.5 passes 26 and 28)", async () => {
    const taken = new Map<string, string>();
    const turn = {
      ...holding(),
      served: (id: string, verdict?: string) => {
        if (verdict !== undefined) taken.set(id, verdict);
      },
    };
    const answeredAs = (id: string) => (taken.get(id) ?? null) as never;
    const first = rpc();
    expect(await respondHermes(body({ source: "hermes.approval", decision: "deny" }), first.call as never, turn, answeredAs)).toEqual({ ok: true });
    // Our reply was lost; the card reopened and the person answers again.
    const gone = { ok: false, httpStatus: 409, code: "request_gone", status: "denied" };
    const retry = rpc();
    expect(await respondHermes(body({ source: "hermes.approval", decision: "allow-once" }), retry.call as never, turn, answeredAs)).toEqual(gone);
    // …or once the turn has ENDED (no live turn at all): still known, still not expired.
    expect(await respondHermes(body({ source: "hermes.approval", decision: "allow-once" }), retry.call as never, undefined, answeredAs)).toEqual(gone);
    expect(retry.sent).toEqual([]);
    // A skip is remembered as the cancel it was.
    taken.clear();
    await respondHermes(body({ skip: true, answers: [{ id: "answer", values: [] }] }), rpc().call as never, turn, answeredAs);
    expect(taken.get("srq-000000000099")).toBe("cancelled");
  });


  it("ONE multi-select choice still goes as a JSON array — a comma in it is not two answers (codex, 0.21.5 pass 18)", async () => {
    // Hermes splits any non-array multi-select answer on commas (clarify_tool.py
    // `_parse_multi_select_response`): "New York, NY" alone would reach the agent as two.
    const single = rpc();
    await respondHermes(body({ answers: [{ id: "answer", values: ["New York, NY"] }] }), single.call as never, holding(["answer"]));
    expect(single.sent[0]![1].result).toEqual({ answer: '["New York, NY"]' });
    const batch = rpc();
    await respondHermes(
      body({ answers: [{ id: "q0", values: ["Paris, TX"] }, { id: "q1", values: ["New York, NY"] }] }),
      batch.call as never,
      holding(["q1"]),
    );
    // Only the multi-select question is an array; the single-choice one stays verbatim.
    expect(batch.sent[0]![1].result).toEqual({ answers: { q0: "Paris, TX", q1: '["New York, NY"]' } });
  });

  it("is NEVER sent unless the chat's live turn holds the request (codex, 0.21.5 pass 18)", async () => {
    // After a bridge restart Hermes still holds the request and resolves `request.answer`
    // by id alone: answering would release a run no reader here observes.
    const none = rpc();
    expect(await respondHermes(body({ source: "hermes.approval", decision: "allow-once" }), none.call as never)).toEqual({
      ok: false,
      httpStatus: 409,
      code: "request_gone",
      status: "expired",
    });
    const other = rpc();
    const out = await respondHermes(
      body({ source: "hermes.approval", decision: "allow-once" }),
      other.call as never,
      { ...holding(), held: () => null },
    );
    expect(out).toEqual({ ok: false, httpStatus: 409, code: "request_gone", status: "expired" });
    expect([...none.sent, ...other.sent]).toEqual([]);
  });

  it("never touches the session queue — no head is needed to answer by id", async () => {
    const r = rpc();
    const out = await respondHermes(body({ source: "hermes.approval", decision: "deny" }), r.call as never, {
      ...holding(),
      head: () => "some-other",
      ambiguity: () => "several",
    });
    expect(out).toEqual({ ok: true });
    expect(r.sent.map(([m]) => m)).toEqual(["request.answer"]);
  });
});

describe("the clarify reader", () => {
  it("reads the batch by qid and refuses a batch with one unreadable entry", () => {
    expect(
      readHermesClarify({ questions: [{ qid: "q0", question: "A ?" }, { qid: "q1", question: "B ?", choices: ["x"], multi_select: true }] })?.map((q) => [q.id, q.multiSelect]),
    ).toEqual([
      ["q0", false],
      ["q1", true],
    ]);
    expect(readHermesClarify({ questions: [{ qid: "q0", question: "A ?" }, { question: "no qid" }] })).toBeNull();
    // multi_select without choices is free text, not a multi-select.
    expect(readHermesClarify({ question: "?", multi_select: true })?.[0]?.multiSelect).toBe(false);
  });
});

// ── requests no card will show are REFUSED, never swallowed (0.21.5 review pass 1) ───

/** A turn whose ACK the test controls, with a gate to land events BEFORE it. */
async function ackedTurn(opts: {
  ack: string;
  resume?: Record<string, unknown>;
  beforeAck?: (send: (t: string, p: Record<string, unknown>) => void) => void;
}) {
  const rejected: string[] = [];
  const raised: Raised[] = [];
  let releaseSubmit!: () => void;
  const gate = new Promise<void>((r) => {
    releaseSubmit = r;
  });
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const client = {
    call: async (method: string) => {
      if (method === "session.resume") {
        return { session_id: "cc4ebdee", stored_session_id: "20260706_212939_aee24e", ...opts.resume };
      }
      if (method === "session.create") return { session_id: "cc4ebdee", stored_session_id: "stored-1" };
      if (method === "prompt.submit") {
        await gate;
        return { status: opts.ack };
      }
      return { status: "ok" };
    },
    rejectServerRequest: (id: string) => rejected.push(id),
  };
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async () => {},
    addToolPart: async () => {},
    setPhase: () => {},
    finalize: async () => {},
    upsertAgentRequest: async (r: Raised) => {
      raised.push(r);
    },
    settleAgentRequest: async () => {},
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  const run = runHermesWsTurn(
    {
      client: client as never,
      writer,
      chatId: "c1",
      sessionKey: "k",
      providerChatId: opts.resume ? "20260706_212939_aee24e" : null,
      text: "go",
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await new Promise((r) => setTimeout(r, 0));
  opts.beforeAck?.((t, p) => lane(t, p));
  releaseSubmit();
  await run.accepted;
  return { run, lane: (t: string, p: Record<string, unknown>) => lane(t, p), rejected, raised };
}

const ask = (id: string) => [
  HERMES_SERVER_REQUEST_EVENT,
  { id, method: "clarify", params: { session_id: "cc4ebdee", question: "?" } },
] as const;

describe("a request this turn will not show is refused -32601, not swallowed", () => {
  it("held before a STEERED / REDIRECTED ACK: it belongs to the run our text joined", async () => {
    for (const ack of ["steered", "redirected"]) {
      const { rejected, raised } = await ackedTurn({ ack, beforeAck: (send) => send(...ask("srq-00000000aa01")) });
      expect(rejected, ack).toEqual(["srq-00000000aa01"]);
      expect(raised, ack).toEqual([]);
    }
  });

  it("QUEUED: before our message.start it is the interrupted run's; after it, ours", async () => {
    const t = await ackedTurn({
      ack: "queued",
      beforeAck: (send) => send(...ask("srq-00000000aa02")),
    });
    expect(t.rejected).toEqual(["srq-00000000aa02"]);
    t.lane("message.start", {});
    t.lane(...ask("srq-00000000aa03"));
    expect(t.raised.map((r) => r.providerRequestId)).toEqual(["srq-00000000aa03"]);
  });

  it("QUEUED with our message.start already held: the request before it is refused, the one after it shown", async () => {
    const t = await ackedTurn({
      ack: "queued",
      beforeAck: (send) => {
        send(...ask("srq-00000000aa05"));
        send("message.start", {});
        send(...ask("srq-00000000aa06"));
      },
    });
    expect(t.rejected).toEqual(["srq-00000000aa05"]);
    expect(t.raised.map((r) => r.providerRequestId)).toEqual(["srq-00000000aa06"]);
  });

  it("on a FINALIZED turn", async () => {
    const t = await ackedTurn({ ack: "streaming" });
    t.lane("message.complete", { text: "fini", status: "complete" });
    await t.run.done;
    t.lane(...ask("srq-00000000aa04"));
    expect(t.rejected).toEqual(["srq-00000000aa04"]);
  });
});

describe("a request left open by a LOST run is refused at the resume (codex, 0.21.5 passes 1 and 6)", () => {
  it("open_requests are withdrawn before the new prompt, never shown by a turn that cannot own them", async () => {
    // A request still open means the run is BLOCKED on a person: the new prompt can only be
    // queued or redirected into it, never ACKed `streaming`, so no turn carries its card.
    const t = await ackedTurn({
      ack: "redirected",
      resume: {
        open_requests: [
          { id: "srq-00000000bb01", method: "clarify", params: { session_id: "cc4ebdee", question: "Lequel ?" } },
          { id: "srq-00000000bb02", method: "approval", params: { session_id: "cc4ebdee", command: "rm x" } },
        ],
      },
    });
    expect(t.rejected).toEqual(["srq-00000000bb01", "srq-00000000bb02"]);
    expect(t.raised).toEqual([]);
  });

  it("the lost-reply recovery refuses what a still-running lost run waits on", async () => {
    const rejected: string[] = [];
    const client = {
      call: async () => ({
        stored_session_id: "20260706_212939_aee24e",
        running: true,
        open_requests: [{ id: "srq-00000000bb03", method: "clarify", params: {} }],
      }),
      rejectServerRequest: (id: string) => rejected.push(id),
    };
    await expect(harvestLostReply(client as never, "20260706_212939_aee24e")).resolves.toBeNull();
    expect(rejected).toEqual(["srq-00000000bb03"]);
  });
});

describe("0.21.5 review pass 2", () => {
  it("a clarify batch past upstream's bound is refused, not taken and left without a card", async () => {
    const qs = [0, 1, 2, 3, 4, 5].map((i) => ({ qid: `q${i}`, question: `Q${i} ?` }));
    const { rejected, raised } = await turnWith((send) =>
      send("sr", { id: "srq-00000000cc01", method: "clarify", params: { questions: qs } }),
    );
    expect(raised).toEqual([]);
    expect(rejected.map(([id]) => id)).toEqual(["srq-00000000cc01"]);
  });

  it("a request answered by ANOTHER client (no request.cancel) is closed once Hermes no longer lists it", async () => {
    // Concurrent tools: movement alone proves nothing, so Hermes is ASKED which are open.
    const settled: Raised[] = [];
    const probes: string[] = [];
    let open = ["srq-00000000dd01", "srq-00000000dd02"];
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const client = {
      call: async (method: string) => {
        if (method === "session.create") return { session_id: "cc4ebdee", stored_session_id: "s" };
        if (method === "prompt.submit") return { status: "streaming" };
        if (method === "session.events.since") {
          probes.push(method);
          return { events: [], open_requests: open.map((id) => ({ id, method: "clarify", params: {} })) };
        }
        return {};
      },
      rejectServerRequest: () => {},
    };
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addPart: async () => {},
      addToolPart: async () => {},
      setPhase: () => {},
      finalize: async () => {},
      upsertAgentRequest: async () => {},
      settleAgentRequest: async (r: Raised) => {
        settled.push(r);
      },
      reportSessionMeta: async () => {},
      heartbeat: async () => {},
      upsertSubAgent: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    } as unknown as ConvexWriter;
    const run = runHermesWsTurn(
      { client: client as never, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "go" },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    for (const id of open) {
      lane(HERMES_SERVER_REQUEST_EVENT, { id, method: "clarify", params: { session_id: "cc4ebdee", question: "?" } });
    }
    // A neighbour tool completes while both are still open: nothing closes.
    lane("tool.complete", { name: "ls" });
    await vi.waitFor(() => expect(probes.length).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toEqual([]);
    // Another client answers dd01: Hermes stops listing it, and the next movement closes it.
    open = ["srq-00000000dd02"];
    lane("tool.complete", { name: "cat" });
    await vi.waitFor(() =>
      expect(settled).toEqual([{ chatId: "c1", providerRequestId: "srq-00000000dd01", status: "cancelled" }]),
    );
    lane("message.complete", { text: "fini", status: "complete" });
    await run.done;
  });
});

describe("0.21.5 review pass 22", () => {
  it("a request raised WHILE the reconcile probe is on the wire is not closed by its snapshot", async () => {
    const settled: Raised[] = [];
    let answerProbe!: (r: Record<string, unknown>) => void;
    let lane!: (t: string, p: Record<string, unknown>) => void;
    const client = {
      call: async (method: string) => {
        if (method === "session.create") return { session_id: "cc4ebdee", stored_session_id: "s" };
        if (method === "prompt.submit") return { status: "streaming" };
        if (method === "session.events.since") return new Promise((r) => (answerProbe = r));
        return {};
      },
      rejectServerRequest: () => {},
    };
    const writer = {
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addPart: async () => {},
      addToolPart: async () => {},
      setPhase: () => {},
      finalize: async () => {},
      upsertAgentRequest: async () => {},
      settleAgentRequest: async (r: Raised) => {
        settled.push(r);
      },
      reportSessionMeta: async () => {},
      heartbeat: async () => {},
      upsertSubAgent: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    } as unknown as ConvexWriter;
    const run = runHermesWsTurn(
      { client: client as never, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "go" },
      (_sid, cb) => {
        lane = cb.onEvent;
        return () => {};
      },
    );
    await run.accepted;
    const sr = (id: string) =>
      lane(HERMES_SERVER_REQUEST_EVENT, { id, method: "clarify", params: { session_id: "cc4ebdee", question: "?" } });
    sr("srq-00000000ee01");
    lane("tool.complete", { name: "ls" }); // the probe leaves, A open
    await vi.waitFor(() => expect(answerProbe).toBeTypeOf("function"));
    sr("srq-00000000ee02"); // B raised while the probe is on the wire
    answerProbe({ events: [], open_requests: [{ id: "srq-00000000ee01", method: "clarify", params: {} }] });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toEqual([]);
    expect(run.heldServerRequest("srq-00000000ee02")).not.toBeNull();
    lane("message.complete", { text: "fini", status: "complete" });
    await run.done;
  });
});

describe("0.21.5 review pass 4", () => {
  it("a request whose card can never be recorded is REFUSED and stops holding the turn", async () => {
    // Taken by the registry, so the client will not refuse it: the turn must — or Hermes
    // waits (without limit when its clarify timeout is <= 0) for a card that never exists.
    vi.useFakeTimers();
    try {
      const rejected: string[] = [];
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const client = {
        call: async (method: string) => {
          if (method === "session.create") return { session_id: "cc4ebdee", stored_session_id: "s" };
          if (method === "prompt.submit") return { status: "streaming" };
          return {};
        },
        rejectServerRequest: (id: string) => rejected.push(id),
      };
      const writer = {
        startAssistant: async () => "msg-1",
        appendDelta: async () => {},
        setSnapshot: async () => true,
        addPart: async () => {},
        addToolPart: async () => {},
        setPhase: () => {},
        finalize: async () => {},
        upsertAgentRequest: async () => {
          throw new Error("ingest 503");
        },
        settleAgentRequest: async () => {},
        reportSessionMeta: async () => {},
        heartbeat: async () => {},
        upsertSubAgent: async () => {},
        getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      } as unknown as ConvexWriter;
      const run = runHermesWsTurn(
        { client: client as never, writer, chatId: "c1", sessionKey: "k", providerChatId: null, text: "go" },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane(HERMES_SERVER_REQUEST_EVENT, {
        id: "srq-00000000ff01",
        method: "clarify",
        params: { session_id: "cc4ebdee", question: "?" },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(rejected).toEqual(["srq-00000000ff01"]);
      // …and the hold is gone: the ordinary silence deadline applies again.
      let done = false;
      void run.done.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("0.21.5 review pass 5", () => {
  const baseWriter = (over: Record<string, unknown>) =>
    ({
      startAssistant: async () => "msg-1",
      appendDelta: async () => {},
      setSnapshot: async () => true,
      addPart: async () => {},
      addToolPart: async () => {},
      setPhase: () => {},
      finalize: async () => {},
      upsertAgentRequest: async () => {},
      settleAgentRequest: async () => {},
      reportSessionMeta: async () => {},
      heartbeat: async () => {},
      upsertSubAgent: async () => {},
      getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
      ...over,
    }) as unknown as ConvexWriter;

  it("a turn that fails to open its bubble refuses the requests it replayed from the resume", async () => {
    const rejected: string[] = [];
    const client = {
      call: async (method: string) => {
        if (method === "session.resume") {
          return {
            session_id: "cc4ebdee",
            stored_session_id: "20260706_212939_aee24e",
            open_requests: [{ id: "srq-00000000ab01", method: "clarify", params: { question: "?" } }],
          };
        }
        return {};
      },
      rejectServerRequest: (id: string) => rejected.push(id),
    };
    const run = runHermesWsTurn(
      {
        client: client as never,
        writer: baseWriter({
          startAssistant: async () => {
            throw new Error("convex down");
          },
        }),
        chatId: "c1",
        sessionKey: "k",
        providerChatId: "20260706_212939_aee24e",
        text: "go",
      },
      () => () => {},
    );
    await expect(run.accepted).rejects.toThrow();
    expect(rejected).toEqual(["srq-00000000ab01"]);
  });

  it("a card Convex REFUSED to record (id: null) is refused to Hermes, not held", async () => {
    vi.useFakeTimers();
    try {
      const rejected: string[] = [];
      let lane!: (t: string, p: Record<string, unknown>) => void;
      const client = {
        call: async (method: string) => {
          if (method === "session.create") return { session_id: "cc4ebdee", stored_session_id: "s" };
          if (method === "prompt.submit") return { status: "streaming" };
          return {};
        },
        rejectServerRequest: (id: string) => rejected.push(id),
      };
      const run = runHermesWsTurn(
        {
          client: client as never,
          writer: baseWriter({ upsertAgentRequest: async () => ({ recorded: false }) }),
          chatId: "c1",
          sessionKey: "k",
          providerChatId: null,
          text: "go",
        },
        (_sid, cb) => {
          lane = cb.onEvent;
          return () => {};
        },
      );
      await run.accepted;
      lane(HERMES_SERVER_REQUEST_EVENT, {
        id: "srq-00000000ab02",
        method: "clarify",
        params: { session_id: "cc4ebdee", question: "?" },
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(rejected).toEqual(["srq-00000000ab02"]);
      lane("message.complete", { text: "fini", status: "complete" });
      await run.done;
    } finally {
      vi.useRealTimers();
    }
  });
});
