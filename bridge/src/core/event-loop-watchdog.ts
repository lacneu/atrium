// Event-loop watchdog: a bridge whose main thread is stuck in synchronous code must
// say WHERE, and must not stay wedged.
//
// Why a worker thread: while the main thread is blocked nothing on its event loop runs
// — not a timer, not a signal handler, not `/health`. The 2026-09-29 incident (a
// catastrophic regex backtrack on a tool result) kept the process alive at 100 % CPU
// for 17 minutes, answering nothing, until a human restarted the container. The worker
// has its own event loop, so it can notice the stall and act.
//
// What it does:
//   - the main thread stamps a shared heartbeat every `heartbeatMs`;
//   - the worker logs a stall once it passes `warnMs`, and logs the recovery, so a
//     multi-second stall that did NOT end in a freeze still leaves a trace;
//   - past `exitMs` it captures the main thread's JavaScript stack and exits the
//     process with EXIT_CODE_WEDGED, so the container's restart policy takes over.
//
// How the stack is captured, and why this way. Measured on Node 22-25:
//   - `--report-on-signal` / `process.report` does NOT fire while the loop is blocked
//     (the signal is serviced on the blocked loop);
//   - an inspector session opened from a worker (`connectToMainThread`) gets no answer
//     either (its messages are dispatched on the main loop);
//   - the inspector ACTIVATED BY SIGUSR1 serves its WebSocket from its own I/O thread,
//     and `Debugger.pause` interrupts the main isolate even inside a regex backtrack.
// So the worker sends SIGUSR1 to its own process (Node installs that handler, so it is
// delivered even to PID 1), connects to 127.0.0.1:<debugPort>, pauses, logs the frames
// (function names and file:line — never scope values: no conversation content), and
// ends the process by evaluating `process.exit` IN the paused frame. That last step is
// deliberate: a container's PID 1 ignores a SIGKILL sent from inside its own PID
// namespace, so "kill ourselves" is not an exit path there. SIGKILL remains the
// fallback when the inspector cannot be reached (it works under an init process).
//
// The inspector is opened only once the process is already wedged and about to exit,
// and only on loopback inside the container.

import { Worker } from "node:worker_threads";

/** Exit status of a process ended by the watchdog (EX_SOFTWARE). */
export const EXIT_CODE_WEDGED = 70;

export interface EventLoopWatchdogOptions {
  /** Log a stall once the loop has been blocked this long. 0 = never log. */
  warnMs: number;
  /** Capture the stack and exit once blocked this long. 0 = never exit. */
  exitMs: number;
  /** Heartbeat period on the main thread. */
  heartbeatMs?: number;
  /** Worker check period. */
  pollMs?: number;
  /** Test seam: append log lines to this file instead of writing to stderr. */
  logFile?: string;
}

export interface EventLoopWatchdog {
  stop(): Promise<void>;
}

/** Defaults, overridable per deployment (see `watchdogOptionsFromEnv`). */
export const DEFAULT_WATCHDOG_WARN_MS = 5_000;
export const DEFAULT_WATCHDOG_EXIT_MS = 60_000;

/** Read BRIDGE_WATCHDOG_WARN_MS / BRIDGE_WATCHDOG_EXIT_MS (non-negative integers; a
 *  malformed value keeps the default rather than disabling the guard). */
export function watchdogOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): EventLoopWatchdogOptions {
  const read = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    warnMs: read(env.BRIDGE_WATCHDOG_WARN_MS, DEFAULT_WATCHDOG_WARN_MS),
    exitMs: read(env.BRIDGE_WATCHDOG_EXIT_MS, DEFAULT_WATCHDOG_EXIT_MS),
  };
}

// Plain CommonJS so it runs as an `eval` worker from the compiled bundle AND from the
// TypeScript sources under test, with no file of its own to resolve. Only Node
// built-ins and globals (fetch and WebSocket are global from Node 22).
const WORKER_SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { sab, warnMs, exitMs, pollMs, debugPort, pid, exitCode, logFile } = workerData;
const beat = new BigInt64Array(sab);
const write = (line) => {
  const text = "[bridge:watchdog] " + line + "\n";
  try {
    if (logFile) fs.appendFileSync(logFile, text);
    else fs.writeSync(2, text);
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warned = false;
let acting = false;
let worst = 0;

function frameLabel(f) {
  const file = String(f.url || "").split("/").pop() || "<native>";
  return (f.functionName || "<anonymous>") + " (" + file + ":" + (f.location.lineNumber + 1) + ":" + (f.location.columnNumber + 1) + ")";
}

async function inspectorTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + debugPort + "/json/list");
      const list = await res.json();
      const url = Array.isArray(list) && list[0] && list[0].webSocketDebuggerUrl;
      if (url) return url;
    } catch {}
    await sleep(100);
  }
  return null;
}

function hardKill() {
  try { process.kill(pid, "SIGKILL"); } catch {}
  write("SIGKILL had no effect (PID 1 of a container ignores it from inside): the process stays wedged; run the container with an init process (compose init: true) or restart it");
}

async function captureAndExit(lag) {
  write("event loop blocked for " + lag + "ms — capturing the main thread's stack, then exiting with " + exitCode);
  try { process.kill(pid, "SIGUSR1"); } catch {}
  const target = await inspectorTarget();
  if (!target) {
    write("inspector unreachable on 127.0.0.1:" + debugPort + " — no stack; forcing exit");
    hardKill();
    return;
  }
  let settled = false;
  const giveUp = setTimeout(() => {
    if (settled) return;
    write("the main thread did not pause within 10s — no stack; forcing exit");
    hardKill();
  }, 10000);
  const ws = new WebSocket(target);
  let id = 0;
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));
  ws.onopen = () => {
    send("Debugger.enable");
    send("Debugger.pause");
  };
  ws.onerror = () => write("inspector connection error");
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.method !== "Debugger.paused" || settled) return;
    settled = true;
    clearTimeout(giveUp);
    const frames = (m.params && m.params.callFrames) || [];
    write("main thread stack (innermost first): " + (frames.map(frameLabel).join(" <- ") || "<empty>"));
    if (frames.length === 0) { hardKill(); return; }
    send("Debugger.evaluateOnCallFrame", {
      callFrameId: frames[0].callFrameId,
      expression: "process.exit(" + exitCode + ")",
    });
  };
}

setInterval(() => {
  const lag = Date.now() - Number(Atomics.load(beat, 0));
  if (lag > worst) worst = lag;
  if (warnMs > 0 && lag >= warnMs && !warned) {
    warned = true;
    write("event loop blocked for " + lag + "ms (still blocked)");
  }
  if (exitMs > 0 && lag >= exitMs && !acting) {
    acting = true;
    void captureAndExit(lag);
  }
  if (warned && !acting && lag < warnMs) {
    write("event loop recovered after a stall of ~" + worst + "ms");
    warned = false;
    worst = 0;
  }
  if (!warned) worst = 0;
}, pollMs);
`;

/**
 * Start the watchdog. The heartbeat timer and the worker are both `unref`'d: the
 * watchdog never keeps a process alive by itself.
 */
export function startEventLoopWatchdog(
  opts: EventLoopWatchdogOptions,
): EventLoopWatchdog | null {
  if (opts.warnMs <= 0 && opts.exitMs <= 0) return null;
  const heartbeatMs = opts.heartbeatMs ?? 1_000;
  const pollMs = opts.pollMs ?? 500;
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  const stamp = (): void => {
    Atomics.store(beat, 0, BigInt(Date.now()));
  };
  stamp();
  const timer = setInterval(stamp, heartbeatMs);
  timer.unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      warnMs: opts.warnMs,
      exitMs: opts.exitMs,
      pollMs,
      debugPort: process.debugPort,
      pid: process.pid,
      exitCode: EXIT_CODE_WEDGED,
      logFile: opts.logFile ?? null,
    },
    // Its own stdio would be forwarded THROUGH the blocked main thread; it writes to
    // fd 2 directly instead.
    stdout: true,
    stderr: true,
  });
  worker.unref();
  worker.on("error", (err) => {
    console.error("[bridge:watchdog] worker failed — watchdog off:", err?.message ?? err);
  });
  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await worker.terminate();
    },
  };
}
