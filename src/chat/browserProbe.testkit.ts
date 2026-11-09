// THE BROWSER HALF OF THE GUARDS THAT LAY OUT THE APP IN A REAL CHROME (lots 28-29):
// layoutFloor.test.ts, layerFeet.test.ts, slotRules.test.ts, queueReserve.test.ts.
// Not a test itself (vitest runs *.test.ts only): where a Chrome is, the app's
// stylesheets as its build loads them, and one headless run that returns what a page
// wrote in <pre id="out">.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";

export const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** ATRIUM_CHROME, else Playwright's headless shell, else Chrome or Chromium where they
 *  install; null when none is here. */
export function findChrome(): string | null {
  const env = process.env.ATRIUM_CHROME;
  if (env && existsSync(env)) return env;
  for (const base of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(base, dir))) {
        const bin = join(base, dir, sub, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** A guard that lays out runs where a browser is; on CI (CI=true) a missing one fails. */
export function chromeOrFail(guard: string): string | null {
  const chrome = findChrome();
  if (chrome === null && process.env.CI) {
    throw new Error(`${guard} lays out in a real browser: set ATRIUM_CHROME (a Chrome or a chrome-headless-shell)`);
  }
  return chrome;
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import\s+(?:[^'"`;]*?\s+from\s+)?|export\s+[^'"`;]*?\s+from\s+)["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveModule(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // a package: its stylesheets come through index.css's @imports
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  // `.js` specifiers that name a TypeScript source.
  if (/\.js$/.test(base)) {
    for (const cand of [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx")]) if (existsSync(cand)) return cand;
  }
  return null;
}

/** Every stylesheet the app loads, in the order its build serves them: the static
 *  imports depth first from src/main.tsx (the main bundle's CSS, in import order),
 *  then each lazily loaded module's (its chunk's CSS, appended when it loads). */
export function appStylesheets(): string[] {
  const css: string[] = [];
  const seen = new Set<string>();
  const lazy: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.endsWith(".css")) {
      css.push(file);
      return;
    }
    if (!/\.(ts|tsx)$/.test(file) || /\.test\.tsx?$/.test(file)) return;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      const target = resolveModule(spec, file);
      if (target === null) continue;
      if (m[2] !== undefined) lazy.push(target);
      else visit(target);
    }
  };
  visit(join(SRC, "main.tsx"));
  for (let i = 0; i < lazy.length; i++) visit(lazy[i]);
  return css.map((f) => `/${relative(ROOT, f).split("\\").join("/")}`);
}

/** Every stylesheet under src/ (what the walk above must reach). */
export function sourceStylesheets(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) {
        if (e !== "paraglide") walk(f);
      } else if (e.endsWith(".css")) out.push(`/${relative(ROOT, f).split("\\").join("/")}`);
    }
  };
  walk(SRC);
  return out.sort();
}

/** The app's stylesheets compiled by Vite with the app's Tailwind plugin, in the
 *  build's order. Tailwind's plugin alone: the app's config would run Paraglide too,
 *  whose compile rewrites src/paraglide without the declarations the typecheck reads. */
export async function appCss(): Promise<string> {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    plugins: [tailwindcss()],
    resolve: { alias: { "@": SRC } },
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const out: string[] = [];
    for (const file of appStylesheets()) {
      const r = await server.transformRequest(`${file}?direct`);
      if (!r) throw new Error(`no stylesheet for ${file}`);
      out.push(r.code);
    }
    return out.join("\n");
  } finally {
    await server.close();
  }
}

// GOOGLE CHROME CAN HANG AT ITS VERY START (lot 30). Sampled on a Mac during the suite:
// the browser forks, the forked child waits forever on a lock in its XPC at-fork handler,
// and the browser waits on the child; stuck there, it launches no helper process at all.
// A launch that has started none (nothing with a --type= flag: no renderer, no GPU or
// utility process) within STARTUP_MS is killed with its process group and Chrome is
// launched again on a fresh profile, LAUNCHES times at most. Each relaunch is noted in
// the file ATRIUM_CHROME_LAUNCHES names, when it is set.
const STARTUP_MS = 30_000;
const LAUNCHES = 3;

/** Whether the process `pid` has launched a helper: a child process with a --type= flag. */
function launchedHelper(pid: number): boolean {
  const ps = spawnSync("ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
  return (ps.stdout ?? "").split("\n").some((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m !== null && Number(m[1]) === pid && m[2].includes("--type=");
  });
}
function killGroup(proc: ChildProcess): void {
  try {
    if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
  } catch {
    // gone already
  }
}
function noteRelaunch(what: string, launch: number): void {
  const file = process.env.ATRIUM_CHROME_LAUNCHES;
  if (file) appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), what, hungLaunch: launch })}\n`);
}

/** One Chrome run to its exit, in its own process group: its output, `hung` when the
 *  watchdog killed it at its start, `late` when it ran past `timeoutMs`. */
function runToExit(
  chrome: string,
  args: string[],
  timeoutMs: number,
): Promise<{ hung: boolean; late: boolean; status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(chrome, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout!.on("data", (d: Buffer) => out.push(d));
    proc.stderr!.on("data", (d: Buffer) => err.push(d));
    const t0 = Date.now();
    let started = false;
    let hung = false;
    let late = false;
    const watch = setInterval(() => {
      if (!started) started = launchedHelper(proc.pid!);
      const elapsed = Date.now() - t0;
      if (!started && elapsed > STARTUP_MS) hung = true;
      else if (elapsed > timeoutMs) late = true;
      else return;
      clearInterval(watch);
      killGroup(proc);
    }, 500);
    proc.on("close", (status) => {
      clearInterval(watch);
      resolve({ hung, late, status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** One headless Chrome run of `page` in virtual time; what it wrote in <pre id="out">, parsed. */
export async function runChrome<T>(chrome: string, page: string, opts: { flags?: string[]; budgetMs?: number } = {}): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atrium-probe-"));
  try {
    const file = join(dir, "probe.html");
    writeFileSync(file, page);
    const shell = /headless[-_]shell/.test(chrome);
    for (let launch = 1; launch <= LAUNCHES; launch++) {
      const res = await runToExit(
        chrome,
        [
          ...(shell ? [] : ["--headless=new"]),
          "--no-sandbox",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${join(dir, `profile-${launch}`)}`,
          "--window-size=1200,1000",
          // A phone: a coarse pointer, no hover (the 44 px targets).
          "--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1",
          ...(opts.flags ?? []),
          `--virtual-time-budget=${opts.budgetMs ?? 20000}`,
          "--dump-dom",
          `file://${file}`,
        ],
        180_000,
      );
      if (res.hung) {
        noteRelaunch("runChrome", launch);
        continue;
      }
      const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(res.stdout);
      if (!m) throw new Error(`Chrome returned no result (status ${res.status}${res.late ? ", past 180 s" : ""}): ${res.stderr.slice(0, 400)}`);
      const text = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return JSON.parse(text) as T;
    }
    throw new Error(`Chrome hung at its start ${LAUNCHES} times (no helper process within ${STARTUP_MS / 1000} s)`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** A page's data, safe inside a <script>. */
export function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

/** A page that runs in REAL time (frames, transitions, animation frames — virtual time
 *  produces none of them): Chrome driven over its DevTools protocol, the page opened
 *  after the media to emulate is set, its <pre id="out"> read until it holds a JSON
 *  object whose `stage` is "done" (or whose `errors` are not empty).
 *
 *  With `input`, the page can ask for REAL input — keys, wheel, touch, presses, which a
 *  page's own synthetic events never scroll with: it calls
 *  `__cdpInput(JSON.stringify({ id, events: [{ method: "Input.…", params }] }))`, the
 *  events are dispatched in order through the protocol, then `__cdpInputDone(id, error)`
 *  is called in the page (`error` empty when every event went through). */
export async function runChromeLive<T extends { stage?: string; errors?: unknown[] }>(
  chrome: string,
  page: string,
  opts: { media?: Array<{ name: string; value: string }>; timeoutMs?: number; input?: boolean } = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atrium-live-"));
  const file = join(dir, "probe.html");
  writeFileSync(file, page);
  const shell = /headless[-_]shell/.test(chrome);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let ws: WebSocket | null = null;
  let proc: ChildProcess | null = null;
  try {
    // Chrome past its own start: its DevTools port open and a helper launched (see
    // STARTUP_MS), else killed with its group and launched again on a fresh profile.
    let port = 0;
    for (let launch = 1; port === 0; launch++) {
      if (launch > LAUNCHES) throw new Error(`Chrome hung at its start ${LAUNCHES} times (no helper process within ${STARTUP_MS / 1000} s)`);
      const profile = join(dir, `profile-${launch}`);
      const started = spawn(
        chrome,
        [
          ...(shell ? [] : ["--headless=new"]),
          "--no-sandbox",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "--window-size=1200,1000",
          "about:blank",
        ],
        { detached: true, stdio: "ignore" },
      );
      proc = started;
      const t0 = Date.now();
      let helped = false;
      while (Date.now() < deadline) {
        await sleep(100);
        const portFile = join(profile, "DevToolsActivePort");
        if (port === 0 && existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0;
        if (!helped) helped = launchedHelper(started.pid!);
        if (port !== 0 && helped) break;
        if (Date.now() - t0 > STARTUP_MS) break;
      }
      if (port !== 0 && helped) break;
      if (Date.now() >= deadline) throw new Error("Chrome opened no DevTools port");
      killGroup(started);
      noteRelaunch("runChromeLive", launch);
      port = 0;
    }
    let target: string | null = null;
    while (target === null && Date.now() < deadline) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        target = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null;
      } catch {
        await sleep(100);
      }
    }
    if (target === null) throw new Error("Chrome showed no page");
    const socket = new WebSocket(target);
    ws = socket;
    let next = 0;
    const pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
    let onInput: (payload: string) => void = () => {};
    socket.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
        method?: string;
        params?: { name?: string; payload?: string };
      };
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
      else if (msg.method === "Runtime.bindingCalled" && msg.params?.name === "__cdpInput") onInput(msg.params.payload ?? "");
    };
    await new Promise((r) => (socket.onopen = r));
    // A call Chrome does not answer within a minute fails by name, rather than leave the
    // run waiting on a browser that stopped.
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((res, rej) => {
        const id = ++next;
        const late = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`Chrome did not answer ${method} within 60 s`));
        }, 60_000);
        pending.set(id, (m) => {
          clearTimeout(late);
          pending.delete(id);
          if (m.error) rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
          else res(m.result);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    if (opts.input) {
      // One request at a time, in the order the page made them.
      let chain = Promise.resolve();
      onInput = (payload) => {
        const { id, events } = JSON.parse(payload) as { id: number; events: Array<{ method: string; params: Record<string, unknown> }> };
        chain = chain.then(async () => {
          let failure = "";
          try {
            for (const e of events) {
              if (!e.method.startsWith("Input.")) throw new Error(`not an input: ${e.method}`);
              await send(e.method, e.params);
            }
          } catch (err) {
            failure = String(err);
          }
          // The page's request settles either way: a failure is its error.
          await send("Runtime.evaluate", { expression: `window.__cdpInputDone(${Number(id)}, ${JSON.stringify(failure)})` });
        }).catch(() => {}); // a page gone: the poll below reports it
      };
      await send("Runtime.enable");
      await send("Runtime.addBinding", { name: "__cdpInput" });
    }
    if (opts.media) await send("Emulation.setEmulatedMedia", { features: opts.media });
    await send("Page.navigate", { url: `file://${file}` });
    while (Date.now() < deadline) {
      await sleep(200);
      const r = (await send("Runtime.evaluate", {
        expression: `document.getElementById("out")?.textContent ?? ""`,
        returnByValue: true,
      })) as { result: { value: string } };
      const text = r.result.value;
      if (!text) continue;
      let out: T;
      try {
        out = JSON.parse(text) as T;
      } catch {
        continue;
      }
      if (out.stage === "done" || (out.errors?.length ?? 0) > 0) return out;
    }
    throw new Error("the page never finished");
  } finally {
    ws?.close();
    // Its profile is removed once Chrome — its whole process group — has let go of it.
    const last = proc;
    if (last !== null) {
      await new Promise<void>((r) => {
        const done = () => r();
        last.once("exit", done);
        last.kill();
        setTimeout(done, 3000);
      });
      killGroup(last);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
