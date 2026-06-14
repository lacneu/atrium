#!/usr/bin/env node
// Live validation of outbound trace-shipping (Langfuse + Opik).
//
// WHY: "configured" (keys present) does NOT mean "working" — the live POST can
// still 4xx (wrong URL, schema, vendor quota). This probe ships a real marked
// metadata event and asserts a 2xx PER VENDOR, so a half-broken config fails
// loudly instead of silently dropping traces in production.
//
// DE-RISK THE NAS: a green run HERE only proves the keys + code path are correct
// on THIS deployment. It does NOT prove the NAS works — env vars do NOT transfer
// between deployments, and NAS egress/firewall/TLS can differ. The real
// pre-flight is to run THIS script ON the NAS after setting its env:
//   CONVEX_AGENT_MODE=anonymous node scripts/validate-trace-shipping.mjs
// (or with the NAS deployment selected for `npx convex run`).
//
// Each run leaves ONE probe span in each working vendor's dashboard
// (kind="test.shipping_probe", correlationId="probe-<ts>"; metadata only, no PHI).
// Re-running proves steady-state (not just the first-after-init flush).
//
// Exit code: 0 = every CONFIGURED vendor shipped 2xx; 1 = any configured vendor
// failed (prints which + the vendor status/reason). Unconfigured vendors are
// skipped (a deliberate config choice), not a failure.

import { execFileSync } from "node:child_process";

const MODE = process.env.CONVEX_AGENT_MODE || "anonymous";
const childEnv = { ...process.env, CONVEX_AGENT_MODE: MODE };

function convexRun(fn, args) {
  const out = execFileSync(
    "npx",
    ["convex", "run", fn, JSON.stringify(args)],
    { env: childEnv, encoding: "utf8" },
  );
  return out;
}

function parseJsonBlob(s) {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`No JSON in output:\n${s}`);
  return JSON.parse(s.slice(start, end + 1));
}

const ts = Date.now();
const probe = {
  kind: "test.shipping_probe",
  principalType: "system",
  direction: "internal",
  correlationId: `probe-${ts}`,
  meta: JSON.stringify({ probe: true, ts }),
};

console.log(`[validate-trace-shipping] mode=${MODE}`);
console.log(`Seeding probe event (correlationId=probe-${ts})…`);
convexRun("observability:recordEvent", probe);

console.log("Flushing to vendors (real POST)…");
const result = parseJsonBlob(convexRun("integrations/ship:flushToVendors", {}));

let failed = 0;
let skipped = 0;
for (const v of result.vendors ?? []) {
  if (!v.configured) {
    console.log(`  ⚠ ${v.vendor}: SKIP — clé absente dans l'env de ce déploiement`);
    skipped++;
    continue;
  }
  const httpOk =
    v.status === undefined || (v.status >= 200 && v.status < 300);
  if (v.ok && httpOk) {
    console.log(
      `  ✓ ${v.vendor}: OK (status=${v.status ?? "—"}, shipped=${v.shipped ?? 0})`,
    );
  } else {
    console.log(
      `  ✗ ${v.vendor}: ÉCHEC (status=${v.status ?? "—"}, reason=${v.reason ?? "—"})`,
    );
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n✗ ${failed} vendor(s) en échec — NE PAS considérer comme prêt.`);
  process.exit(1);
}
console.log(
  `\n✓ Validation OK — chaque vendor configuré a expédié (2xx). ${skipped} non configuré(s) ignoré(s).`,
);
