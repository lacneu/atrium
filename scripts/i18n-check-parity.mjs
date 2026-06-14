#!/usr/bin/env node
// CI gate #1 — locale key parity.
//
// Every locale catalog must define EXACTLY the same set of message keys. A key
// present in fr.json but missing from en.json (or vice-versa) means a string
// renders in the wrong language (or, with Paraglide, fails to compile). This
// runs in O(keys) and prints the precise diff so the fix is mechanical.
//
// Exit 0 = parity holds. Exit 1 = drift (with a per-locale missing-key report).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = resolve(here, "..", "messages");

// Keys that are metadata, not translatable messages.
const IGNORED = new Set(["$schema"]);

const LOCALES = ["fr", "en"]; // keep in sync with project.inlang/settings.json

/** @type {Record<string, Set<string>>} */
const keysByLocale = {};
for (const locale of LOCALES) {
  const path = resolve(messagesDir, `${locale}.json`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`✖ Could not read/parse ${path}: ${err.message}`);
    process.exit(1);
  }
  keysByLocale[locale] = new Set(
    Object.keys(parsed).filter((k) => !IGNORED.has(k)),
  );
}

// Reference = union of every key seen in any locale.
const allKeys = new Set();
for (const set of Object.values(keysByLocale)) {
  for (const k of set) allKeys.add(k);
}

let drift = false;
for (const locale of LOCALES) {
  const missing = [...allKeys].filter((k) => !keysByLocale[locale].has(k));
  if (missing.length) {
    drift = true;
    console.error(
      `✖ ${locale}.json is missing ${missing.length} key(s):\n` +
        missing.map((k) => `    - ${k}`).join("\n"),
    );
  }
}

if (drift) {
  console.error(
    "\n✖ i18n key parity FAILED. Add the missing keys (translated) to each catalog.",
  );
  process.exit(1);
}

console.log(
  `✔ i18n key parity OK — ${allKeys.size} key(s) across ${LOCALES.length} locale(s).`,
);
