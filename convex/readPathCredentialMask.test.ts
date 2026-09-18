/// <reference types="vite/client" />
//
// The EIGHT read paths that serve a stored failure sentence.
//
// Every door that persists one masks it, and a one-time backfill clears the rows
// written before that existed. But the backfill is OPERATOR-INVOKED, like the other
// migration in this repository, so a read can always precede it — and until it has run,
// these eight queries hand the credential id to the browser. The view masks what it
// DISPLAYS; the value had already crossed the query (codex).
//
// Source guards, because each of these is a projection inside a larger authorized
// query: driving them end to end would prove the authorization, not the field.

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const strip = (f: string) =>
  readFileSync(new URL(f, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

describe("no read path serves a credential id", () => {
  test("the chat query masks the message error", () => {
    expect(strip("./messages.ts")).toMatch(/error: maskCredentialId\(message\.error\),/);
  });

  test("the sub-agent listing and the interaction listing mask theirs", () => {
    expect(strip("./subAgents.ts")).toMatch(
      /rows\.map\(\(r\) => \(\{ \.\.\.r, errorMessage: maskCredentialId\(r\.errorMessage\) \}\)\)/,
    );
    expect(strip("./subAgentInteractions.ts")).toMatch(
      /\.map\(\(r\) => \(\{ \.\.\.r, errorMessage: maskCredentialId\(r\.errorMessage\) \}\)\)/,
    );
  });

  test("BOTH feedback reads mask the frozen snapshot", () => {
    // The owner-facing read and the external support API are separate projections of
    // the same row, and only one of them being masked leaves the other serving it.
    const src = strip("./feedback.ts");
    const hits = src.match(/messageError: maskCredentialId\(fb\.snapshot\.messageError\)/g);
    expect(hits?.length, "one of the two feedback reads is unmasked").toBe(2);
  });

  test("the two DEV probes mask before they truncate", () => {
    // Public queries once dev mode is on, and 140 characters is far more than enough
    // to carry `Auth profile "<id>"` — so the sentence could leave the deployment
    // before the backfill had run (codex). The guard above said it covered every path
    // while these two were open.
    const src = strip("./dev.ts");
    expect(src).toMatch(/error: m\.error \? maskCredentialId\(m\.error\)\.slice\(0, 140\)/);
    expect(src).toMatch(
      /lastError: m\.error \? maskCredentialId\(m\.error\)\.slice\(0, 100\)/,
    );
  });

  test("the sub-agent report read masks every captured child", () => {
    expect(strip("./subAgentReports.ts")).toMatch(
      /children: r\.snapshot\.children\.map\(\(c\) => \(\{[\s\S]{0,120}?errorMessage: maskCredentialId\(c\.errorMessage\),/,
    );
  });
});
