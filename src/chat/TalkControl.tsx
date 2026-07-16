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
import { useAction } from "convex/react";
import { AudioLines, Mic, MicOff, PhoneOff } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { useToast } from "@/components/ui/toast";
import {
  exchangeSdp,
  INITIAL_TALK_STATUS,
  nextTalkPhase,
  parseTalkToolCall,
  talkErrorKey,
  type TalkPhase,
  type TalkStatus,
  type TalkToolCall,
} from "./talkSession";

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
    case "talk_error_generic":
      return `${m.talk_error_generic()} (${code})`;
  }
}

export function TalkControl({ chatId }: { chatId: string }) {
  const [status, setStatus] = useState<TalkStatus>(INITIAL_TALK_STATUS);
  const mint = useAction(api.talk.mintTalkSession);
  const relayToolCall = useAction(api.talk.relayTalkToolCall);
  const toast = useToast();
  // Generation guard: bumped on every start AND hang-up; async continuations
  // compare before touching shared state.
  const genRef = useRef(0);
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
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const hangup = useCallback(() => {
    if (advance("hangup") === null) return;
    genRef.current++;
    teardown();
    advance("ended");
    setStatus((s) => ({ ...s, muted: false }));
  }, [advance, teardown]);

  // Unmount (navigation away) = hang up: never leave a mic live behind a
  // conversation the user left.
  useEffect(
    () => () => {
      genRef.current++;
      teardown();
    },
    [teardown],
  );

  const start = useCallback(async () => {
    if (advance("start") === null) return; // already active — ignore
    const gen = ++genRef.current;
    setStatus((s) => ({ ...s, errorCode: null, muted: false }));
    const fail = (code: string) => {
      if (genRef.current !== gen) return; // a newer session owns the state
      advance("failed");
      teardown();
      advance("ended");
      setStatus((s) => ({ ...s, errorCode: code }));
      toast.error(talkErrorMessage(code));
    };
    const minted = await mint({ chatId: chatId as Id<"chats"> });
    if (genRef.current !== gen) return;
    if (!minted.ok) {
      fail(minted.code);
      return;
    }
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
      const sdp = await exchangeSdp(minted.session, offer.sdp ?? "");
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
  }, [advance, chatId, mint, teardown]);

  const toggleMute = useCallback(() => {
    const mic = resourcesRef.current.mic;
    if (mic === null) return;
    const next = !status.muted;
    for (const track of mic.getAudioTracks()) track.enabled = !next;
    setStatus((s) => ({ ...s, muted: next }));
  }, [status.muted]);

  const phase = status.phase;
  return (
    <>
      {/* Remote (agent) audio sink — never rendered visibly. */}
      <audio ref={audioRef} autoPlay className="oc-talk__audio" />
      {phase === "idle" ? (
        <button
          type="button"
          className="oc-composer__icon"
          title={m.talk_start()}
          aria-label={m.talk_start()}
          onClick={() => void start()}
        >
          <AudioLines size={18} aria-hidden />
        </button>
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
