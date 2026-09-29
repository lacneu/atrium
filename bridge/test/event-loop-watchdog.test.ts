/**
 * The event-loop watchdog (core/event-loop-watchdog.ts).
 *
 * Prod 2026-09-29: the bridge's main thread was stuck in a synchronous regex backtrack
 * for 17 minutes — no /health, no ingest, no log — and only a manual restart ended it.
 * These tests pin the two promises the watchdog makes: a stall leaves a trace, and a
 * wedged process says where it is stuck and EXITS.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WATCHDOG_EXIT_MS,
  DEFAULT_WATCHDOG_WARN_MS,
  EXIT_CODE_WEDGED,
  startEventLoopWatchdog,
  watchdogOptionsFromEnv,
} from "../src/core/event-loop-watchdog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_TS = resolve(__dirname, "../src/core/event-loop-watchdog.ts");

function busyWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* the blocked main thread */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

describe("event-loop watchdog", () => {
  it("reads its bounds from the env, keeping the defaults on a malformed value", () => {
    expect(watchdogOptionsFromEnv({})).toEqual({
      warnMs: DEFAULT_WATCHDOG_WARN_MS,
      exitMs: DEFAULT_WATCHDOG_EXIT_MS,
    });
    expect(
      watchdogOptionsFromEnv({ BRIDGE_WATCHDOG_WARN_MS: "0", BRIDGE_WATCHDOG_EXIT_MS: "120000" }),
    ).toEqual({ warnMs: 0, exitMs: 120_000 });
    // A typo must not silently switch the guard off.
    expect(
      watchdogOptionsFromEnv({ BRIDGE_WATCHDOG_WARN_MS: "5s", BRIDGE_WATCHDOG_EXIT_MS: "-1" }),
    ).toEqual({ warnMs: DEFAULT_WATCHDOG_WARN_MS, exitMs: DEFAULT_WATCHDOG_EXIT_MS });
    expect(startEventLoopWatchdog({ warnMs: 0, exitMs: 0 })).toBeNull();
  });

  it("logs a stall of the main thread and its recovery (exit disabled)", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "wd-")), "log.txt");
    const wd = startEventLoopWatchdog({
      warnMs: 150,
      exitMs: 0,
      heartbeatMs: 20,
      pollMs: 25,
      logFile,
    });
    expect(wd).not.toBeNull();
    try {
      await sleep(300); // the worker is up and has seen a live heartbeat
      busyWait(700);
      await sleep(300);
    } finally {
      await wd!.stop();
    }
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    expect(log).toMatch(/event loop blocked for \d+ms \(still blocked\)/);
    expect(log).toMatch(/event loop recovered after a stall of ~\d+ms/);
  });

  it(
    "a WEDGED process logs where it is stuck and exits (no human needed)",
    async () => {
      // A separate process, since the watchdog's job is to end it. It loads the
      // watchdog from the TypeScript source (type stripping, Node >= 22.18) and then
      // spins forever inside a named function the stack must name.
      const dir = mkdtempSync(join(tmpdir(), "wd-child-"));
      const script = join(dir, "wedge.mjs");
      writeFileSync(
        script,
        `import { startEventLoopWatchdog } from ${JSON.stringify(pathToFileURL(WATCHDOG_TS).href)};
startEventLoopWatchdog({ warnMs: 200, exitMs: 800, heartbeatMs: 50, pollMs: 50 });
function wedgedForTest() { let x = 0; for (;;) { x++; } }
setTimeout(wedgedForTest, 300);
`,
      );
      const port = await freePort();
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", `--inspect-port=${port}`, script],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.stdout.on("data", () => {});
      const code = await new Promise<number | null>((res) => {
        const kill = setTimeout(() => {
          child.kill("SIGKILL");
        }, 25_000);
        child.on("exit", (c) => {
          clearTimeout(kill);
          res(c);
        });
      });
      expect(stderr).toMatch(/\[bridge:watchdog\] event loop blocked for \d+ms/);
      expect(stderr).toMatch(/main thread stack \(innermost first\): wedgedForTest \(/);
      expect(code).toBe(EXIT_CODE_WEDGED);
    },
    30_000,
  );
});
