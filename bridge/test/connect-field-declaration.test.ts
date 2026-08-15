/**
 * THE MISSING DIRECTION OF THE TRUTH RATCHET — CONNECT HANDSHAKE EDITION.
 *
 * `describe-field-declaration.test.ts` closes code -> contract for the session
 * describe. Nothing closed it for the CONNECT hello-ok, and that gap is not
 * hypothetical: the device-token promotion path was built on `auth.deviceToken`,
 * which the drift-pinned 2026.7.1 does not describe at all — that version vendors
 * no `frames.ts`.
 *
 * MEASURED, 2026-08-15: the gap is in OUR COPY, not in the gateway. Read straight
 * out of the published `openclaw-2026.7.1` image (`app/dist/schema-*.js`), its own
 * `HelloOkSchema` declares `auth` with `deviceToken`, `deviceTokens`, `scopes` and
 * `issuedAtMs`. So promotion is NOT dormant against the pinned version — the field
 * really arrives. What was missing is the declaration: a dependency nothing in this
 * repo described, which is exactly how a guard built on such a field falls open in
 * silence when it eventually does go missing.
 *
 * The reference here is 2026.7.2-beta.5's HelloOkSchema, the only vendored connect
 * contract in the repo. Two consequences are deliberate:
 *   - a read that even the NEWEST vendored contract does not declare is a guess,
 *     and fails this gate;
 *   - a read the contract declares as OPTIONAL is legitimate, but the code must
 *     survive its absence — which is why the promotion path treats a missing
 *     `deviceToken` as "nothing to do" and a failed promotion as "keep the
 *     connection", never as a connect failure.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

/** The connect contract we instruct against. NOT the drift pin: 2026.7.1 vendors
 *  no frames.ts, so it can describe nothing about the handshake. */
const CONNECT_CONTRACT_VERSION = "2026.7.2-beta.5";

/** Every property name declared inside HelloOkSchema, nested objects included. */
function declaredHelloOkFields(): Set<string> {
  const src = read(
    `../protocol/openclaw/${CONNECT_CONTRACT_VERSION}/frames.ts`,
  );
  const start = src.indexOf("export const HelloOkSchema");
  const end = src.indexOf("export type HelloOk ");
  expect(start, "HelloOkSchema moved or was renamed").toBeGreaterThan(-1);
  expect(end, "the HelloOk type alias moved").toBeGreaterThan(start);
  const block = src.slice(start, end);
  const names = new Set<string>();
  for (const match of block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/** The hello-ok fields the handshake actually reads, derived from the SOURCE. */
function readHelloOkFields(): string[] {
  const src = read("../src/providers/openclaw/openclaw-client.ts");
  const start = src.indexOf("// hello-ok: server info is under `payload`");
  const end = src.indexOf("const error = (frame.error ?? {})");
  expect(start, "the hello-ok branch moved — this gate sweeps nothing").toBeGreaterThan(
    -1,
  );
  expect(end, "the connect-failure branch moved").toBeGreaterThan(start);
  const block = src.slice(start, end);
  const found = new Set<string>();
  // The hello-ok payload and the four objects destructured out of it. `frame.*`
  // is the ENVELOPE (type/id/ok/payload/error), not the hello-ok body, so it is
  // deliberately not swept here.
  for (const match of block.matchAll(
    /\b(?:payload|server|auth|policy|features)\.([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

function allowlist(): Map<
  string,
  { reason: string; whenAbsent: string; keepBecause: string }
> {
  const doc = JSON.parse(
    read("../protocol/openclaw/undeclared-connect-reads.json"),
  ) as {
    fields: Record<
      string,
      { reason: string; whenAbsent: string; keepBecause: string }
    >;
  };
  return new Map(Object.entries(doc.fields));
}

describe("a connect hello-ok field we read must be declared somewhere", () => {
  it("the reference set really is HelloOkSchema, and it carries the handshake names", () => {
    const declared = declaredHelloOkFields();
    // Anchors: the facts the bridge depends on at connect time. If upstream renames
    // one, this fails here rather than quietly emptying the reference set.
    for (const anchor of [
      "server",
      "version",
      "policy",
      "maxPayload",
      "auth",
      "deviceToken",
      "features",
    ]) {
      expect(declared.has(anchor), `${anchor} is no longer in HelloOkSchema`).toBe(
        true,
      );
    }
  });

  it("every hello-ok field the handshake reads is declared, or on the record", () => {
    const declared = declaredHelloOkFields();
    const allowed = allowlist();
    const readFields = readHelloOkFields();

    // The sweep must find something: an empty region would make this gate pass by
    // measuring nothing — the failure mode of every derived check.
    expect(readFields.length).toBeGreaterThan(4);

    const unaccounted = readFields.filter(
      (field) => !declared.has(field) && !allowed.has(field),
    );
    expect(
      unaccounted,
      `these fields are read off the connect hello-ok but appear in neither ${CONNECT_CONTRACT_VERSION}'s HelloOkSchema nor undeclared-connect-reads.json. They will arrive undefined against a gateway that does not send them, and whatever depends on them will fall open in silence. Declare each one — with what the code does when it is absent — or stop reading it.`,
    ).toEqual([]);
  });

  it("the allowlist stays HONEST: no entry for a declared or unread field", () => {
    const declared = declaredHelloOkFields();
    const readFields = new Set(readHelloOkFields());
    for (const [field, entry] of allowlist()) {
      expect(
        declared.has(field),
        `${field} IS declared by ${CONNECT_CONTRACT_VERSION} — remove it from the allowlist`,
      ).toBe(false);
      expect(
        readFields.has(field),
        `${field} is on the allowlist but nothing reads it any more — delete the entry`,
      ).toBe(true);
      expect(
        entry.whenAbsent.length,
        `${field} must state its absent-behaviour`,
      ).toBeGreaterThan(40);
    }
  });

  it("device-token promotion is OPTIONAL by contract, so the code may not require it", () => {
    const frames = read(
      `../protocol/openclaw/${CONNECT_CONTRACT_VERSION}/frames.ts`,
    );
    const helloOk = frames.slice(
      frames.indexOf("export const HelloOkSchema"),
      frames.indexOf("export type HelloOk "),
    );
    const authBlock = helloOk.slice(helloOk.indexOf("auth: closedObject("));
    // Upstream marks it Optional. That is the contractual licence for a gateway to
    // send no device token at all — which the drift-pinned 2026.7.1 cannot even
    // describe. A connect path that treated its absence, or a failure to persist
    // it, as fatal would break against a conforming gateway.
    expect(authBlock).toContain("deviceToken: Type.Optional(");

    const client = read("../src/providers/openclaw/openclaw-client.ts");
    const promotion = client.slice(
      client.indexOf("// DEVICE-TOKEN PROMOTION."),
      client.indexOf("const error = (frame.error ?? {})"),
    );
    expect(
      promotion.length,
      "the promotion block moved — this assertion sweeps nothing",
    ).toBeGreaterThan(200);

    // Slice the FAILURE BRANCH ALONE. Asserting over the whole promotion block was
    // measuring nothing: the ordinary path calls `finishConnection()` a few lines
    // further down and inside the same slice, so a destructive catch still passed.
    const catchStart = promotion.indexOf(".catch(");
    expect(catchStart, "the promotion has no failure branch").toBeGreaterThan(-1);
    const failureBranch = promotion.slice(catchStart);
    expect(
      failureBranch,
      "a failed promotion must adopt the already-authenticated connection",
    ).toContain("finishConnection();");
    expect(
      failureBranch,
      "a failed promotion must NOT reject the connect: the hello-ok already succeeded, and the write it could not perform is idempotent and retried on the next connect",
    ).not.toContain("fail(");

    // The handshake deadline must be disarmed BEFORE the promotion starts. Left
    // running, its 30s can elapse during a promotion that carries its own timeout,
    // terminate a socket that is already authenticated, and reject the connection —
    // after which the tolerant branch above finds `settled` and can keep nothing.
    // Asserted here rather than behaviourally: proving it live means waiting out a
    // real 30-second timer against a real socket.
    const disarm = promotion.indexOf("clearTimeout(connectTimer)");
    const promote = promotion.indexOf("void promoteDeviceToken(");
    expect(disarm, "the promotion no longer disarms the handshake deadline").toBeGreaterThan(-1);
    expect(promote, "the promotion call moved").toBeGreaterThan(-1);
    expect(
      disarm,
      "the handshake deadline must be cleared BEFORE the promotion runs, or it can kill an already-authenticated socket mid-promotion",
    ).toBeLessThan(promote);
  });
});
