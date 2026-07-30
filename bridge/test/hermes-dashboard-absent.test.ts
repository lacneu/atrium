/// <reference types="vitest" />
//
// A surface that is not deployed is not a failure to retry (lot 47 — G-58, slice 1).
//
// The measurement, from the restored upstream (v2026.7.20), and it is the corrective half of
// the surface ratchet:
//
//   * The managed-files API — `/api/files`, `/api/files/read`, `/api/files/download`,
//     `/api/files/upload` — lives ONLY in the dashboard web server
//     (`hermes_cli/web_server.py:2131-2202`).
//   * `tui_gateway` mounts exactly ONE route, `/api/ws` (`tui_gateway/ws.py:19`).
//   * Upstream supervises the dashboard only "if HERMES_DASHBOARD is set"
//     (`hermes_cli/gateway.py:6607`).
//
// So `hermes serve` on its own — an ordinary, supported deployment — answers every turn
// perfectly while every agent-files operation 404s. Atrium turned that into
// `Error("files list -> HTTP 404")`, which `classifyGatewayError` could only read as
// `UPSTREAM_ERROR`: a generic, retryable gateway fault. The operator was invited to retry,
// forever, against a server that will never exist on that instance.
//
// Recognised by TYPE, never by prose — the rule `ContextBlockedError` already states at the
// top of `dispatch-errors.ts`: a decision we made cannot be left to depend on how we phrased
// it.

import { describe, expect, it } from "vitest";

import { classifyGatewayError } from "../src/core/dispatch-errors.js";
import {
  HermesDashboardAbsentError,
  HermesFilesFetcher,
} from "../src/providers/hermes/files-fetcher.js";
import {
  HermesTurnRegistry,
  performHermesAgentFilesOp,
} from "../src/providers/hermes/dispatch.js";

const BASE = "http://hermes.invalid:9119";

function fetcher(): HermesFilesFetcher {
  return new HermesFilesFetcher({
    baseUrl: BASE,
    credential: "static-token",
    maxBytes: 1024 * 1024,
  });
}

/** Stand the managed-files API up — or refuse it the way an un-mounted route does. */
async function withFiles<T>(
  reply: { status: number; body?: unknown },
  body: (f: HermesFilesFetcher) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      reply.body === undefined ? "" : JSON.stringify(reply.body),
      { status: reply.status },
    )) as typeof globalThis.fetch;
  try {
    return await body(fetcher());
  } finally {
    globalThis.fetch = real;
  }
}

describe("a 404 on the managed-files API names the dashboard", () => {
  it("`agentFilesRoot` refuses with a cause of its own", async () => {
    const err = await withFiles({ status: 404 }, (f) =>
      f.agentFilesRoot().then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).toBeInstanceOf(HermesDashboardAbsentError);
  });

  it("the TAB is covered, because every admin op resolves the root first", async () => {
    // The consequence that matters, asserted through the op the route calls rather than
    // through the fetcher: `performHermesAgentFilesOp` starts with `agentFilesRoot()`, so a
    // dashboard-less instance is named before any path-bearing call can muddy it.
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof globalThis.fetch;
    try {
      const registry = new HermesTurnRegistry();
      const err = await performHermesAgentFilesOp(
        { instanceName: "primary", gatewayHttpBase: BASE, openclawGatewayUrl: BASE, openclawToken: "t" } as never,
        registry,
        { op: "list", agentId: "hermes-agent" },
        ["SOUL.md"],
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(classifyGatewayError(err)).toBe("DASHBOARD_NOT_DEPLOYED");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("and the operator is told WHICH server is missing, not just that something 404ed", async () => {
    const err = (await withFiles({ status: 404 }, (f) =>
      f.agentFilesRoot().then(
        () => null,
        (e: unknown) => e,
      ),
    )) as Error;
    // The message is for a human reading a log; the CLASS is what code branches on.
    expect(err.message).toMatch(/dashboard/i);
    expect(err.message).toMatch(/HERMES_DASHBOARD/);
  });
});

describe("the classifier reads the TYPE, not the sentence", () => {
  it("a dashboard-absent failure gets its own code", () => {
    expect(classifyGatewayError(new HermesDashboardAbsentError("/api/files"))).toBe(
      "DASHBOARD_NOT_DEPLOYED",
    );
  });

  it("…and keeps it however the message is worded", () => {
    // The point of classifying by type: this message contains none of the words the
    // text rules look for, and it must still land on the same class.
    const err = new HermesDashboardAbsentError("/api/files");
    err.message = "zzz";
    expect(classifyGatewayError(err)).toBe("DASHBOARD_NOT_DEPLOYED");
  });

  it("a prose-only 404 is NOT promoted — the class must be earned", () => {
    // The mirror, and the reason this cannot be a regex: plenty of things 404. Only the
    // fetcher knows it asked the managed-files API and got nothing.
    expect(classifyGatewayError(new Error("files list -> HTTP 404"))).not.toBe(
      "DASHBOARD_NOT_DEPLOYED",
    );
  });
});

describe("the distinction is not unconditional", () => {
  it("a 500 stays a retryable gateway fault", async () => {
    // A dashboard that IS deployed and failing must keep its retry: telling the operator to
    // go enable a server that is already running would be the same defect, mirrored.
    const err = await withFiles({ status: 500 }, (f) =>
      f.agentFilesRoot().then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).not.toBeInstanceOf(HermesDashboardAbsentError);
    expect(classifyGatewayError(err)).toBe("UPSTREAM_ERROR");
  });

  it("a 401 stays an auth failure, not a missing server", async () => {
    // 401 means the route EXISTS and refused us — the dashboard is there, the credential is
    // wrong. Reporting "not deployed" would send the operator to fix the wrong thing.
    const err = await withFiles({ status: 401 }, (f) =>
      f.agentFilesRoot().then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(err).not.toBeInstanceOf(HermesDashboardAbsentError);
  });

  it("a healthy listing still works", async () => {
    const root = await withFiles(
      { status: 200, body: { path: "/workspace" } },
      (f) => f.agentFilesRoot(),
    );
    expect(root).toBe("/workspace");
  });
});

// ── A 404 does not mean one thing ──
//
// Raised in review, and it invalidated half the first cut. Upstream's `/api/files` handler
// raises `404 "Path not found"` when the requested PATH does not exist
// (`hermes_cli/web_server.py`) — so on a path-bearing call a 404 is ambiguous, and promoting
// it would tell an operator to go enable a server that is already running. The false
// diagnosis is the same class of defect this lot exists to remove, mirrored.
//
// The discriminator is structural, not prose: `agentFilesRoot()` calls `/api/files` with NO
// path, so the handler resolves its own managed root. A 404 THERE is the route being absent.
// And `performHermesAgentFilesOp` resolves the root before any path-bearing call, so the
// dashboard-absent case is still caught first for the tab.

describe("only an UNAMBIGUOUS 404 names the dashboard", () => {
  it("a path-bearing list 404 on a HEALTHY dashboard stays a plain failure", async () => {
    // The directory was removed between resolving the root and listing it — recoverable, and
    // nothing to do with HERMES_DASHBOARD. The stub answers per-path, because that is the
    // distinction under test: the listing 404s while the no-path probe still succeeds.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) =>
      String(input).includes("path=")
        ? new Response(JSON.stringify({ detail: "Path not found" }), { status: 404 })
        : new Response(JSON.stringify({ path: "/workspace" }), {
            status: 200,
          })) as typeof globalThis.fetch;
    try {
      const err = await fetcher()
        .listFilesStrict("/w/gone")
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).not.toBeInstanceOf(HermesDashboardAbsentError);
      expect((err as Error).message).toMatch(/404/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("…but the same 404 after the dashboard VANISHED is named", async () => {
    // The cache defeated the probe (raised in review): once a root is known, the unambiguous
    // no-path call is skipped, so a dashboard that goes away later reported a plain fault
    // forever. A path-bearing 404 now drops the cached root and re-asks.
    const f = fetcher();
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ path: "/workspace" }), {
        status: 200,
      })) as typeof globalThis.fetch;
    try {
      expect(await f.agentFilesRoot()).toBe("/workspace"); // the root is now cached
      globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof globalThis.fetch;
      const err = await f.listFilesStrict("/workspace").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HermesDashboardAbsentError);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("upstream's own `Path not found` body is refused even on the root call", async () => {
    // The residual ambiguity of the no-path call: the managed ROOT itself could be missing.
    // Upstream names that case in the body, so it is read rather than assumed away.
    const err = await withFiles(
      { status: 404, body: { detail: "Path not found" } },
      (f) =>
        f.agentFilesRoot().then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).not.toBeInstanceOf(HermesDashboardAbsentError);
  });

  it("an un-mounted route still is — that is the whole point", async () => {
    // FastAPI's own miss, which carries a different detail entirely.
    const err = await withFiles(
      { status: 404, body: { detail: "Not Found" } },
      (f) =>
        f.agentFilesRoot().then(
          () => null,
          (e: unknown) => e,
        ),
    );
    expect(err).toBeInstanceOf(HermesDashboardAbsentError);
  });
});

// ── The disappearance can happen at any point, not just before the listing ──
//
// Raised in the third review pass. Every admin op resolves the root and lists first, so the
// dashboard-absent case was caught for `list`. But the server can go away AFTER that: a `get`
// then 404s on `/api/files/read` and was reported as a MISSING FILE — the tab would cheerfully
// offer to create a file on a server that is gone — and a `set` 404s on `/upload` and fell back
// to the generic retry. The probe belongs at every ambiguous 404, not at the first one.

describe("a dashboard that vanishes mid-operation is still named", () => {
  /** Healthy until `after` calls have gone by, then 404 for everything. */
  function vanishingAfter(calls: number): void {
    let n = 0;
    globalThis.fetch = (async (input: unknown) => {
      n += 1;
      if (n > calls) return new Response("", { status: 404 });
      const url = String(input);
      if (url.includes("/api/files/read")) {
        return new Response(JSON.stringify({ data_url: "data:text/plain;base64,aGk=" }), {
          status: 200,
        });
      }
      if (url.includes("path=")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ path: "/workspace" }), { status: 200 });
    }) as typeof globalThis.fetch;
  }

  it("a READ that 404s after a healthy root is not a missing file", async () => {
    const real = globalThis.fetch;
    const f = fetcher();
    try {
      vanishingAfter(1); // the root resolves, then the server goes
      const err = await f.readAgentFile("SOUL.md").then(
        (r) => r,
        (e: unknown) => e,
      );
      expect(
        err,
        "offering to CREATE a file on a server that is gone is worse than saying so",
      ).toBeInstanceOf(HermesDashboardAbsentError);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("…while a genuinely missing file on a HEALTHY dashboard still reads as missing", async () => {
    // The discrimination, and the reason the probe cannot be replaced by "404 means gone":
    // most 404s on this route are ordinary absent files, which the tab offers to create.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/read")) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ path: "/workspace" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const r = await fetcher().readAgentFile("ABSENT.md");
      expect(r.missing).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("a WRITE that 404s is named too, not left as a generic retry", async () => {
    const real = globalThis.fetch;
    const f = fetcher();
    try {
      vanishingAfter(1);
      const err = await f.writeAgentFile("SOUL.md", "hello").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HermesDashboardAbsentError);
    } finally {
      globalThis.fetch = real;
    }
  });
});

// ── The media path told the same lie, one layer further out ──
//
// Raised in the fourth review pass, and it is the user-visible one: `open()` fetches
// `/api/files/download` — the same opt-in dashboard — and returned `not_found` for any 404. So
// a delivered file on a dashboard-less instance was recorded as a file that does not exist,
// and the produced media simply vanished with a false reason in its trace.
//
// `route_absent` is the vocabulary's EXISTING name for "the gateway has no such route" — the
// OpenClaw media fetcher already reports it. Reusing it keeps one word for one fact.

describe("a media download does not blame the file for a missing server", () => {
  it("a 404 with the dashboard GONE is route_absent, not not_found", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof globalThis.fetch;
    try {
      const r = await fetcher().open("/workspace/atrium-out/report.pdf");
      expect(r.ok).toBe(false);
      expect(
        (r as { reason: string }).reason,
        "recording a produced file as missing hides the real cause from the media trace",
      ).toBe("route_absent");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("…while a 404 on a HEALTHY dashboard is still not_found", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) =>
      String(input).includes("/api/files/download")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ path: "/workspace" }), {
            status: 200,
          })) as typeof globalThis.fetch;
    try {
      const r = await fetcher().open("/workspace/atrium-out/gone.pdf");
      expect((r as { reason: string }).reason).toBe("not_found");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("a probe that FAILS is not a probe that answered `absent`", async () => {
    // Raised in review: catching every probe failure into `route_absent` would send an
    // operator to enable a server that is deployed and merely unwell. Only the probe's own
    // verdict names absence; anything else is a transport failure and says so.
    for (const probeStatus of [500, 401]) {
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: unknown) =>
        String(input).includes("/api/files/download")
          ? new Response("", { status: 404 })
          : new Response("", { status: probeStatus })) as typeof globalThis.fetch;
      try {
        const r = await fetcher().open("/workspace/atrium-out/report.pdf");
        expect(
          (r as { reason: string }).reason,
          `probe HTTP ${probeStatus} must not read as "not deployed"`,
        ).toBe("fetch_error");
      } finally {
        globalThis.fetch = real;
      }
    }
  });

  it("…and neither is a probe that never got an answer", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes("/api/files/download")) {
        return new Response("", { status: 404 });
      }
      throw new Error("connection reset");
    }) as typeof globalThis.fetch;
    try {
      const r = await fetcher().open("/workspace/atrium-out/report.pdf");
      expect((r as { reason: string }).reason).toBe("fetch_error");
    } finally {
      globalThis.fetch = real;
    }
  });
});
