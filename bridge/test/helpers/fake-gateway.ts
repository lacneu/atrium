// A SCRIPTABLE fake gateway for the send path (W2).
//
// WHY this exists: four lots in a row shipped a hardening with no failing test,
// always for the same reason — the bridge's send path talks to a gateway over
// RPC, and nothing in the suite could answer those RPCs. The pre-send guard of W2
// DECIDES THE FATE OF A SEND from a `sessions.describe` answer, so "it blocks at
// 97%" is the easy half; the half that matters is "a successful compaction lets
// the send through" and "a guard that throws lets the send through". Neither is
// expressible without this.
//
// Deliberately NOT a WebSocket server: the contract under test is
// `connection.request(method, params)` -> a response frame, plus the frame
// stream. A real socket would add flakiness and prove nothing extra (the wire
// itself is covered by connection-end-live.test.ts).

/** One scripted answer. `throws` models an RPC that fails or times out. */
export interface FakeRpcAnswer {
  payload?: Record<string, unknown>;
  throws?: Error;
  /** Delay the answer. The pre-send guard CLAMPS the compaction's timeout to what
   *  the dispatch deadline still allows, so "how long may this call take" is part of
   *  the contract under test, not an implementation detail. */
  delayMs?: number;
}

export interface FakeSessionDescribe {
  sessionId?: string;
  systemSent?: boolean;
  totalTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
  /** The gateway's OWN pre-prompt assessment — what the guard measures against. */
  estimatedPromptTokens?: number;
  promptBudgetBeforeReserve?: number;
  overflowTokens?: number;
  totalTokensFresh?: boolean;
}

export interface FakeGatewayScript {
  /** Successive `sessions.describe` answers. The LAST one repeats, so a test
   *  scripts [before, after-compaction] and any further describe reads the
   *  post-compaction state. */
  describe?: (FakeSessionDescribe | null)[];
  /** `sessions.compact` outcome. Default: succeeds. */
  compact?: FakeRpcAnswer;
  /** Anything else, by method name. Unlisted methods answer `{}`. */
  answers?: Record<string, FakeRpcAnswer>;
}

export interface FakeGateway {
  /** Session sets this after applying `verboseLevel:"full"` once. */
  verboseFullApplied?: boolean;
  /** Frame cap (null = unknown). Only read on an attachment send. */
  maxPayload: number | null;
  /** Every request in order: `[method, params]`. The assertion surface. */
  readonly calls: [string, Record<string, unknown>][];
  /** The TIMEOUT each request was given, in order — same indices as `calls`. */
  readonly timeouts: (number | undefined)[];
  /** How many times each method was called — the "one attempt per turn" pin. */
  countOf(method: string): number;
  readonly isClosed: boolean;
  close(): void;
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ payload: Record<string, unknown> }>;
  frames(): AsyncGenerator<unknown>;
  /** Push a frame into the stream (a turn's events), or end it with `null`. */
  emit(frame: unknown | null): void;
}

export function fakeGateway(script: FakeGatewayScript = {}): FakeGateway {
  const calls: [string, Record<string, unknown>][] = [];
  const timeouts: (number | undefined)[] = [];
  const queue: unknown[] = [];
  let ended = false;
  let closed = false;
  let wake: (() => void) | null = null;
  let describeIndex = 0;

  const nextDescribe = (): FakeSessionDescribe | null => {
    const list = script.describe;
    if (!list || list.length === 0) return null;
    // The last entry REPEATS: a test scripts the transition it cares about and
    // every later describe reads the settled state.
    const i = Math.min(describeIndex, list.length - 1);
    describeIndex += 1;
    return list[i] ?? null;
  };

  return {
    verboseFullApplied: false,
    maxPayload: null,
    calls,
    timeouts,
    countOf(method) {
      return calls.filter(([m]) => m === method).length;
    },
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      ended = true;
      wake?.();
    },
    async request(method, params, timeoutMs) {
      calls.push([method, params]);
      timeouts.push(timeoutMs);
      if (method === "sessions.describe") {
        const sess = nextDescribe();
        return { payload: sess === null ? {} : { session: sess } };
      }
      if (method === "sessions.compact") {
        const a = script.compact;
        if (a?.delayMs) {
          await new Promise((r) => setTimeout(r, a.delayMs));
        }
        if (a?.throws) throw a.throws;
        return { payload: a?.payload ?? { ok: true, compacted: true } };
      }
      const a = script.answers?.[method];
      if (a?.throws) throw a.throws;
      return { payload: a?.payload ?? {} };
    },
    async *frames() {
      while (true) {
        while (queue.length > 0) yield queue.shift();
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    },
    emit(frame) {
      if (frame === null) {
        ended = true;
      } else {
        queue.push(frame);
      }
      wake?.();
    },
  };
}
