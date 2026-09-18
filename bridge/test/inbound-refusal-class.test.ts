// A refusal RAISED BY THE BRIDGE ITSELF, on the inbound-media path, must never be
// reported as an unrecognised GATEWAY error — the gateway never answered anything,
// because the turn was never sent (session RPCs may already have gone out; the
// staging sits before `chat.send`). Live prod 2026-09-17: every attachment send
// with `UPSTREAM_ERROR`, whose fault domain is `bridge`, so one attachment marked
// a perfectly healthy connection dead for five minutes and told the user their
// next send would fail — while text-only sends kept going through on that link.
import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  classifyGatewayError,
  faultDomain,
} from "../src/core/dispatch-errors.js";
import { HealthRegistry } from "../src/core/health.js";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOUND_CLEANUP_FAILED,
  INBOUND_NAME_TOO_LONG,
  INBOUND_COLLISION,
  INBOUND_FETCH_FAILED,
  INBOUND_PATH_REFUSED,
  INBOUND_STAGE_FAILED,
  INBOUND_TOO_LARGE,
  InboundMediaRefusal,
  logInboundRefusal,
  stageInboundReferences,
} from "../src/core/inbound-media.js";

describe("an inbound-media refusal is OURS, and says so", () => {
  const CASES: Array<[string, string]> = [
    [INBOUND_PATH_REFUSED, "attachment_path_refused"],
    [INBOUND_NAME_TOO_LONG, "attachment_name_too_long"],
    [INBOUND_STAGE_FAILED, "attachment_staging_failed"],
    [INBOUND_CLEANUP_FAILED, "attachment_cleanup_unconfirmed"],
    // Dropped per file in practice; mapped so the size answer can never regress
    // into "unrecognised upstream error".
    [INBOUND_TOO_LARGE, "ATTACHMENT_TOO_LARGE"],
    [INBOUND_COLLISION, "attachment_staging_failed"],
    [INBOUND_FETCH_FAILED, "attachment_staging_failed"],
  ];

  test("each refusal gets its own class, never the gateway catch-all", () => {
    for (const [code, expected] of CASES) {
      expect(
        classifyGatewayError(new InboundMediaRefusal(code), {
          hasAttachments: true,
        }),
        code,
      ).toBe(expected);
    }
  });

  test("and NONE of them touches the connectivity verdict — either way", () => {
    // Through the REAL registry, because `faultDomain` alone proved only half of
    // it: `downstream` would have been just as wrong as `bridge`, since
    // `recordDownstreamReject` forces `state = "connected"` — a local refusal
    // would then have ERASED a real network incident and reported the instance
    // green (codex). The only truthful answer is to leave the state alone.
    const ref = {
      key: "u",
      canonical: "u",
      agentId: "a",
      gatewayHost: "gw:1",
      instanceName: "i",
    };
    for (const [code, expected] of CASES) {
      if (expected === "ATTACHMENT_TOO_LARGE") continue; // a real gateway class
      const cls = classifyGatewayError(new InboundMediaRefusal(code), {
        hasAttachments: true,
      });
      expect(faultDomain(cls), code).toBe("local");

      // A link that is genuinely DOWN stays down.
      const down = new HealthRegistry(1000, () => 2000);
      down.recordError(ref, "GATEWAY_TIMEOUT");
      down.recordLocalRefusal(ref, cls);
      expect(down.snapshot().targets[0]!.state, `${code}: erased an outage`).toBe(
        "error",
      );

      // A link that is genuinely UP stays up.
      const up = new HealthRegistry(1000, () => 2000);
      up.recordOk(ref);
      up.recordLocalRefusal(ref, cls);
      expect(up.snapshot().targets[0]!.state, `${code}: killed a live link`).toBe(
        "connected",
      );
      // …and the refusal is still VISIBLE: recorded, counted, named — in a field
      // of its OWN, because the admin card renders `lastDownstreamReject` as
      // "rejected by the gateway", about a gateway that never saw the request.
      const t = up.snapshot().targets[0]!;
      expect(t.lastLocalRefusal?.code, code).toBe(cls);
      expect(t.localRefusalCount, code).toBe(1);
      // The send WAS attempted, and the admin line counts attempts — a refused
      // attachment must not read as "nothing happened" (codex).
      expect(t.attempts, `${code}: the attempt went uncounted`).toBe(2);
      expect(t.lastDownstreamReject, `${code}: borrowed the gateway's note`).toBeNull();
      expect(t.lastError, `${code}: minted a bridge error`).toBeNull();
    }
  });

  test("the refusal NAMES the clause that refused, not just the code", async () => {
    // WHAT THIS IS FOR. `inbound_media_path_refused` covers a dozen clauses, and the
    // message named none of them: a live incident spent two hours discovering that
    // two sibling directories were missing, and the bench spent two more on a
    // `/home` symlink and then a world-writable ancestor. The code stays the wire
    // contract; the reason is the sentence the operator needs, and it is STRUCTURAL
    // — the rule and the directory, never a filename.
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-reason-")));
    try {
      const thrown = (await stageInboundReferences(
        [{ url: "u", mimeType: "application/pdf", fileName: "secret-invoice.pdf" }],
        "cmid",
        {
          // The production shape of the failure: the root is there, the published
          // directory beside it is not.
          inboundDir: join(root, "published"),
          stagingDir: join(root, ".staging"),
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      )) as InboundMediaRefusal | null;
      expect(thrown, "the staging did not refuse").toBeInstanceOf(
        InboundMediaRefusal,
      );
      // STAGE_FAILED, not PATH_REFUSED: an absent directory is "the place to write
      // is gone", the same fact as a mount vanishing mid-batch, and the existing
      // suite pins that classification. A first version of this change turned the
      // absence into a path refusal and moved a wire-visible code — the rollback
      // test caught it.
      expect(thrown!.code).toBe("inbound_media_stage_failed");
      expect(thrown!.reason, "the refusal carries no reason").toBeTruthy();
      // It says WHICH directory and WHY, so the next step is obvious.
      expect(thrown!.reason).toContain(join(root, "published"));
      expect(thrown!.reason).toMatch(/does not exist/);
      // …and it does NOT carry the user's filename into a log line.
      expect(thrown!.reason).not.toContain("secret-invoice");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("NO reason anywhere interpolates the user's filename", () => {
    // The assertion above covers ONE early failure, and sampling cannot cover the
    // rest: the leaf rules work on the composed disk name, which contains the
    // filename, and a reason added there later would slip past any single fixture.
    // (Those clauses do not throw — a bad file is DROPPED best-effort — so there is
    // no thrown reason to inspect for them at all.) The invariant is total, so it is
    // asserted at the source: no `refused(...)` reason may interpolate a name.
    const src = readFileSync(
      new URL("../src/core/inbound-media.ts", import.meta.url),
      "utf8",
    );
    // Every `refused(` call's arguments, comments stripped.
    // The structural expressions a reason may carry, PER FUNCTION.
    //
    // A flat list was wrong: `path` is a configured directory in
    // `openPrivateDirectory` and in `assertPrivateDirectory`, but in
    // `assertInboundFile` the caller passes `diskPath` — the composed name, which
    // contains the reader's filename. One list vouched for all three (codex). A name
    // is now vouched for in the scope where someone looked at what it holds.
    const ALLOWED_IN: Record<string, string[]> = {
      openPrivateDirectory: [
        "path",
        "current",
        "real",
        '(error as NodeJS.ErrnoException)?.code ?? "unknown"',
        "metadata.uid",
        "expectedUid",
        // A local holding "it does not exist" or an errno phrase — structural, and
        // the allowlist caught it the moment it was written, which is the point.
        "why",
      ],
      assertPrivateDirectory: ["path", "opened.uid", "expectedUid"],
      openMediaDirectories: [
        "config.inboundDir",
        "config.stagingDir",
        "publishedStat.dev",
        "stagingStat.dev",
      ],
      assertInboundFile: [
        // NOT `path`: here it is the composed disk name.
        "opened.nlink",
        "expectedLinks",
        "(opened.mode & 0o777).toString(8)",
        "PRIVATE_FILE_MODE.toString(8)",
        "opened.uid",
        "process.geteuid?.()",
      ],
      // The helper itself: it forwards its own parameter to the constructor. Every
      // call site's reason is checked above, so what arrives here has already been
      // vouched for — this entry says that out loud rather than special-casing it.
      refused: ["reason"],
      stageInboundReferenceOwned: [
        "config.maxBytes",
        "Buffer.byteLength(diskName)", // a LENGTH, not the name
        "MAX_LEAF_BYTES",
      ],
    };

    // The reasons, taken from the TYPESCRIPT AST.
    //
    // Three text-based versions were wrong in a row, each in a way the next one only
    // narrowed: forbidden spellings, then `${…}` holes, then a hand-walked expression
    // whose paren balancing counted parentheses INSIDE string literals — so
    // `` refused(CODE, `${config.inboundDir})${ref.fileName}`) `` read as safe, and
    // `refused (CODE, ref.fileName)`, with a space, was not seen at all (codex). The
    // compiler already knows where a call ends and what its arguments are.
    const sf = ts.createSourceFile(
      "inbound-media.ts",
      src,
      ts.ScriptTarget.Latest,
      true,
    );
    const unwrap = (e: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
    const enclosingFunction = (node: ts.Node): string => {
      let p: ts.Node | undefined = node.parent;
      while (p) {
        if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
        if (ts.isVariableDeclaration(p) && p.name) return p.name.getText(sf);
        p = p.parent;
      }
      return "<top>";
    };

    const reasons: { expr: ts.Expression; fn: string }[] = [];
    // `refused` must never become a VALUE. `(refused)(…)`, `const reject = refused`
    // and `new InboundMediaRefusal(…)` all raise a refusal while escaping a collector
    // that only matches a bare callee (codex), so the collector takes the first and
    // the last, and this walk REFUSES the second outright: static collection cannot
    // follow an alias, so the alias must not exist.
    const escapedNames: string[] = [];
    const unreadable: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = unwrap(node.expression as ts.Expression);
        const name = ts.isIdentifier(callee) ? callee.text : null;
        if (name === "refused" || name === "InboundMediaRefusal") {
          const args = node.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>);
          // A SPREAD cannot be read statically: `new InboundMediaRefusal(...[CODE,
          // path])` has ONE argument and hid the reason entirely (codex). There is no
          // safe way to inspect it, so it is a failure rather than a skip.
          if (args.some((a) => ts.isSpreadElement(a))) {
            unreadable.push(node.getText(sf).slice(0, 80));
          } else if (args.length > 1) {
            reasons.push({ expr: args[1]!, fn: enclosingFunction(node) });
          }
        }
      }
      // BOTH names. Closing the alias on `refused` alone still let
      // `const Reject = InboundMediaRefusal; throw new Reject(CODE, path)` through
      // (codex): the escape is the aliasing, not the particular name.
      if (
        ts.isIdentifier(node) &&
        (node.text === "refused" || node.text === "InboundMediaRefusal") &&
        !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
        !(ts.isClassDeclaration(node.parent) && node.parent.name === node)
      ) {
        let up: ts.Node = node;
        while (ts.isParenthesizedExpression(up.parent)) up = up.parent;
        const isCallee =
          (ts.isCallExpression(up.parent) || ts.isNewExpression(up.parent)) &&
          up.parent.expression === up;
        // A TYPE position names the class without capturing it: an annotation, an
        // `instanceof`, an export specifier. None of them can raise a refusal.
        // `ExpressionWithTypeArguments` is NOT always a type position: in
        // `class Reject extends InboundMediaRefusal` it is a runtime capture, and a
        // subclass calling `super(CODE, path)` escaped both this closure and the
        // reason collector (codex). Only an `implements` clause is inert.
        const heritage = ts.isExpressionWithTypeArguments(node.parent)
          ? node.parent.parent
          : undefined;
        const isInertHeritage =
          heritage !== undefined &&
          ts.isHeritageClause(heritage) &&
          heritage.token === ts.SyntaxKind.ImplementsKeyword;
        const isTypeOrExport =
          ts.isTypeReferenceNode(node.parent) ||
          isInertHeritage ||
          ts.isExportSpecifier(node.parent) ||
          ts.isImportSpecifier(node.parent) ||
          (ts.isBinaryExpression(node.parent) &&
            node.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
            node.parent.right === node);
        if (!isCallee && !isTypeOrExport) escapedNames.push(node.getText(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(
      escapedNames,
      "`refused` or `InboundMediaRefusal` is used as a value somewhere — an alias " +
        "cannot be followed " +
        "statically, so this guard would stop seeing the refusals raised through it",
    ).toEqual([]);
    // SHADOWING. The allowlist vouches for an expression by its TEXT, in a function
    // named by its position — neither resolves the symbol. So a local rebinding of an
    // allowlisted root turns a vouched name into anything at all, and
    // `const config = { maxBytes: ref.fileName }` inside
    // `stageInboundReferenceOwned` would have logged the filename through
    // `${config.maxBytes}` (codex). Resolving symbols properly means a full
    // TypeChecker over the project; forbidding the rebinding is exact, cheap, and
    // fails closed — the roots may only be the parameters and imports the reader of
    // this allowlist actually looked at.
    const shadowed: string[] = [];
    const roots = new Set(
      Object.values(ALLOWED_IN)
        .flat()
        .map((e) => /^[A-Za-z_$][\w$]*/.exec(e)?.[0])
        .filter((r): r is string => Boolean(r)),
    );
    const findShadowing = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isBindingElement(node) ||
          // PARAMETERS are bindings too: `path` is one, and leaving them out meant the
          // inventory did not cover the very name the allowlist vouches for (codex).
          ts.isParameter(node)) &&
        ts.isIdentifier(node.name) &&
        roots.has(node.name.text)
      ) {
        shadowed.push(`${enclosingFunction(node)}: ${node.name.text}`);
      }
      ts.forEachChild(node, findShadowing);
    };
    findShadowing(sf);
    // The bindings that EXIST today, each one a place someone read to write the
    // allowlist. Forbidding every binding outright was wrong — the values have to be
    // computed somewhere — so the inventory is FROZEN instead: a new binding of a
    // vouched root, anywhere, fails this until someone looks at what it holds and
    // adds it here on purpose.
    const KNOWN_BINDINGS = [
      "<top>: MAX_LEAF_BYTES",
      "<top>: PRIVATE_FILE_MODE",
      // A destructured pair: `enclosingFunction` reports the binding pattern it sits
      // in, which is stable and enough to notice a move.
      "[publishedStat, stagingStat]: publishedStat",
      "[publishedStat, stagingStat]: stagingStat",
      "assertInboundFile: current",
      "assertInboundFile: opened",
      "assertPrivateDirectory: current",
      "assertPrivateDirectory: expectedUid",
      "assertPrivateDirectory: opened",
      "openPrivateDirectory: current",
      "openPrivateDirectory: expectedUid",
      "openPrivateDirectory: metadata",
      "openPrivateDirectory: real",
      "openPrivateDirectory: why",
      "removeOwnedPartial: current",
      "rollbackPublished: path",
      // …and the PARAMETERS, now that they count as bindings. Each was read to write
      // the allowlist: `path` is a configured directory in `openPrivateDirectory` and
      // `assertPrivateDirectory` and the composed disk name in `assertInboundFile`
      // (which is why it is absent from that function's list), `config` is the
      // resolved configuration, `reason` is the already-checked message the helper
      // forwards, `expectedLinks` is a count.
      "<top>: reason",
      "assertInboundFile: expectedLinks",
      "assertInboundFile: path",
      "assertPrivateDirectory: path",
      "openMediaDirectories: config",
      "openPrivateDirectory: path",
      "refused: reason",
      "removeOwnedPartial: expectedLinks",
      "removeOwnedPartial: path",
      "requireAbsent: path",
      "rollbackPublished: config",
      "stageInboundReference: config",
      "stageInboundReferenceOwned: config",
      "stageInboundReferences: config",
      "stageInboundReferences: reason",
    ].sort();
    // NOT deduplicated: counting is what catches a homonym added in a nested block,
    // where a `Set` collapsed the second binding onto the first and stayed green
    // (codex). A move WITHIN a function still passes — the name is bound the same
    // number of times in the same place — which is the limit of a structural
    // inventory and the reason this is a guard, not a proof.
    expect(
      [...shadowed].sort(),
      "a binding of a name the refusal allowlist vouches for appeared or moved — the " +
        "allowlist judges an expression by its TEXT, so a rebinding makes it vouch " +
        "for something nobody looked at",
    ).toEqual(KNOWN_BINDINGS);
    expect(
      unreadable,
      "a refusal is raised with spread arguments — its reason cannot be read " +
        "statically, so write the arguments out",
    ).toEqual([]);
    // A pass that found nothing would be a guard watching an empty room.
    expect(reasons.length, "no refusal reason was found to inspect").toBeGreaterThan(5);

    const unsafe: string[] = [];
    /** A reason may be built ONLY from text the reader wrote and from expressions the
     *  allowlist vouches for IN THIS FUNCTION — combined with `+`, a ternary, or a
     *  list that is filtered and joined. Anything else could hold the filename. */
    const checkReason = (node: ts.Expression, fn: string) => {
      const allowed = ALLOWED_IN[fn] ?? [];
      const text = node.getText(sf).trim();
      if (ts.isParenthesizedExpression(node)) return checkReason(node.expression, fn);
      if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
        return allowed.includes(text) ? undefined : checkReason(node.expression, fn);
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;
      if (node.kind === ts.SyntaxKind.NullKeyword) return; // dropped by the filter
      if (ts.isIdentifier(node) && node.text === "undefined") return;
      if (allowed.includes(text)) return; // vouched for, here
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          const inner = span.expression.getText(sf).trim();
          if (!allowed.includes(inner)) unsafe.push(`${fn}: ${inner}`);
        }
        return;
      }
      if (ts.isConditionalExpression(node)) {
        checkReason(node.whenTrue, fn); // the condition is not emitted
        checkReason(node.whenFalse, fn);
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        checkReason(node.left, fn);
        checkReason(node.right, fn);
        return;
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const el of node.elements) checkReason(el, fn);
        return;
      }
      // `[…].filter(Boolean).join("; ")` — only methods that cannot introduce a value
      // of their own, and only literal arguments.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["filter", "map", "flat", "join"].includes(node.expression.name.text) &&
        node.arguments.every(
          (a) => ts.isStringLiteral(a) || (ts.isIdentifier(a) && a.text === "Boolean"),
        )
      ) {
        checkReason(node.expression.expression, fn);
        return;
      }
      unsafe.push(`${fn}: ${text}`);
    };
    for (const { expr, fn } of reasons) checkReason(expr, fn);
    expect(
      unsafe,
      "a refusal reason is built from something the allowlist does not vouch for in " +
        "that function — an identifier, a property or a call could carry the user's " +
        "filename, so the shape is constrained before the content",
    ).toEqual([]);
  });

  test("the REAL staging path produces a class, not the catch-all", async () => {
    // Through `stageInboundReferences` itself, exactly as `/send` calls it — the
    // constructed-error tests above prove the mapping, this one proves the module
    // actually raises something the mapping can see. Without it, turning the
    // refusal back into a bare `Error` left every test green while production
    // went on reporting an unrecognised gateway error.
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-refusal-")));
    try {
      const published = join(root, "published");
      await mkdir(published, { mode: 0o700 });
      const thrown = await stageInboundReferences(
        [{ url: "u", mimeType: "application/pdf", fileName: "v.pdf" }],
        "cmid",
        {
          inboundDir: published,
          // The private staging dir may not be the published one — the refusal
          // this instance's misconfiguration would hit.
          stagingDir: published,
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown, "the staging did not refuse").toBeInstanceOf(Error);
      expect(classifyGatewayError(thrown, { hasAttachments: true })).toBe(
        "attachment_path_refused",
      );
      expect(
        faultDomain(classifyGatewayError(thrown, { hasAttachments: true })),
      ).toBe("local");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a local refusal does not RESURRECT an error that was decaying", () => {
    // `decayedState` projects a stale `error` down to `idle` after five minutes of
    // no attempt, so `lastAttemptAt` is the decay clock for the LINK. A local
    // refusal never touched the link: bumping that clock would let a user
    // re-sending an attachment hold the admin header red, the instance degraded
    // and the chat banner up for ever, on a link nothing had tested (codex P1).
    let now = 1_000_000;
    const reg = new HealthRegistry(1000, () => now);
    const ref = {
      key: "u",
      canonical: "u",
      agentId: "a",
      gatewayHost: "gw:1",
      instanceName: "i",
    };
    reg.recordError(ref, "GATEWAY_TIMEOUT");
    now += 6 * 60 * 1000; // past ERROR_DECAY_MS with no further attempt
    expect(reg.snapshot().targets[0]!.state).toBe("idle");
    reg.recordLocalRefusal(ref, "attachment_path_refused");
    expect(
      reg.snapshot().targets[0]!.state,
      "a local refusal restarted the connectivity decay clock",
    ).toBe("idle");
  });

  test("a REBIND forgets the previous agent's refusal", () => {
    // The per-agent reset clears the story when the canonical rebinds to another
    // agent. Left out of it, the new agent's row still showed the old one's
    // refusal and its count (codex) — the same attribution bug the reset exists
    // to prevent for errors and downstream rejects.
    const reg = new HealthRegistry(1000, () => 2000);
    const a = {
      key: "u",
      canonical: "u",
      agentId: "a",
      gatewayHost: "gw:1",
      instanceName: "i",
    };
    reg.recordLocalRefusal(a, "attachment_path_refused");
    reg.recordOk({ ...a, agentId: "b" });
    const t = reg.snapshot().targets[0]!;
    expect(t.agentId).toBe("b");
    expect(t.lastLocalRefusal, "carried over the other agent's refusal").toBeNull();
    expect(t.localRefusalCount).toBe(1 - 1 + 0);
  });

  test("a LONG FILE NAME is the reader's to fix, not the operator's", async () => {
    // The composed disk name (turn id + index + the user's name) must fit one
    // filesystem leaf. Wearing the path-contract class, this sent an operator to
    // inspect volumes that were perfectly fine, while the person who could fix it
    // in five seconds — by renaming — was told the shared space was broken
    // (codex). Driven through the REAL staging, with a healthy directory pair.
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-longname-")));
    try {
      const published = join(root, "published");
      const staging = join(root, ".staging");
      await mkdir(published, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const thrown = await stageInboundReferences(
        [
          {
            url: "u",
            mimeType: "application/pdf",
            fileName: `${"n".repeat(250)}.pdf`,
          },
        ],
        "7b3216bf-90ac-405f-826e-e72ab7de71e7",
        {
          inboundDir: published,
          stagingDir: staging,
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown, "a 250-byte name was staged").toBeInstanceOf(Error);
      expect(classifyGatewayError(thrown, { hasAttachments: true })).toBe(
        "attachment_name_too_long",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the class survives a REWORDING of the refusal", () => {
    // Recognised by TYPE, like `ContextBlockedError`: a decision we made may not
    // depend on how we phrased it. A plain Error carrying the same text is not
    // one of ours and keeps falling to the catch-all.
    class Reworded extends InboundMediaRefusal {
      constructor() {
        super(INBOUND_PATH_REFUSED);
        this.message = "staging refused: /var/media is outside the allowed root";
      }
    }
    expect(classifyGatewayError(new Reworded())).toBe("attachment_path_refused");
    expect(classifyGatewayError(new Error(INBOUND_PATH_REFUSED))).toBe(
      "UPSTREAM_ERROR",
    );
  });
});

describe("logInboundRefusal — the line the operator reads", () => {
  // The refusal carrying a reason proves nothing if nothing prints it. WHAT THIS
  // DOES NOT COVER, said plainly: it calls the function directly, so removing the
  // call from `/send` would leave it green. The source guard below is what pins
  // that the route still makes the call.
  test("a refused staging writes the clause to the bridge log", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atrium-log-")));
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });
    try {
      // Straight through the module the route calls, then the route's own branch:
      // booting the whole server for one log line would test the HTTP stack, not
      // this. What is pinned is that the branch exists and says the reason.
      const thrown = (await stageInboundReferences(
        [{ url: "u", mimeType: "application/pdf", fileName: "v.pdf" }],
        "cmid",
        {
          inboundDir: join(root, "published"),
          stagingDir: join(root, ".staging"),
          agentMount: "/m",
          maxBytes: 1024,
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array([1])]), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      ).then(
        () => null,
        (err: unknown) => err,
      )) as InboundMediaRefusal;
      logInboundRefusal(thrown);
      expect(
        errors.some((line) => line.includes("[inbound-media] refused because")),
        `nothing named the clause; logged: ${JSON.stringify(errors)}`,
      ).toBe(true);
      expect(errors.join(" ")).toContain("does not exist");
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failure that is NOT ours logs nothing extra", () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });
    try {
      logInboundRefusal(new Error("some gateway error"));
      // A refusal with no reason is also silent: an empty "refused because" line
      // would be worse than none.
      logInboundRefusal(new InboundMediaRefusal("inbound_media_stage_failed"));
      expect(errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the /send route still calls it", () => {
  // The tests above drive `logInboundRefusal` directly; only this says the route
  // uses it. Reading the source is a weaker instrument than exercising the route —
  // which would need a live gateway — and it is named as such rather than dressed up.
  test("the failure path passes the error to logInboundRefusal", () => {
    const src = readFileSync(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    expect(src).toMatch(/bridge \/send failed[\s\S]{0,300}logInboundRefusal\(err\)/);
  });
});
