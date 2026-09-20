// Realtime voice ("talk") — the composer's live-conversation control.
//
// Click -> mint an ephemeral session (Convex action -> bridge -> gateway,
// which holds the provider key) -> open a browser-owned WebRTC connection
// straight to the provider (mic up, agent voice down) -> a compact live pill
// with mute + hang-up. The gateway's talk config (brain/voice/VAD) drives the
// session; barge-in is provider-native.
//
// CONCURRENCY (the detached-composer lesson, applied from day one): every
// async step is guarded by a GENERATION captured at start — a hang-up or a
// re-start orphans in-flight steps, which then clean up their own resources
// and touch nothing. Phase transitions go through the tested nextTalkPhase
// matrix; an illegal transition is ignored (stale event), never applied.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { AudioLines, ChevronDown, Mic, MicOff, PhoneOff } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { useToast } from "@/components/ui/toast";
import {
  exchangeSdp,
  hangupWithRetry,
  INITIAL_TALK_STATUS,
  mintedSessionDisposition,
  loadTalkVad,
  loadTalkVoice,
  nextTalkPhase,
  endsTheCall,
  hidesTalkControl,
  parseTalkToolCall,
  saveTalkVad,
  saveTalkVoice,
  TALK_VAD_LEVELS,
  TALK_VOICES,
  talkErrorKey,
  talkVadThreshold,
  type TalkPhase,
  type TalkStatus,
  type TalkToolCall,
} from "./talkSession";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** i18n dispatch for the (pure) talkErrorKey result — kept here so the pure
 *  module stays free of paraglide imports. The GENERIC message carries the
 *  technical code so a report/screenshot pinpoints the failing step. */
function talkErrorMessage(code: string): string {
  switch (talkErrorKey(code)) {
    case "talk_error_disabled":
      return m.talk_error_disabled();
    case "talk_error_unsupported":
      return m.talk_error_unsupported();
    case "talk_error_mic_denied":
      return m.chat_mic_error_denied();
    case "talk_error_secret_expired":
      return m.talk_error_secret_expired();
    case "talk_error_session_stale":
      return m.talk_error_session_stale();
    case "talk_error_call_active":
      return m.talk_error_call_active();
    case "talk_error_turn_in_flight":
      return m.talk_error_turn_in_flight();
    case "talk_error_generic":
      return `${m.talk_error_generic()} (${code})`;
  }
}

export function TalkControl({
  chatId,
  routedAgent = null,
  onCallActiveChange,
  serverCallSessionId = null,
}: {
  chatId: string;
  /** The composer's current per-turn selection, or null. */
  routedAgent?: { instanceName: string; agentId: string } | null;
  /** A call the SERVER sees on this chat that THIS tab does not own — after a
   *  reload, or from a second tab. Without it the freeze was visible and not
   *  clearable: the selector named the agent on the line and nothing here offered to
   *  end the call, for the whole 31-minute window. The idle pill then hangs up
   *  instead of starting. */
  serverCallSessionId?: string | null;
  /** Raised while a call is being set up or is live, so the composer can freeze the
   *  agent selector. The call is pinned to its agent; switching would split the
   *  conversation (and end a gateway-owned call). The server refuses it as well. */
  onCallActiveChange?: (active: boolean) => void;
}) {
  const [status, setStatus] = useState<TalkStatus>(INITIAL_TALK_STATUS);
  // The user's voice pick ("" = the gateway's configured default), persisted
  // per browser — passed to the mint; the gateway validates against ITS list.
  const [voice, setVoice] = useState<string>(() => loadTalkVoice());
  const [vad, setVad] = useState<string>(() => loadTalkVad());
  // Per-instance admin gate, REACTIVE: no button at all on a chat whose
  // instance has talk disabled (the capability alone is version-level).
  // ONE server answer: the admin gate AND the gateway capability, both evaluated for
  // the instance this session would actually reach. Reading the capability here
  // instead would describe the chat's BOUND instance, which a rebind makes the wrong
  // one, and it would fail open where the policy is fail closed.
  const available = useQuery(api.talk.talkAvailable, {
    chatId: chatId as Id<"chats">,
    ...(routedAgent ? { routedAgent } : {}),
  });

  const mint = useAction(api.talk.mintTalkSession);
  const relayToolCall = useAction(api.talk.relayTalkToolCall);
  // The GPT Live lane: the offer travels through Convex and the bridge to the
  // gateway's own route, and the call the gateway OWNS has to be told when the
  // user hangs up — the socket that owns it outlives this component.
  const relayOffer = useAction(api.talk.relayTalkOffer);
  const hangupSession = useAction(api.talk.hangupTalkSession);
  // Set when the minted session is a gateway-owned call: the hangup is then owed
  // to the gateway, not just to the browser's own WebRTC objects.
  const ownedCallRef = useRef<{ sessionId: Id<"talkSessions"> } | null>(null);
  const toast = useToast();
  // Generation guard: bumped on every start AND hang-up; async continuations
  // compare before touching shared state.
  const genRef = useRef(0);
  // The HANDLE of this call, from the mint: an id, and nothing else. WHICH agent,
  // canonical and conversation the session was opened on lives in the SERVER's row —
  // the browser never holds them, which is what makes the handle proof rather than a
  // claim. The thread can move to another agent while the user is speaking; without
  // this the consult would re-resolve and reach a DIFFERENT gateway session than the
  // one on the line. Cleared on teardown.
  const sessionIdRef = useRef<Id<"talkSessions"> | null>(null);
  // Phase mirror for non-render checks (start guard + transition source).
  const phaseRef = useRef<TalkPhase>("idle");
  const resourcesRef = useRef<{
    pc: RTCPeerConnection | null;
    mic: MediaStream | null;
  }>({ pc: null, mic: null });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** Apply a lifecycle event through the tested matrix; illegal (stale)
   *  transitions are dropped. Returns the phase actually entered, or null. */
  const advance = useCallback(
    (event: Parameters<typeof nextTalkPhase>[1]): TalkPhase | null => {
      const next = nextTalkPhase(phaseRef.current, event);
      if (next === null) return null;
      phaseRef.current = next;
      setStatus((s) => ({ ...s, phase: next }));
      return next;
    },
    [],
  );

  const teardown = useCallback(() => {
    const r = resourcesRef.current;
    try {
      r.mic?.getTracks().forEach((t) => t.stop());
    } catch {
      /* track already stopped */
    }
    try {
      r.pc?.close();
    } catch {
      /* connection already closed */
    }
    r.mic = null;
    r.pc = null;
    // The session is over: its handle must not survive into the next call, where it
    // would address whatever the previous one belonged to.
    sessionIdRef.current = null;
    setOwnCall(null);
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  // Tell the gateway the call is over, when it is the gateway's call to end.
  // Best-effort and fire-and-forget: the socket that owns the call is the bridge's,
  // and a gateway that already closed it answers idempotently. Read-and-clear FIRST
  // so a hangup and an unmount racing each other send it once.
  const releaseOwnedCall = useCallback(() => {
    const owned = ownedCallRef.current;
    ownedCallRef.current = null;
    if (owned === null) return;
    void hangupWithRetry(() =>
      hangupSession({ chatId: chatId as Id<"chats">, sessionId: owned.sessionId }),
    );
  }, [chatId, hangupSession]);

  const hangup = useCallback(() => {
    if (advance("hangup") === null) return;
    genRef.current++;
    releaseOwnedCall();
    teardown();
    advance("ended");
    setStatus((s) => ({ ...s, muted: false }));
  }, [advance, releaseOwnedCall, teardown]);

  // THE SERVER ENDED THIS CALL — SO END IT HERE.
  //
  // A hangup from anywhere else (the recovery pill in another tab, an admin action,
  // the end-of-window marker) marks the row ended. On the RELAYED lane the gateway
  // closes the call with it; on the DIRECT lane nothing can reach this browser's
  // peer connection, and upstream's close says so in as many words ("Transport close
  // does not end consult runs"). So this tab kept a live microphone and a voice model
  // on a call the server had ended — and the other tab, seeing no call, could route
  // the conversation to another agent (codex P2, pass 12). The freeze is only honest
  // if "hung up" means hung up everywhere.
  //
  // ASKED ABOUT THIS SESSION, not about the chat. The chat-wide answer could predate
  // this tab's own mint, so an earlier version first had to WATCH its call appear
  // before it would trust the disappearance — and a tab that never saw that
  // intermediate state (suspended, reconnecting, a coalesced update) could then never
  // react at all, which is the hole that guard opened (codex P1, pass 16). A
  // subscription on this id cannot exist before the row does, so `false` is always
  // "ended", never "not yet".
  const [ownCall, setOwnCall] = useState<Id<"talkSessions"> | null>(null);
  const ownCallLive = useQuery(
    api.talk.talkCallLive,
    ownCall === null ? "skip" : { sessionId: ownCall },
  );
  const serverEndedOurs = phaseRef.current !== "idle" && ownCallLive === false;
  useEffect(() => {
    if (!serverEndedOurs) return;
    genRef.current++;
    releaseOwnedCall();
    teardown();
    advance("ended");
    setStatus((s) => ({ ...s, muted: false }));
    // NOT "the session expired": it did not. Someone ended this call — another tab,
    // or the server at the end of the window — and a reader told about an expiry
    // would go looking for a timeout that never happened (codex P3, pass 13).
    toast.error(m.talk_error_ended_elsewhere());
  }, [serverEndedOurs, advance, releaseOwnedCall, teardown, toast]);

  // Unmount = hang up: never leave a mic live behind a conversation the user left.
  // Navigating between chats does NOT unmount this by itself — the route component
  // is reused — so the mount site keys it on the chat id; that key is what turns a
  // navigation into the unmount this effect is waiting for.
  useEffect(
    () => () => {
      genRef.current++;
      releaseOwnedCall();
      teardown();
    },
    [releaseOwnedCall, teardown],
  );

  const start = useCallback(async () => {
    if (advance("start") === null) return; // already active — ignore
    const gen = ++genRef.current;
    setStatus((s) => ({ ...s, errorCode: null, muted: false }));
    const fail = (code: string) => {
      if (genRef.current !== gen) return; // a newer session owns the state
      advance("failed");
      releaseOwnedCall();
      teardown();
      advance("ended");
      setStatus((s) => ({ ...s, errorCode: code }));
      toast.error(talkErrorMessage(code));
    };
    const vadValue = talkVadThreshold(vad);
    // The action can REJECT (an authorization gate throws before its own try block).
    // Without this the control would sit in `connecting` with no error and no way
    // back — the failure has to become a code like any other.
    const minted = await mint({
      chatId: chatId as Id<"chats">,
      ...(voice !== "" ? { voice } : {}),
      ...(vadValue !== null ? { vadThreshold: vadValue } : {}),
      // The composer's CURRENT pick: a user who selects another agent and presses
      // the button must talk to THAT agent. Authorized server-side.
      ...(routedAgent ? { routedAgent } : {}),
    }).catch(() => ({ ok: false as const, code: "mint_failed" }));
    if (minted.ok) {
      const disposition = mintedSessionDisposition(minted.session, genRef.current === gen);
      if (disposition === "hangup-now") {
        // Hung up while the mint was in flight: the call exists and nobody will
        // connect to it. Close it now rather than leave it holding a gateway
        // reservation, and the chat's agent frozen, until the call window runs out.
        void hangupWithRetry(() =>
          hangupSession({ chatId: chatId as Id<"chats">, sessionId: minted.sessionId }),
        );
        return;
      }
    } else if (genRef.current !== gen) {
      return;
    }
    if (!minted.ok) {
      fail(minted.code);
      return;
    }
    sessionIdRef.current = minted.sessionId;
    setOwnCall(minted.sessionId); // …and start watching THIS call's own row
    // EVERY minted session is owed a hangup, on both lanes. The gateway-owned one
    // needs it to close the call; the direct one needs it so the server stops
    // treating this chat as "on a call" and unfreezes its agent. Tying this to the
    // relayed lane left a direct call frozen for the whole call window after the
    // user hung up (codex P1).
    ownedCallRef.current = { sessionId: minted.sessionId };
    // Mic AFTER the mint: no permission prompt for a session that would be
    // refused anyway (disabled/unsupported).
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      fail("mic_denied");
      return;
    }
    if (genRef.current !== gen) {
      // Hung up while the permission prompt was open — release the mic.
      mic.getTracks().forEach((t) => t.stop());
      return;
    }
    resourcesRef.current.mic = mic;
    setStatus((s) => ({
      ...s,
      model: minted.session.model,
      voice: minted.session.voice,
    }));
    advance("minted");
    const pc = new RTCPeerConnection();
    resourcesRef.current.pc = pc;
    for (const track of mic.getTracks()) pc.addTrack(track, mic);
    pc.ontrack = (e) => {
      if (genRef.current !== gen || audioRef.current === null) return;
      audioRef.current.srcObject = e.streams[0] ?? null;
    };
    // The provider's event lane. TOOL CALLS arrive here: the voice model's
    // openclaw_agent_consult is relayed to a REAL agent run on this chat's
    // session (Convex -> bridge -> gateway talk.client.toolCall), and the
    // result is handed back as function_call_output so the voice SPEAKS it.
    const dc = pc.createDataChannel("oai-events");
    // The model-facing strings below are prompts, not UI copy: the voice
    // translates them into the user's language when speaking.
    const submit = (payload: unknown) => {
      try {
        dc.send(JSON.stringify(payload));
      } catch {
        /* channel already closed — the session is ending */
      }
    };
    const handleToolCall = async (call: TalkToolCall) => {
      if (call.name !== "openclaw_agent_consult") {
        // openclaw_agent_control (and unknown tools): not wired yet — answer
        // honestly so the model NEVER hangs on a dangling call.
        submit({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.callId,
            output:
              "Task-control is not available in this interface yet; tell the user so.",
          },
        });
        submit({ type: "response.create" });
        return;
      }
      // Interim: the agent run can take a while — have the voice acknowledge
      // NOW instead of going silent (mirrors the gateway's own working-response
      // guidance for its Control UI).
      submit({
        type: "response.create",
        response: {
          instructions:
            "Briefly tell the user, in their language, that you are checking with the agent. Do not invent the result.",
        },
      });
      const res = await relayToolCall({
        chatId: chatId as Id<"chats">,
        callId: call.callId,
        // The session this consult belongs to. The composer's selection can move
        // while the call is live; the consult must not.
        ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
        args: {
          question:
            typeof call.args.question === "string" ? call.args.question : "",
          ...(typeof call.args.context === "string"
            ? { context: call.args.context }
            : {}),
          ...(typeof call.args.responseStyle === "string"
            ? { responseStyle: call.args.responseStyle }
            : {}),
        },
      }).catch(() => ({ ok: false as const, code: "relay_failed" }));
      if (genRef.current !== gen) return; // hung up while the agent worked
      if (!res.ok && endsTheCall(res.code)) {
        // Every later consult would fail identically: keeping the connection up
        // would leave the user talking to an agent that can no longer be reached.
        hangup();
        setStatus((st) => ({ ...st, errorCode: res.code }));
        toast.error(talkErrorMessage(res.code));
        return;
      }
      const output = !res.ok
        ? `The agent could not be reached (${res.code}). Tell the user and suggest typing the request in the conversation instead.`
        : res.pending
          ? "The agent is still working on it. Tell the user the task continues and its result will arrive in the conversation."
          : typeof res.errorText === "string"
            ? `The agent run failed: ${res.errorText}`
            : (res.resultText ?? "");
      submit({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.callId,
          output: output === "" ? "(the agent returned an empty result)" : output,
        },
      });
      submit({ type: "response.create" });
    };
    // Both provider event shapes can fire for one call — dedupe by callId.
    const handledCalls = new Set<string>();
    dc.onmessage = (e) => {
      if (genRef.current !== gen) return;
      const call = parseTalkToolCall(typeof e.data === "string" ? e.data : "");
      if (call === null || handledCalls.has(call.callId)) return;
      handledCalls.add(call.callId);
      void handleToolCall(call);
    };
    pc.onconnectionstatechange = () => {
      if (genRef.current !== gen) return;
      // ONLY "failed" is terminal. "disconnected" is frequently TRANSIENT in
      // WebRTC (ICE consent hiccup, candidate-pair switch) and recovers to
      // "connected" on its own — killing the session on it dropped live
      // conversations seconds after the audio started (user repro).
      if (pc.connectionState === "failed") {
        fail("rtc_lost");
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (genRef.current !== gen) return;
      const sdp = await exchangeSdp(
        minted.session,
        offer.sdp ?? "",
        fetch,
        // The relayed lane: Convex authorizes the handle against the session row
        // this mint recorded, the bridge presents the offer with the secret it kept.
        (relayId, offerSdp) =>
          relayOffer({
            chatId: chatId as Id<"chats">,
            sessionId: minted.sessionId,
            relayId,
            sdp: offerSdp,
          }),
      );
      if (genRef.current !== gen) return;
      if (!sdp.ok) {
        fail(sdp.code);
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: sdp.answerSdp });
    } catch {
      fail("rtc_setup");
      return;
    }
    if (genRef.current !== gen) return;
    advance("connected");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity stable
  }, [advance, chatId, hangupSession, mint, relayOffer, releaseOwnedCall, teardown, voice, vad, routedAgent]);

  const toggleMute = useCallback(() => {
    const mic = resourcesRef.current.mic;
    if (mic === null) return;
    const next = !status.muted;
    for (const track of mic.getAudioTracks()) track.enabled = !next;
    setStatus((s) => ({ ...s, muted: next }));
  }, [status.muted]);

  const phase = status.phase;
  // From the FIRST click (minting) to the last: the session is minted for the agent
  // selected at that instant, so the selection must freeze before the mint, not once
  // audio flows. `ending` stays frozen too — the hangup is still travelling.
  const callActive = phase !== "idle";
  useEffect(() => {
    onCallActiveChange?.(callActive);
  }, [callActive, onCallActiveChange]);
  // Unmount: whatever the phase was, this chat no longer has a call under this UI.
  useEffect(
    () => () => {
      onCallActiveChange?.(false);
    },
    [onCallActiveChange],
  );
  // Hidden while the instance is not enabled (or the probe still loads). An
  // ACTIVE session keeps rendering so a mid-call admin flip never strands a
  // live mic without its controls.
  if (
    hidesTalkControl({
      phase,
      available,
      serverCall: serverCallSessionId !== null,
    })
  ) {
    return null;
  }
  return (
    <>
      {/* Remote (agent) audio sink — never rendered visibly. */}
      <audio ref={audioRef} autoPlay className="oc-talk__audio" />
      {phase === "idle" && serverCallSessionId !== null ? (
        // A call the server sees and this tab does not own: the only useful action is
        // to end it. Starting another would be refused (the mint refuses a switch),
        // and leaving no action at all is what made the freeze unclearable.
        <span className="oc-talk__pill">
          <button
            type="button"
            className="oc-talk__pillmain"
            title={m.talk_stop()}
            aria-label={m.talk_stop()}
            onClick={() => {
              void hangupWithRetry(() =>
                hangupSession({
                  chatId: chatId as Id<"chats">,
                  sessionId: serverCallSessionId as Id<"talkSessions">,
                }),
              );
            }}
          >
            <PhoneOff size={16} aria-hidden />
          </button>
        </span>
      ) : phase === "idle" ? (
        <span className="oc-talk__pill">
          {/* The pill BODY starts the conversation; the chevron opens the
              settings (voice + mic sensitivity) — mirrors the agent chip,
              icons only (i18n widths never squeeze the composer). */}
          <button
            type="button"
            className="oc-talk__pillmain"
            title={m.talk_start()}
            aria-label={m.talk_start()}
            onClick={() => void start()}
          >
            <AudioLines size={16} aria-hidden />
          </button>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="oc-talk__pillchev"
                title={m.talk_settings()}
                aria-label={m.talk_settings()}
              >
                <ChevronDown size={13} aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="oc-talk__settings">
              <label className="oc-talk__setting">
                <span className="oc-talk__settinglabel">{m.talk_voice_label()}</span>
                <Select
                  value={voice === "" ? "__default__" : voice}
                  onValueChange={(v) => {
                    const next = v === "__default__" ? "" : v;
                    setVoice(next);
                    saveTalkVoice(next);
                  }}
                >
                  <SelectTrigger size="sm" aria-label={m.talk_voice_label()}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">
                      {m.talk_voice_default()}
                    </SelectItem>
                    {TALK_VOICES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="oc-talk__setting">
                <span className="oc-talk__settinglabel">
                  {m.talk_sensitivity_label()}
                </span>
                <Select
                  value={vad === "" ? "__default__" : vad}
                  onValueChange={(v) => {
                    const next = v === "__default__" ? "" : v;
                    setVad(next);
                    saveTalkVad(next);
                  }}
                >
                  <SelectTrigger size="sm" aria-label={m.talk_sensitivity_label()}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">
                      {m.talk_sensitivity_default()}
                    </SelectItem>
                    {TALK_VAD_LEVELS.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.id === "low"
                          ? m.talk_sensitivity_low()
                          : l.id === "medium"
                            ? m.talk_sensitivity_medium()
                            : m.talk_sensitivity_high()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </PopoverContent>
          </Popover>
        </span>
      ) : (
        <span
          className={`oc-talk${phase === "live" ? " oc-talk--live" : ""}`}
          role="status"
        >
          <i className="oc-talk__dot" aria-hidden />
          <span className="oc-talk__label">
            {phase === "live"
              ? status.voice || m.talk_live()
              : m.talk_connecting()}
          </span>
          {phase === "live" ? (
            <button
              type="button"
              className="oc-talk__btn"
              title={status.muted ? m.talk_unmute() : m.talk_mute()}
              aria-label={status.muted ? m.talk_unmute() : m.talk_mute()}
              aria-pressed={status.muted}
              onClick={toggleMute}
            >
              {status.muted ? (
                <MicOff size={14} aria-hidden />
              ) : (
                <Mic size={14} aria-hidden />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="oc-talk__btn oc-talk__btn--end"
            title={m.talk_stop()}
            aria-label={m.talk_stop()}
            onClick={hangup}
          >
            <PhoneOff size={14} aria-hidden />
          </button>
        </span>
      )}
    </>
  );
}
