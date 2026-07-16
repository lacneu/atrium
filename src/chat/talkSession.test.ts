import { describe, expect, it, vi } from "vitest";
import {
  buildCallUrl,
  exchangeSdp,
  nextTalkPhase,
  parseTalkToolCall,
  talkErrorKey,
  type TalkPhase,
} from "./talkSession";

describe("nextTalkPhase (transition matrix)", () => {
  it("walks the happy path idle -> minting -> connecting -> live -> ending -> idle", () => {
    expect(nextTalkPhase("idle", "start")).toBe("minting");
    expect(nextTalkPhase("minting", "minted")).toBe("connecting");
    expect(nextTalkPhase("connecting", "connected")).toBe("live");
    expect(nextTalkPhase("live", "hangup")).toBe("ending");
    expect(nextTalkPhase("ending", "ended")).toBe("idle");
  });

  it("refuses stale/out-of-order events (returns null, caller ignores)", () => {
    // a late "connected" after the user already hung up must NOT resurrect
    const stale: Array<[TalkPhase, Parameters<typeof nextTalkPhase>[1]]> = [
      ["ending", "connected"],
      ["ending", "minted"],
      ["idle", "minted"],
      ["idle", "connected"],
      ["idle", "hangup"],
      ["idle", "ended"],
      ["live", "minted"],
      ["minting", "connected"],
      ["live", "start"], // double-press start while live
      ["minting", "start"],
    ];
    for (const [phase, event] of stale) {
      expect(nextTalkPhase(phase, event), `${phase} + ${event}`).toBeNull();
    }
  });

  it("failures during any active phase converge on ending", () => {
    expect(nextTalkPhase("minting", "failed")).toBe("ending");
    expect(nextTalkPhase("connecting", "failed")).toBe("ending");
    expect(nextTalkPhase("live", "failed")).toBe("ending");
    // a failure once already ending changes nothing (teardown owns the exit)
    expect(nextTalkPhase("ending", "failed")).toBeNull();
  });
});

describe("buildCallUrl (the model rides the calls endpoint as a query param)", () => {
  it("appends the model — omitting it 500s on the real offer (live repro)", () => {
    expect(
      buildCallUrl("https://api.openai.com/v1/realtime/calls", "gpt-realtime-2.1"),
    ).toBe("https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2.1");
    // an offerUrl already carrying a query gets & (future gateways)
    expect(buildCallUrl("https://x.example/calls?región=eu", "m/1")).toBe(
      "https://x.example/calls?región=eu&model=m%2F1",
    );
  });
  it("no model -> the URL is untouched", () => {
    expect(buildCallUrl("https://x.example/calls", null)).toBe("https://x.example/calls");
    expect(buildCallUrl("https://x.example/calls", "")).toBe("https://x.example/calls");
  });
});

describe("exchangeSdp (browser <-> provider handshake)", () => {
  const SESSION = {
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    clientSecret: "ek_test",
  };

  it("POSTs the offer with the Bearer secret and returns the answer SDP", async () => {
    const fetchImpl = vi.fn(async () => new Response("v=0\r\nanswer", { status: 200 }));
    const res = await exchangeSdp(SESSION, "v=0\r\noffer", fetchImpl as typeof fetch);
    expect(res).toEqual({ ok: true, answerSdp: "v=0\r\nanswer" });
    expect(fetchImpl).toHaveBeenCalledWith(SESSION.offerUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer ek_test",
        "Content-Type": "application/sdp",
      },
      body: "v=0\r\noffer",
    });
  });

  it("carries the minted model on the call URL (the live-repro fix)", async () => {
    const fetchImpl = vi.fn(async () => new Response("v=0\r\nanswer", { status: 200 }));
    const res = await exchangeSdp(
      { ...SESSION, model: "gpt-realtime-2.1" },
      "v=0\r\noffer",
      fetchImpl as typeof fetch,
    );
    expect(res).toEqual({ ok: true, answerSdp: "v=0\r\nanswer" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2.1",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps a 401 to talk_secret_expired (retry-able mint)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    expect(await exchangeSdp(SESSION, "o", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "talk_secret_expired",
    });
  });

  it("other HTTP failures carry their status; empty answers are refused", async () => {
    const fetch500 = vi.fn(async () => new Response("x", { status: 500 }));
    expect(await exchangeSdp(SESSION, "o", fetch500 as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_500",
    });
    const fetchEmpty = vi.fn(async () => new Response("   ", { status: 200 }));
    expect(await exchangeSdp(SESSION, "o", fetchEmpty as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_empty",
    });
  });

  it("network errors never throw (coded result)", async () => {
    const fetchBoom = vi.fn(async () => {
      throw new Error("net");
    });
    expect(await exchangeSdp(SESSION, "o", fetchBoom as unknown as typeof fetch)).toEqual({
      ok: false,
      code: "sdp_unreachable",
    });
  });
});

describe("parseTalkToolCall (provider data-channel events)", () => {
  it("extracts a function call from response.output_item.done", () => {
    const raw = JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "openclaw_agent_consult",
        arguments: '{"question":"météo demain ?"}',
      },
    });
    expect(parseTalkToolCall(raw)).toEqual({
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "météo demain ?" },
    });
  });

  it("extracts from response.function_call_arguments.done too", () => {
    const raw = JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "call_2",
      name: "openclaw_agent_control",
      arguments: '{"text":"annule","mode":"cancel"}',
    });
    expect(parseTalkToolCall(raw)).toEqual({
      callId: "call_2",
      name: "openclaw_agent_control",
      args: { text: "annule", mode: "cancel" },
    });
  });

  it("ignores non-tool events, message items, and garbage", () => {
    expect(parseTalkToolCall(JSON.stringify({ type: "response.done" }))).toBeNull();
    expect(
      parseTalkToolCall(
        JSON.stringify({
          type: "response.output_item.done",
          item: { type: "message", content: [] },
        }),
      ),
    ).toBeNull();
    expect(parseTalkToolCall("not json")).toBeNull();
    expect(parseTalkToolCall("null")).toBeNull();
    expect(
      parseTalkToolCall(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "",
          name: "x",
        }),
      ),
    ).toBeNull();
  });

  it("malformed model-emitted argument JSON degrades to empty args (never throws)", () => {
    const raw = JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "call_3",
      name: "openclaw_agent_consult",
      arguments: "{broken",
    });
    expect(parseTalkToolCall(raw)).toEqual({
      callId: "call_3",
      name: "openclaw_agent_consult",
      args: {},
    });
  });
});

describe("talkErrorKey (total mapping)", () => {
  it("maps known codes and collapses the rest onto generic", () => {
    expect(talkErrorKey("talk_disabled")).toBe("talk_error_disabled");
    expect(talkErrorKey("talk_unsupported")).toBe("talk_error_unsupported");
    expect(talkErrorKey("provider_unsupported")).toBe("talk_error_unsupported");
    expect(talkErrorKey("mic_denied")).toBe("talk_error_mic_denied");
    expect(talkErrorKey("talk_secret_expired")).toBe("talk_error_secret_expired");
    expect(talkErrorKey("bridge_502")).toBe("talk_error_generic");
    expect(talkErrorKey("")).toBe("talk_error_generic");
  });
});
