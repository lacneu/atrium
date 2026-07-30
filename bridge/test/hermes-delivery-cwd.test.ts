/// <reference types="vitest" />
//
// Delivered files must be findable (lot 41 — G-48).
//
// The outbound scan looks in `<cwd>/atrium-out`, so without the session's working
// directory it finds nothing. When a resume reply carried no info block, the code tried to
// recover the cwd from `session.status` — an RPC that returns only
// `{output: "<human-readable lines>"}`, with no `cwd` field, in 0.18.2 and 0.19.0 alike.
// The recovery was therefore DEAD CODE, and every delivered file in that case was lost in
// silence: no error, no card, nothing in the thread.
//
// `session.info` really does carry `cwd` (verified in the 0.19.0 source), and the live
// capture shows it arriving at turn START — before the scan. That is the channel now used.

import { describe, expect, it, vi } from "vitest";
import { runHermesWsTurn } from "../src/providers/hermes/ws-turn.js";
import type { HermesWsClient } from "../src/providers/hermes/ws-client.js";
import type { HermesFilesFetcher } from "../src/providers/hermes/files-fetcher.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const STORED = "20260706_212939_aee24e";

async function turnWithDelivery(opts: {
  /** Emitted as `session.info` BEFORE the terminal (the turn-start emission). */
  infoCwd?: string;
  /** Emitted as `session.info` AFTER the terminal — the turn's TAIL emission, which on
   *  0.18.2 is the only one carrying a cwd, and which the scan used to outrun. */
  tailCwd?: string;
  /** cwd inside the session.create reply's info block (the primary path). */
  replyCwd?: string;
}) {
  const listed: string[] = [];
  const calls: string[] = [];
  const media: unknown[] = [];
  const client = {
    call: async (method: string) => {
      calls.push(method);
      if (method === "session.create") {
        return {
          session_id: "rt-1",
          stored_session_id: STORED,
          ...(opts.replyCwd ? { info: { cwd: opts.replyCwd } } : {}),
        };
      }
      if (method === "prompt.submit") return { status: "streaming" };
      return {};
    },
  } as unknown as HermesWsClient;
  const fetcher = {
    listFiles: async (dir: string) => {
      listed.push(dir);
      return [{ name: "rapport.pdf", path: `${dir}/rapport.pdf`, mtime: Date.now() }];
    },
  } as unknown as HermesFilesFetcher;
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addPart: async (_id: string, part: unknown) => {
      media.push(part);
    },
    addToolPart: async () => {},
    addReasoningPart: async () => {},
    addMediaPart: async (_id: string, part: unknown) => {
      media.push(part);
    },
    setPhase: () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    heartbeat: async () => {},
    upsertSubAgent: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
  } as unknown as ConvexWriter;
  let lane!: (t: string, p: Record<string, unknown>) => void;
  const run = runHermesWsTurn(
    {
      client,
      writer,
      chatId: "c1",
      sessionKey: "k",
      providerChatId: null,
      text: "fabrique-moi un rapport",
      filesFetcher: fetcher,
    },
    (_sid, cb) => {
      lane = cb.onEvent;
      return () => {};
    },
  );
  await run.accepted;
  if (opts.infoCwd !== undefined) {
    lane("session.info", { model: "gpt-5.5", cwd: opts.infoCwd });
  }
  lane("message.complete", { text: "voilà", status: "complete" });
  if (opts.tailCwd !== undefined) {
    // AFTER the terminal, and after the scan micro-task has had a chance to start — the
    // exact order the gateway produces and the first cut of this lot lost the file on.
    await Promise.resolve();
    await Promise.resolve();
    lane("session.info", { cwd: opts.tailCwd });
  }
  await run.done;
  return { listed, calls };
}

describe("the outbound scan finds its directory", () => {
  it("takes the cwd from session.info when the reply carried none", async () => {
    // THE defect: this is exactly the case the dead `session.status` fallback claimed to
    // cover, and every delivered file in it was lost without a trace.
    const { listed } = await turnWithDelivery({ infoCwd: "/opt/data/projet" });
    expect(listed, "the scan never ran — the file is simply gone").toEqual([
      "/opt/data/projet/atrium-out",
    ]);
  });

  it("never calls session.status — that RPC carries no cwd", async () => {
    // Keeping the call would be worse than useless: a round trip, a failure to swallow,
    // and a comment claiming a recovery that cannot happen.
    const { calls } = await turnWithDelivery({ infoCwd: "/opt/data/projet" });
    expect(calls).not.toContain("session.status");
  });

  it("the reply's own info block still wins when present", async () => {
    const { listed } = await turnWithDelivery({ replyCwd: "/opt/data/depuis-reply" });
    expect(listed).toEqual(["/opt/data/depuis-reply/atrium-out"]);
  });

  it("a later session.info REFRESHES the directory", async () => {
    // The agent can move its working directory mid-session (`session.cwd.set`). The scan
    // must look where the session IS, not where it started.
    const { listed } = await turnWithDelivery({
      replyCwd: "/opt/data/ancien",
      infoCwd: "/opt/data/nouveau",
    });
    expect(listed).toEqual(["/opt/data/nouveau/atrium-out"]);
  });

  it("no cwd at all: no scan, and it is SAID", async () => {
    const { listed, calls } = await turnWithDelivery({});
    expect(listed).toEqual([]);
    expect(calls).not.toContain("session.status");
  });
});

describe("the scan waits for a cwd that is still on the wire", () => {
  it("a TAIL session.info still gets the file delivered", async () => {
    // THE case G-48 is about: a resume whose reply carried no info block. The terminal
    // enqueues the scan at once, and the `session.info` that carries the cwd arrives one
    // frame LATER — so the scan used to run blind and return empty, losing a file whose
    // location was about to be announced (raised in review). On 0.18.2 the turn-start
    // emission carries no cwd at all, which makes the tail one the only source.
    const { listed } = await turnWithDelivery({ tailCwd: "/opt/data/tardif" });
    expect(listed).toEqual(["/opt/data/tardif/atrium-out"]);
  });

  it("a KNOWN cwd is not waited on — a move cannot happen mid-turn", async () => {
    // Written after getting this wrong: the first version of this test posited a directory
    // moved and announced only in the TAIL, and expected the scan to wait for it. Upstream
    // says otherwise — `session.cwd.set` REFUSES while the session is busy (error 4009
    // "session busy") and emits `session.info` the moment it succeeds. So a move happens
    // only BETWEEN turns and is announced live; a turn that already knows its cwd has the
    // right one, and making every such turn wait 2 s for a frame that cannot change
    // anything would be a cost paid for an impossible case.
    const { listed } = await turnWithDelivery({
      replyCwd: "/opt/data/connu",
      tailCwd: "/opt/data/jamais-utilise",
    });
    expect(listed).toEqual(["/opt/data/connu/atrium-out"]);
  });

  it("no cwd ever: the scan gives up, BOUNDED, and says so", async () => {
    // The wait delays this turn's own terminal, so a gateway that never sends a cwd must
    // not hold it open. And the give-up has to be visible: a silent skip is the very
    // failure mode this lot exists to end.
    vi.useFakeTimers();
    const errs: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => errs.push(String(a[0])));
    try {
      const p = turnWithDelivery({});
      await vi.advanceTimersByTimeAsync(2_500);
      const { listed, calls } = await p;
      expect(listed).toEqual([]);
      expect(calls).not.toContain("session.status");
      expect(errs.some((e) => e.includes("no session cwd"))).toBe(true);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
