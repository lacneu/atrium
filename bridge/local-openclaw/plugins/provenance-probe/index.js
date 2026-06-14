// Provenance Contract Probe — bench/CI fixture, NEVER for production.
//
// Emits, on every agent turn, the EXACT provenance/v1 reports the real
// plugins (@lacneu/hindsight-openclaw, @lacneu/openclaw-knowledge) emit when
// `provenanceReport` is enabled: one `memory` report and one `documents`
// report, with DETERMINISTIC content so the live-protocol suite (C18) and the
// CI job can pin byte-stable expectations against a REAL gateway.
//
// Contract under test (docs/PROVENANCE_CONTRACT.md in atrium):
//   gw.emitAgentEvent({ runId, sessionKey, stream: "provenance", data: <v1> })
//   fired from the `before_prompt_build` hook (ctx carries runId/sessionKey).
//
// Feature detection: a gateway whose plugin SDK predates emitAgentEvent logs
// `[provenance-probe] sdk-lacks-emitAgentEvent` and stays silent — the suite
// reads that marker to make C18's expectation version-aware.

const REPORTS = [
  {
    v: 1,
    source: "hindsight",
    kind: "memory",
    injected: { chars: 420, position: "system_prepend", truncated: false },
    retrieval: { route: "ALL", bank: "bench::probe::user" },
    items: [
      {
        id: "mem_bench_001",
        type: "observation",
        date: "2026-06-01",
        score: 0.91,
        text: "Bench observation: the user prefers concise answers.",
      },
      {
        id: "mem_bench_002",
        type: "world",
        date: "2026-05-20",
        score: 0.84,
        text: "Bench fact: the validation bench runs a pinned gateway.",
      },
    ],
  },
  {
    v: 1,
    source: "knowledge",
    kind: "documents",
    injected: { chars: 1300, position: "system_append", truncated: false },
    retrieval: {
      route: "pgvector",
      collections: ["knowledge_bench"],
      lightrag: { mode: "mix", contextChars: 0 },
    },
    items: [
      {
        file_name: "bench-compliance-report.pdf",
        collection: "knowledge_bench",
        score: 0.93,
        text: "Bench chunk: section 4.2 defines the retention policy.",
      },
    ],
  },
];

// GATEWAY QUIRK (bench-verified 2026-06-12, OpenClaw 2026.6.1): the agent
// runtime RE-REGISTERS plugins per run; emitAgentEvent called through a
// re-registration's api is rejected `{emitted:false, reason:"plugin is not
// loaded"}` — only the FIRST registration's api (the gateway-global one) stays
// "loaded". The ESM module cache is per-process, so capturing that first api
// here lets every later hook invocation emit through it. Real plugins MUST do
// the same (documented in docs/PROVENANCE_CONTRACT.md).
let stableApi = null;

export default {
  id: "provenance-probe",
  name: "Provenance Contract Probe",
  description: "Deterministic provenance/v1 emitter for bench + CI",

  register(api) {
    const cfg = api.pluginConfig ?? {};
    if (cfg.enabled === false) return;
    if (stableApi === null) stableApi = api;
    // Load marker: lets the bench/CI distinguish "plugin not loaded" from
    // "loaded but hook never fired" in the gateway logs.
    api.logger.info("[provenance-probe] ready");

    api.on("before_prompt_build", (event, ctx) => {
      // Emit through the FIRST registration's api (see stableApi above).
      const gw = stableApi ?? api;
      try {
        if (typeof gw.emitAgentEvent !== "function") {
          // Old SDK: real plugins stay silent the same way; the marker makes
          // the live suite's expectation version-aware.
          gw.logger.info("[provenance-probe] sdk-lacks-emitAgentEvent");
          return;
        }
        const runId = ctx?.runId;
        const sessionKey = ctx?.sessionKey;
        if (!runId) {
          // The gateway REQUIRES runId on plugin agent events.
          gw.logger.info("[provenance-probe] skipped: no runId in hook ctx");
          return;
        }
        for (const report of REPORTS) {
          // CONTRACT: plugin agent events must be scoped to the emitter —
          // stream === pluginId or "<pluginId>.<suffix>". The webchat bridge
          // detects the ".provenance" suffix; the gateway stamps pluginId
          // into `data` (authenticated emitter identity, spoof-proof).
          const res = gw.emitAgentEvent({
            runId,
            ...(sessionKey ? { sessionKey } : {}),
            stream: "provenance-probe.provenance",
            data: report,
          });
          if (res && res.emitted === false) {
            gw.logger.info(`[provenance-probe] rejected: ${res.reason}`);
            return;
          }
        }
        gw.logger.info(
          `[provenance-probe] emitted runId=${runId} sessionKey=${sessionKey ?? "none"}`,
        );
      } catch (err) {
        // A probe must never break a turn — mirror the real plugins' fail-silent rule.
        gw.logger.info(`[provenance-probe] emit-failed ${err?.message ?? err}`);
      }
    });
  },
};
