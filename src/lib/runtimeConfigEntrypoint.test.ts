// @vitest-environment node
//
// docker/docker-entrypoint.sh writes the SPA's runtime config by string concatenation.
// A value that is not what it claims to be must never corrupt that JSON: the required
// Convex URL stops the container, an optional value is skipped with a warning, and the
// widget sandbox origin must be a bare http(s) origin.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ENTRYPOINT = resolve(process.cwd(), "docker/docker-entrypoint.sh");
const dir = mkdtempSync(join(tmpdir(), "atrium-entrypoint-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function run(env: Record<string, string>): { code: number; config: unknown; stderr: string } {
  const out = join(dir, `config-${n++}.json`);
  try {
    execFileSync("sh", [ENTRYPOINT, "true"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ATRIUM_RUNTIME_CONFIG_PATH: out, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    return { code: e.status ?? -1, config: null, stderr: String(e.stderr ?? "") };
  }
  return { code: 0, config: JSON.parse(readFileSync(out, "utf8")), stderr: "" };
}

const URL_OK = { CONVEX_URL: "https://api.example.com" };

describe("the runtime config the entrypoint writes", () => {
  it("keeps valid values", () => {
    expect(
      run({
        ...URL_OK,
        CONVEX_SITE_ORIGIN: "https://site.example.com",
        WIDGET_SANDBOX_ORIGIN: "https://widgets.example.com:8443",
      }).config,
    ).toEqual({
      convexUrl: "https://api.example.com",
      convexSiteUrl: "https://site.example.com",
      widgetSandboxOrigin: "https://widgets.example.com:8443",
    });
  });

  it.each([
    "https://w.example.com/path",
    'https://w.example.com", "convexUrl": "https://evil',
    "javascript:alert(1)",
    "https://w.example.com:port",
    "//w.example.com",
  ])("skips a widget sandbox origin that is not a bare origin: %s", (bad) => {
    expect(run({ ...URL_OK, WIDGET_SANDBOX_ORIGIN: bad }).config).toEqual({ convexUrl: "https://api.example.com" });
  });

  it.each(['https://s"x', "https://s\\x", "https://s\nx", "https://s x"])(
    "skips a site origin that would corrupt the JSON: %j",
    (bad) => {
      expect(run({ ...URL_OK, CONVEX_SITE_ORIGIN: bad }).config).toEqual({ convexUrl: "https://api.example.com" });
    },
  );

  it("refuses to start on a Convex URL that would corrupt the JSON", () => {
    const out = run({ CONVEX_URL: 'https://api" x' });
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("CONVEX_URL");
  });
});
