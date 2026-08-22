/// <reference types="vite/client" />
//
// THE RATCHET.
//
// The drop lists are hand-maintained, and every test beside this one checks a
// field it already names — so none of them can fail when a NEW field arrives on
// `chats` or `messages`. A field nobody classified travels by default, and the
// ones that hurt are exactly the ones a future turn adds: session handles,
// dispatch state, gateway settings.
//
// So this test derives its expectation from the SCHEMA. Add a field, and it
// fails until someone says which side of the line it is on. That decision is the
// whole point; the list below is where it is recorded.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CHAT_FIELDS_DROPPED,
  MESSAGE_FIELDS_DROPPED,
} from "./lib/exportArchive";

/** Field names declared by one table, read from the schema source. */
function declaredFields(table: string): string[] {
  const source = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  const start = source.indexOf(`  ${table}: defineTable({`);
  if (start === -1) throw new Error(`table ${table} not found in schema`);
  const end = source.indexOf("\n  })", start);
  const body = source.slice(start, end);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const match = /^    ([a-zA-Z_][a-zA-Z0-9_]*): /.exec(line);
    if (match !== null) names.add(match[1]!);
  }
  return [...names];
}

/**
 * Fields an archive carries ON PURPOSE — the conversation itself, and what is
 * needed to read it back. Anything not here and not dropped is unclassified.
 */
const CHAT_FIELDS_KEPT: ReadonlyArray<string> = [
  "title",
  "instanceName",
  "agentId",
  "perTurnRouting",
  "kind",
  "archived",
  "updatedAt",
  "projectId",
  "forkedFromChatId",
  "color",
  "lastAssistantAt",
  "importedAt",
  "importedFromOrigin",
  "importedAgentLabel",
];

const MESSAGE_FIELDS_KEPT: ReadonlyArray<string> = [
  "chatId",
  "userId",
  "role",
  "announcePrefix",
  "mergedAnnounceRuns",
  "mergedIntoTurn",
  "routedInstanceName",
  "routedAgentId",
  "orderTime",
  "status",
  "finalizedAt",
  "interruptedAt",
  "text",
  "quotedMessageId",
  "quotedBlockIndex",
  "quotedExcerpt",
  "error",
  "errorCode",
  "attachedDocCount",
  "updatedAt",
  "importedAgentLabel",
];

describe("every field is classified, or the archive is not honest", () => {
  test("a new field on `chats` must be decided, not defaulted", () => {
    const unclassified = declaredFields("chats").filter(
      (field) =>
        !CHAT_FIELDS_DROPPED.includes(field) &&
        !CHAT_FIELDS_KEPT.includes(field),
    );

    expect(unclassified).toEqual([]);
  });

  test("a new field on `messages` must be decided, not defaulted", () => {
    const unclassified = declaredFields("messages").filter(
      (field) =>
        !MESSAGE_FIELDS_DROPPED.includes(field) &&
        !MESSAGE_FIELDS_KEPT.includes(field),
    );

    expect(unclassified).toEqual([]);
  });

  test("the ratchet reads the real schema, not an empty string", () => {
    // A parse that silently found nothing would make both tests above pass for
    // ever — the failure mode of every derived check.
    expect(declaredFields("chats")).toContain("recoverableSession");
    expect(declaredFields("messages")).toContain("turnSessionKey");
    expect(declaredFields("chats").length).toBeGreaterThan(20);
  });
});
