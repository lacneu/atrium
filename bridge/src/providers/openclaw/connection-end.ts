/**
 * NAMING a connection end.
 *
 * The gateway does not just vanish: it TELLS us how a connection ends, in two
 * ways that Atrium used to throw away.
 *
 *  1. An `event:"shutdown"` frame — `{reason, restartExpectedMs?}`
 *     (`gateway-protocol/src/schema/frames.ts` ShutdownEventSchema) — broadcast
 *     just BEFORE the socket closes (`src/gateway/server-close.ts`, right after
 *     the cron/heartbeat/watcher steps stop). It is scope-free upstream
 *     (`EVENT_SCOPE_GUARDS.shutdown = []`), so every operator connection gets
 *     it: an announced restart is never a mystery, unless we drop the frame.
 *  2. The WebSocket close code + reason. `1008` is the interesting one, and it
 *     is AMBIGUOUS on the code alone: the gateway sends `1008 "slow consumer"`
 *     when our receive buffer passed `MAX_BUFFERED_BYTES` (50 MiB —
 *     `server-broadcast.ts`), and `1008 "unauthorized: …"` for an auth refusal
 *     (`src/gateway/client.test.ts`). Only the reason separates "we were too
 *     slow and the gateway hung up on us" from "our credentials were refused" —
 *     two problems with nothing in common operationally.
 *
 * Everything here is a PURE classification so both paths are testable without a
 * socket. The output is a STABLE code plus, for an announced restart, the delay
 * the gateway itself expects.
 *
 * SOC2: the upstream `reason` is free text (`NonEmptyString`) and a close reason
 * is operator-supplied — neither is ever carried out of this module. We MATCH on
 * the text and emit a code; `reasonPresent` records only that something was said.
 */

/** What ended the connection, as a stable code (never free text). */
export type ConnectionEndKind =
  /** The gateway ANNOUNCED a shutdown/restart before closing (`event:"shutdown"`). */
  | "gateway_restarting"
  /** `1008 "slow consumer"`: our receive buffer passed the gateway's ceiling. */
  | "slow_consumer"
  /** `1008 "unauthorized: …"`: credentials/device refused. */
  | "unauthorized"
  /** `1008` for some other policy reason (kept distinct: still a REFUSAL, not a blip). */
  | "policy_violation"
  /** Anything else — an ordinary drop with no explanation. */
  | "connection_closed";

export interface ShutdownNotice {
  /** Whether the gateway supplied a reason text (the text itself never travels). */
  reasonPresent: boolean;
  /** The gateway's own estimate of how long it will be gone, when it gave one. */
  restartExpectedMs: number | null;
}

export interface ConnectionEnd {
  kind: ConnectionEndKind;
  /** Present only for `gateway_restarting`, and only when the gateway said so. */
  restartExpectedMs: number | null;
  /** True when a close reason / shutdown reason text existed (presence only). */
  reasonPresent: boolean;
}

/** WS close code carrying a POLICY refusal upstream (slow consumer, auth). */
const POLICY_CLOSE_CODE = 1008;

/**
 * Read an inbound frame as a shutdown notice, or return null.
 *
 * Deliberately tolerant: the notice is worth having even if the payload drifts
 * (a future field, a missing `reason`), because its mere ARRIVAL is the signal.
 * `restartExpectedMs` is only accepted as a finite non-negative number — the
 * upstream schema says `Integer({minimum: 0})`, and a garbage value would end up
 * sizing a recovery budget.
 */
export function readShutdownNotice(frame: unknown): ShutdownNotice | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== "event" || f.event !== "shutdown") return null;
  const payload =
    typeof f.payload === "object" && f.payload !== null
      ? (f.payload as Record<string, unknown>)
      : {};
  const ms = payload.restartExpectedMs;
  return {
    reasonPresent:
      typeof payload.reason === "string" && payload.reason.length > 0,
    restartExpectedMs:
      typeof ms === "number" && Number.isFinite(ms) && ms >= 0
        ? Math.floor(ms)
        : null,
  };
}

/**
 * Name a connection end from what we observed.
 *
 * An ANNOUNCED shutdown outranks the close code: the gateway told us its
 * intention explicitly, and the code that follows is just how the socket went
 * away (often a plain 1000/1006). Reading the code first would demote a known
 * restart to a generic drop.
 */
export function classifyConnectionEnd(input: {
  code?: number | null;
  /** Raw close reason. Matched here, never propagated. */
  reasonText?: string | null;
  /** A shutdown notice seen earlier on THIS connection, if any. */
  shutdown?: ShutdownNotice | null;
}): ConnectionEnd {
  const reasonText =
    typeof input.reasonText === "string" ? input.reasonText : "";
  const reasonPresent = reasonText.trim().length > 0;
  if (input.shutdown) {
    return {
      kind: "gateway_restarting",
      restartExpectedMs: input.shutdown.restartExpectedMs,
      reasonPresent: input.shutdown.reasonPresent || reasonPresent,
    };
  }
  if (input.code === POLICY_CLOSE_CODE) {
    const lowered = reasonText.toLowerCase();
    const kind: ConnectionEndKind = lowered.includes("slow consumer")
      ? "slow_consumer"
      : lowered.startsWith("unauthorized")
        ? "unauthorized"
        : "policy_violation";
    return { kind, restartExpectedMs: null, reasonPresent };
  }
  return { kind: "connection_closed", restartExpectedMs: null, reasonPresent };
}
