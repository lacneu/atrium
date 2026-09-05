/**
 * WHO the attestation speaks for.
 *
 * `OPENCLAW_ATTACHMENT_FIX_ATTESTED` re-arms an instruction that poisons a session on
 * a stock 2026.8.x gateway. A process-wide boolean would let one patched image speak
 * for every other instance the same bridge serves, and would treat `0` / `false` as
 * "yes" (codex). It is a LIST OF INSTANCE NAMES, so both problems disappear: a value
 * that names no instance attests nothing.
 */
import { describe, expect, it } from "vitest";

import { instanceIsAttested, parseAttestedInstances } from "../src/config.js";

const attested = parseAttestedInstances;

describe("the attachment-fix attestation names instances, never a boolean", () => {
  it("unset or empty attests nothing", () => {
    expect(attested(undefined)).toEqual([]);
    expect(attested("")).toEqual([]);
    expect(attested("  ,  ")).toEqual([]);
  });
  it("a truthy-looking value that names no instance attests nothing", () => {
    // The trap the boolean form had: `0` and `false` are truthy strings in JS.
    for (const v of ["0", "false"]) {
      const list = attested(v);
      expect(list.includes("*"), `${v} must not mean every instance`).toBe(false);
      expect(list.includes("olivier"), `${v} must not name a real instance`).toBe(false);
    }
  });
  it("names the instances it lists, and `*` means all of them", () => {
    expect(attested("olivier, jerome")).toEqual(["olivier", "jerome"]);
    expect(attested("*")).toEqual(["*"]);
  });
  it("attests ONE instance without speaking for the one beside it", () => {
    const list = attested("olivier");
    expect(instanceIsAttested(list, "olivier")).toBe(true);
    expect(instanceIsAttested(list, "jerome")).toBe(false);
    expect(instanceIsAttested(attested("*"), "jerome")).toBe(true);
    for (const v of ["0", "false", "NO", "Off", "none", "disabled"]) {
      expect(instanceIsAttested(attested(v), "olivier")).toBe(false);
      // …and not even for an instance UNFORTUNATE enough to bear that name: the
      // operator meant "off", and a name cannot turn that into consent (codex).
      expect(instanceIsAttested(attested(v), v)).toBe(false);
    }
  });
});
