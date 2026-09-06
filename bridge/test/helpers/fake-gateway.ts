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
  /** The gateway's OWN pre-prompt assessment — what the guard measures against.
   *
   *  TWO SHAPES, because no pinned contract declares this assessment and the repo
   *  instructed it twice from observation: FLAT on the session row (these three),
   *  and NESTED under `contextBudgetStatus` (below). A fake that can only express
   *  one of them cannot test the guard against the other — which is exactly how
   *  the flat-only reading went unnoticed until production (2026-08-05). */
  estimatedPromptTokens?: number;
  promptBudgetBeforeReserve?: number;
  overflowTokens?: number;
  /** The NESTED shape of the same assessment. Deliberately loose: a partial one is
   *  plausible precisely because nothing declares it. */
  contextBudgetStatus?: {
    estimatedPromptTokens?: number;
    promptBudgetBeforeReserve?: number;
    overflowTokens?: number;
  };
  totalTokensFresh?: boolean;
}

import type { RosterEntry } from "../../src/providers/openclaw/models-roster.js";
import type { ConfigChangedNotice } from "../../src/providers/openclaw/config-changed.js";
import { sleep } from "./sleep.js";

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
  /** Per-owner `models.list` cache, like the real connection: the send path reads it. */
  modelsByOwner: Map<string, RosterEntry>;
  /** Roster epoch (0 = never invalidated), like the real connection. */
  rosterEpoch: number;
  /** The two subscriptions the roster policy takes on a real connection. */
  onConfigChanged(listener: (notice: ConfigChangedNotice) => void): () => void;
  onClosed(listener: () => void): () => void;
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
  const configChangedListeners = new Set<(notice: ConfigChangedNotice) => void>();
  const closedListeners = new Set<() => void>();

  const nextDescribe = (): FakeSessionDescribe | null => {
    const list = script.describe;
    if (!list || list.length === 0) return null;
    // The last entry REPEATS: a test scripts the transition it cares about and
    // every later describe reads the settled state.
    const i = Math.min(describeIndex, list.length - 1);
    describeIndex += 1;
    return list[i] ?? null;
  };

  const gw: FakeGateway = {
    verboseFullApplied: false,
    // Per-OWNER models cache, like the real connection: `ensureAvailableModels`
    // reads it on every dispatch, so a fake without it fails the whole path.
    modelsByOwner: new Map<string, RosterEntry>(),
    rosterEpoch: 0,
    onConfigChanged(listener) {
      configChangedListeners.add(listener);
      return () => {
        configChangedListeners.delete(listener);
      };
    },
    onClosed(listener) {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
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
      // Same order as the transport: closed FIRST, then the listeners (a disposal that
      // reads `isClosed` must see the truth), which are gone afterwards.
      closed = true;
      ended = true;
      const listeners = [...closedListeners];
      closedListeners.clear();
      configChangedListeners.clear();
      for (const l of listeners) l();
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
          await sleep(a.delayMs);
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
  return gw;
}

/** A connection double for the ROSTER logic only (`ensureAvailableModels`,
 *  `refreshSessionRoster`): the members `ModelsConnection` names, no more. `answer` is
 *  called per request and may return a payload, throw, or return a promise to hold the
 *  answer (in-flight tests). Structurally typed — no cast at the call site, so a field
 *  the real connection gains and this double lacks fails to compile. */
export function modelsConnSpy(
  answer: (method: string, params: unknown) => unknown,
  gatewayVersion: string | null = "2026.9.1",
) {
  const calls: { method: string; params: unknown }[] = [];
  const configChangedListeners = new Set<(notice: ConfigChangedNotice) => void>();
  const closedListeners = new Set<() => void>();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const conn = {
    gatewayVersion,
    modelsByOwner: new Map<string, RosterEntry>(),
    rosterEpoch: 0,
    isClosed: false,
    onConfigChanged(listener: (notice: ConfigChangedNotice) => void) {
      configChangedListeners.add(listener);
      return () => {
        configChangedListeners.delete(listener);
      };
    },
    onClosed(listener: () => void) {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
    /** What the transport does on a `config.changed` frame: the epoch moves, then every
     *  listener hears the notice. */
    emitConfigChanged(notice: ConfigChangedNotice) {
      conn.rosterEpoch += 1;
      for (const l of [...configChangedListeners]) l(notice);
    },
    listeners: () => ({ configChanged: configChangedListeners.size, closed: closedListeners.size }),
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      const v = await answer(method, params);
      return { payload: v };
    },
    /** Lifecycle, for the tests that hand this double to a Session: `close()` ends the
     *  frame generator and fires `onClosed`, like the real connection. */
    close() {
      conn.isClosed = true;
      const listeners = [...closedListeners];
      closedListeners.clear();
      configChangedListeners.clear();
      for (const l of listeners) l();
      release();
    },
    async *frames(): AsyncGenerator<never> {
      await gate;
    },
  };
  return { conn, calls, countOf: (method: string) => calls.filter((c) => c.method === method).length };
}

