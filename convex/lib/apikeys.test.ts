/// <reference types="vite/client" />
//
// Environment-labeled API keys: the minted key's namespace carries the
// deployment's ATRIUM_ENV_LABEL (oc_dev_…, oc_prod_…) — the SAME label the
// feedback report references use — so a pasted key identifies its environment
// unambiguously (the Convex deploy-key construction). Unlabeled deployments
// keep the legacy oc_live_ shape byte-for-byte.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { generateApiKey } from "./apikeys";
import { envLabel } from "./envLabel";

describe("generateApiKey (environment-labeled namespace)", () => {
  it("stamps the environment label into the namespace", () => {
    const k = generateApiKey("dev");
    expect(k.plaintext.startsWith("oc_dev_")).toBe(true);
    expect(k.prefix.startsWith("oc_dev_")).toBe(true);
    expect(k.prefix).toBe(k.plaintext.slice(0, "oc_dev_".length + 4));
    expect(k.plaintext.endsWith(k.lastFour)).toBe(true);
  });

  it("an UNLABELED deployment keeps the legacy oc_live_ shape", () => {
    for (const label of [null, undefined]) {
      const k = generateApiKey(label);
      expect(k.plaintext.startsWith("oc_live_")).toBe(true);
      expect(k.plaintext.length).toBe("oc_live_".length + 40);
    }
  });

  it("the secret body keeps its full entropy regardless of the label", () => {
    const k = generateApiKey("prod");
    expect(k.plaintext.length).toBe("oc_prod_".length + 40);
    // Base62 body only — the namespace is the single underscore-delimited head.
    expect(/^oc_prod_[A-Za-z0-9]{40}$/.test(k.plaintext)).toBe(true);
  });
});

describe("envLabel (shared with the feedback references)", () => {
  const saved = process.env.ATRIUM_ENV_LABEL;
  beforeEach(() => {
    delete process.env.ATRIUM_ENV_LABEL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ATRIUM_ENV_LABEL;
    else process.env.ATRIUM_ENV_LABEL = saved;
  });

  it("unset -> null (legacy shapes everywhere)", () => {
    expect(envLabel()).toBeNull();
  });
  it("normalizes to lowercase and accepts dots/underscores", () => {
    process.env.ATRIUM_ENV_LABEL = " Prod ";
    expect(envLabel()).toBe("prod");
    process.env.ATRIUM_ENV_LABEL = "eu.west_1";
    expect(envLabel()).toBe("eu.west_1");
  });
  it("rejects injection-shaped labels (never trusted into headers/keys)", () => {
    for (const bad of ["a b", "x-y!", "-lead", "trop_long_label_x17"]) {
      process.env.ATRIUM_ENV_LABEL = bad;
      expect(envLabel()).toBeNull();
    }
  });
});
