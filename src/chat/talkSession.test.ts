import { describe, expect, it, vi } from "vitest";
import {
  buildCallUrl,
  endsTheCall,
  exchangeSdp,
  hangupWithRetry,
  mintedSessionDisposition,
  hidesTalkControl,
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
    // TWO SPELLINGS, one fact: Convex refuses `call_active` from its own reading, the
    // BRIDGE refuses `talk_call_active` when only the socket could tell. A second tab
    // that slipped past both Convex reads must not get the generic message with a raw
    // code instead of "hang up first" (codex P3, pass 4).
    expect(talkErrorKey("call_active")).toBe("talk_error_call_active");
    expect(talkErrorKey("talk_call_active")).toBe("talk_error_call_active");
    // The MIRROR is a different fact from "someone is already speaking", and the
    // reader acts on it differently: they wait for an answer, not for a call.
    expect(talkErrorKey("turn_in_flight")).toBe("talk_error_turn_in_flight");
    // Without this, dropping the mapping shows the generic message for a session
    // the user is told to restart.
    expect(talkErrorKey("talk_session_stale")).toBe("talk_error_session_stale");
    expect(talkErrorKey("talk_unsupported")).toBe("talk_error_unsupported");
    expect(talkErrorKey("provider_unsupported")).toBe("talk_error_unsupported");
    expect(talkErrorKey("mic_denied")).toBe("talk_error_mic_denied");
    expect(talkErrorKey("talk_secret_expired")).toBe("talk_error_secret_expired");
    expect(talkErrorKey("bridge_502")).toBe("talk_error_generic");
    expect(talkErrorKey("")).toBe("talk_error_generic");
  });
});

describe("talk voice pick (measured gateway allowlist)", () => {
  it("sanitizes to a known voice or the gateway default (empty)", async () => {
    const { sanitizeTalkVoice, TALK_VOICES } = await import("./talkSession");
    // The measured 2026.7.1 allowlist — docs-recommended french-friendly picks first.
    expect([...TALK_VOICES].sort()).toEqual(
      ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"].sort(),
    );
    expect(sanitizeTalkVoice("cedar")).toBe("cedar");
    expect(sanitizeTalkVoice("marin")).toBe("marin");
    expect(sanitizeTalkVoice("Homer")).toBe("");
    expect(sanitizeTalkVoice("")).toBe("");
    expect(sanitizeTalkVoice(null)).toBe("");
  });

  it("load/save round-trips through localStorage and clears on default", async () => {
    const { loadTalkVoice, saveTalkVoice } = await import("./talkSession");
    saveTalkVoice("cedar");
    expect(loadTalkVoice()).toBe("cedar");
    saveTalkVoice(""); // back to the gateway default
    expect(loadTalkVoice()).toBe("");
    saveTalkVoice("not-a-voice"); // sanitized away
    expect(loadTalkVoice()).toBe("");
  });
});

describe("talk mic sensitivity (server_vad threshold presets)", () => {
  it("maps levels to thresholds (higher sensitivity = lower threshold)", async () => {
    const { talkVadThreshold, sanitizeTalkVad } = await import("./talkSession");
    expect(talkVadThreshold("low")).toBe(0.8);
    expect(talkVadThreshold("medium")).toBe(0.5);
    expect(talkVadThreshold("high")).toBe(0.3);
    expect(talkVadThreshold("")).toBeNull(); // provider default: nothing sent
    expect(talkVadThreshold("nope")).toBeNull();
    expect(sanitizeTalkVad("high")).toBe("high");
    expect(sanitizeTalkVad("0.5")).toBe("");
  });

  it("persists the level and clears on default", async () => {
    const { loadTalkVad, saveTalkVad } = await import("./talkSession");
    saveTalkVad("high");
    expect(loadTalkVad()).toBe("high");
    saveTalkVad("");
    expect(loadTalkVad()).toBe("");
  });
});

describe("endsTheCall (which failures are terminal)", () => {
  it("a right or a session that is GONE ends the call", () => {
    // Every later consult fails identically: keeping the connection up leaves the
    // user speaking to an agent that can no longer be reached, while the voice model
    // apologises once per question.
    for (const code of [
      "talk_session_stale", // the handle expired or the row is gone
      "agent_restricted", // the pinned agent was revoked/deleted/retyped
      "talk_disabled", // the instance's talk gate was switched off
      "talk_unsupported", // no talk surface on this target at all
      "provider_unsupported", // the bridge's spelling of the same
      "no_agent", // nothing routable left on this chat
    ]) {
      expect(endsTheCall(code), code).toBe(true);
    }
  });

  it("a failure that could pass next time does NOT", () => {
    // Transient, or specific to the question asked: the voice model is told and the
    // conversation continues.
    for (const code of [
      "relay_failed",
      "bridge_unreachable",
      "bridge_502",
      "invalid_args",
      "talk_malformed",
      "",
    ]) {
      expect(endsTheCall(code), code).toBe(false);
    }
  });
});

describe("hidesTalkControl (when the button may disappear)", () => {
  const up = { available: true };

  it("an IDLE button is withdrawn unless the server says yes", () => {
    // ONE answer, computed server-side for the instance the session would reach and
    // FAIL CLOSED there (admin gate AND gateway capability). `undefined` is the query
    // still in flight, which is not a yes.
    expect(hidesTalkControl({ ...up, phase: "idle", available: false })).toBe(true);
    expect(
      hidesTalkControl({ ...up, phase: "idle", available: undefined }),
    ).toBe(true);
    expect(hidesTalkControl({ ...up, phase: "idle" })).toBe(false);
  });

  it("…but NOT while the server still sees a call this tab does not own", () => {
    // The recovery hangup must not vanish on the very answer that makes it needed: an
    // admin disabling talk, or the agent revoked, flips `available` to false while
    // the call goes on freezing the chat. `prepareTalkHangup` authorizes a hangup
    // after exactly those two events, so hiding the only control that can send it
    // left the freeze standing for the whole window with no way out (codex P2, pass 8).
    expect(
      hidesTalkControl({ phase: "idle", available: false, serverCall: true }),
    ).toBe(false);
    expect(
      hidesTalkControl({ phase: "idle", available: undefined, serverCall: true }),
    ).toBe(false);
    // …and with no call to end, an unavailable instance still shows nothing.
    expect(
      hidesTalkControl({ phase: "idle", available: false, serverCall: false }),
    ).toBe(true);
  });

  it("a RUNNING call is never hidden — the user would lose the controls", () => {
    // Rendering null does NOT unmount the component: React keeps it and its effects,
    // so the microphone and the peer connection stay up. What disappears are the mute
    // and hang-up buttons — an answer flipping mid-sentence would leave the user in a
    // live call with no way out.
    for (const phase of [
      "minting",
      "connecting",
      "live",
      "ending",
    ] as TalkPhase[]) {
      for (const available of [false, undefined]) {
        expect(
          hidesTalkControl({ phase, available }),
          `${phase} ${String(available)}`,
        ).toBe(false);
      }
    }
  });
});

describe("exchangeSdp — the relayed lane (GPT Live, OpenClaw >= 2026.9.5)", () => {
  const RELAYED = { offerRelay: { relayId: "r_handle" }, model: "gpt-live-1" };

  it("presents the handle and the SDP to the relay, never a fetch", async () => {
    const fetchImpl = vi.fn();
    const relayImpl = vi.fn(async () => ({ ok: true as const, answerSdp: "v=0\r\nanswer" }));
    const res = await exchangeSdp(RELAYED, "v=0\r\noffer", fetchImpl as typeof fetch, relayImpl);
    expect(res).toEqual({ ok: true, answerSdp: "v=0\r\nanswer" });
    expect(relayImpl).toHaveBeenCalledWith("r_handle", "v=0\r\noffer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a relay refusal keeps its code (the bridge speaks the same vocabulary)", async () => {
    const relayImpl = vi.fn(async () => ({ ok: false as const, code: "talk_secret_expired" }));
    expect(await exchangeSdp(RELAYED, "v=0", undefined, relayImpl)).toEqual({
      ok: false,
      code: "talk_secret_expired",
    });
  });

  it("an empty relayed answer is a failure, and a throwing relay is named", async () => {
    expect(
      await exchangeSdp(RELAYED, "v=0", undefined, async () => ({ ok: true, answerSdp: " " })),
    ).toEqual({ ok: false, code: "sdp_empty" });
    expect(
      await exchangeSdp(RELAYED, "v=0", undefined, async () => {
        throw new Error("boom");
      }),
    ).toEqual({ ok: false, code: "relay_failed" });
  });

  it("a relayed session with no relay wired is refused, not fetched", async () => {
    const fetchImpl = vi.fn();
    expect(await exchangeSdp(RELAYED, "v=0", fetchImpl as typeof fetch)).toEqual({
      ok: false,
      code: "relay_unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the direct lane sends the provider's extra headers beside the two it owns", async () => {
    const fetchImpl = vi.fn(async () => new Response("v=0\r\nanswer", { status: 200 }));
    await exchangeSdp(
      {
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        clientSecret: "ek_test",
        offerHeaders: { "OpenAI-Beta": "realtime=v1", Authorization: "Bearer stolen" },
      },
      "v=0\r\noffer",
      fetchImpl as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({
        headers: {
          "OpenAI-Beta": "realtime=v1",
          // Ours win: a header the gateway hands over cannot replace the credential.
          Authorization: "Bearer ek_test",
          "Content-Type": "application/sdp",
        },
      }),
    );
  });

  it("a provider header spelled in ANY case never rides beside ours", async () => {
    // Fetch combines same-name headers case-insensitively: `authorization` beside
    // `Authorization` reaches the wire as `Bearer stale, Bearer ours` (codex P2).
    const fetchImpl = vi.fn(async () => new Response("v=0\r\nanswer", { status: 200 }));
    await exchangeSdp(
      {
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        clientSecret: "ek_test",
        // MIXED case on purpose: an all-lowercase spelling would pass a filter that
        // forgot to normalize, since the reserved set is lowercase itself.
        offerHeaders: {
          AUTHORIZATION: "Bearer stale",
          "Content-type": "text/plain",
          "OpenAI-Beta": "realtime=v1",
        },
      },
      "v=0",
      fetchImpl as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({
      "OpenAI-Beta": "realtime=v1",
      Authorization: "Bearer ek_test",
      "Content-Type": "application/sdp",
    });
    // …and the normalized wire view agrees: exactly one value per name.
    const wire = new Headers(init.headers);
    expect(wire.get("authorization")).toBe("Bearer ek_test");
    expect(wire.get("content-type")).toBe("application/sdp");
  });

  it("a direct session missing its secret or URL is refused before any fetch", async () => {
    const fetchImpl = vi.fn();
    expect(
      await exchangeSdp({ offerUrl: "https://x", clientSecret: null }, "v=0", fetchImpl as typeof fetch),
    ).toEqual({ ok: false, code: "talk_malformed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("mintedSessionDisposition — a session that arrives after the user hung up", () => {
  it("connects while the user is still on the line, on either lane", () => {
    expect(mintedSessionDisposition({ offerRelay: { relayId: "r" } }, true)).toBe("connect");
    expect(mintedSessionDisposition({ offerRelay: null }, true)).toBe("connect");
  });
  it("hangs up AT ONCE a gateway-owned session nobody will connect to", () => {
    // The gateway holds it open on the bridge's socket, on one of two reservations
    // per socket; left alone it blocks a reservation until its TTL.
    expect(mintedSessionDisposition({ offerRelay: { relayId: "r" } }, false)).toBe("hangup-now");
  });
  it("hangs up a DIRECT session too — an unclosed one freezes the chat's agent", () => {
    // It holds no gateway resource, but the server reads the row as a live call and
    // a live call freezes the agent: dropping it silently locked the selector for
    // the whole call window (codex P1, pass 2).
    expect(mintedSessionDisposition({ offerRelay: null }, false)).toBe("hangup-now");
    expect(mintedSessionDisposition({}, false)).toBe("hangup-now");
  });
});

describe("hangupWithRetry — a hangup is not forgotten on the first blip", () => {
  const noSleep = async () => {};
  it("stops at the first success", async () => {
    const attempt = vi.fn(async () => ({ ok: true }));
    expect(await hangupWithRetry(attempt, [1, 1], noSleep)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it("retries a refusal AND a rejection, then succeeds", async () => {
    const attempt = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true });
    const slept: number[] = [];
    expect(
      await hangupWithRetry(attempt, [10, 20], async (ms) => {
        slept.push(ms);
      }),
    ).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10, 20]);
  });
  it("is BOUNDED: gives up after the delays are spent", async () => {
    const attempt = vi.fn(async () => ({ ok: false }));
    expect(await hangupWithRetry(attempt, [1, 1], noSleep)).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
