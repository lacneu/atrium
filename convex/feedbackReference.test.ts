/// <reference types="vite/client" />
//
// Environment-tagged feedback references: the reference shown to the reporter
// encodes the deployment (`dev-<id>`), and every reader strips any label back
// to the bare id — old bare ids and foreign labels included. Guessing the
// environment from traces cost three round-trips on 2026-07-05 alone.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { displayReference, parseReference } from "./feedback";

const ID = "ms79rj0edwe38f8j6ggxdjh50x89y11e";

describe("parseReference", () => {
  it("accepts a bare id (backward compatibility)", () => {
    expect(parseReference(ID)).toBe(ID);
  });
  it("strips a single-word label", () => {
    expect(parseReference(`dev-${ID}`)).toBe(ID);
    expect(parseReference(`prod-${ID}`)).toBe(ID);
  });
  it("strips a multi-segment label (labels may contain dashes when hand-typed)", () => {
    expect(parseReference(`atrium-dev-${ID}`)).toBe(ID);
  });
  it("tolerates surrounding whitespace from a copy-paste", () => {
    expect(parseReference(`  dev-${ID}  `)).toBe(ID);
  });
  it("returns null when nothing id-like is present", () => {
    expect(parseReference("dev-")).toBeNull();
    expect(parseReference("")).toBeNull();
  });
});

describe("displayReference", () => {
  const OLD = process.env.ATRIUM_ENV_LABEL;
  beforeEach(() => { delete process.env.ATRIUM_ENV_LABEL; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.ATRIUM_ENV_LABEL;
    else process.env.ATRIUM_ENV_LABEL = OLD;
  });
  it("unlabeled deployment -> the bare id (no behavior change)", () => {
    expect(displayReference(ID)).toBe(ID);
  });
  it("labeled deployment -> label-prefixed, and parseReference round-trips it", () => {
    process.env.ATRIUM_ENV_LABEL = "dev";
    expect(displayReference(ID)).toBe(`dev-${ID}`);
    expect(parseReference(displayReference(ID))).toBe(ID);
  });
  it("a malformed label is REFUSED (bare id), never injected into the reference", () => {
    process.env.ATRIUM_ENV_LABEL = "we ird\nlabel";
    expect(displayReference(ID)).toBe(ID);
  });
});
