/**
 * THE PREFLIGHT'S CLAIMS ARE PINNED, NOT NARRATED.
 *
 * `deploy/compose/preflight.sh` is the installer's go/no-go: a wrong verdict
 * either blocks a valid install or waves through the exact silent failures it
 * exists to catch (the media-mount trap chief among them — host dirs declared in
 * `.env`, consumed by nothing). A shell script has no type checker, so its four
 * outcome paths are pinned here, against the real script, with real env files.
 *
 * `--env-only` exists precisely so this suite runs hermetically: the tooling
 * probes (docker, openssl) depend on the host and are skipped; every env check —
 * the durable part — runs in full.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../deploy/compose/preflight.sh", import.meta.url)
  .pathname;

function run(envPath: string): { code: number; out: string } {
  const r = spawnSync("bash", [SCRIPT, "--env-only", envPath], {
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

const hex = () => randomBytes(32).toString("hex");

function completeEnv(): string {
  return [
    `BRIDGE_SHARED_SECRET=${hex()}`,
    `BRIDGE_INGEST_SECRET=${hex()}`,
    "CONVEX_HTTP_ACTIONS_URL=https://convex.example.com/http",
    "OPENCLAW_GATEWAY_URL=ws://gateway:18789",
    "CONVEX_CLOUD_PORT=3210",
    "CONVEX_SITE_PORT=3211",
    "SITE_URL=https://atrium.example.com",
    "JWT_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----TEST-----END PRIVATE KEY-----",
    'JWKS={"keys":[]}',
    `ATRIUM_SECRET_KEY=${hex()}`,
    "BRIDGE_URL=http://bridge:8787",
    "AUTH_ALLOWED_EMAIL_DOMAINS=example.org",
    `BRIDGE_INSTANCE_SECRETS=${hex()}`,
  ].join("\n");
}

describe("preflight.sh — the four outcome paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-preflight-"));

  it("a missing env file is a FAILURE with a pointer, not a crash", () => {
    const { code, out } = run(join(dir, "absent.env"));
    expect(code).toBe(1);
    expect(out).toContain("does not exist");
  });

  it("the shipped .env.example, unfilled, FAILS on every required variable", () => {
    // The raw example must never pass: an installer who skipped the fill step
    // has to be stopped here, before a half-alive stack hides the mistake.
    const example = readFileSync(
      new URL("../../deploy/compose/.env.example", import.meta.url),
      "utf8",
    );
    const p = join(dir, "raw.env");
    writeFileSync(p, example);
    const { code, out } = run(p);
    expect(code).toBe(1);
    expect(out).toContain("BRIDGE_SHARED_SECRET");
  });

  it("a complete, coherent env passes with exit 0", () => {
    const p = join(dir, "good.env");
    writeFileSync(p, completeEnv());
    const { code, out } = run(p);
    expect(out).toContain("0 failure(s)");
    expect(code).toBe(0);
  });

  it("media host dirs declared while the mounts stay commented is a FAILURE", () => {
    // The trap this script exists for: two variables set faithfully in `.env`,
    // consumed by nothing, media delivery failing with no error anywhere.
    const p = join(dir, "media.env");
    writeFileSync(
      p,
      completeEnv() +
        "\nOPENCLAW_MEDIA_OUTBOUND_HOST_DIR=/srv/instances/alpha/.openclaw/media/outbound" +
        "\nOPENCLAW_INBOUND_HOST_DIR=/srv/instances/alpha/.openclaw/media/inbound\n",
    );
    const { code, out } = run(p);
    expect(code).toBe(1);
    expect(out).toContain("commented out");
  });

  it("identical bridge secrets are refused — they guard opposite directions", () => {
    const shared = hex();
    const p = join(dir, "same-secrets.env");
    writeFileSync(
      p,
      completeEnv()
        .replace(/BRIDGE_SHARED_SECRET=.*/, `BRIDGE_SHARED_SECRET=${shared}`)
        .replace(/BRIDGE_INGEST_SECRET=.*/, `BRIDGE_INGEST_SECRET=${shared}`),
    );
    const { code, out } = run(p);
    expect(code).toBe(1);
    expect(out).toContain("separately revocable");
  });
});
