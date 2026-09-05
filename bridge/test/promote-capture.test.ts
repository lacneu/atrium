/**
 * The promoter's two load-bearing properties (W11/G4).
 *
 * 1. NOTHING that came off the wire as content survives promotion. The fixtures land in
 *    an open-source repo, so this is the boundary, not a nicety. The test is adversarial
 *    in the same shape as the drift detector's (`protocol-drift.test.ts`): one marker
 *    injected into EVERY position a frame has — key, value, nested value, array element,
 *    tool argument, tool result, error message, file path, session key, run id — and not
 *    one byte of it may appear in the output.
 *
 * 2. What the normalizer BRANCHES on survives exactly. An anonymiser that masked
 *    everything would pass (1) and leave a corpus that tests the anonymiser instead of
 *    the wire, so the discriminants, the separators of the key/run grammars, the
 *    identifier RELATIONSHIPS, and the prefix/concatenation structure of streamed text
 *    are each asserted here.
 */

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  anonymizeFrame,
  createPseudonymiser,
  knownKeysFromCoverage,
  maskKeepingMediaSentinel,
  maskText,
  // @ts-expect-error — plain .mjs helper, no types (it runs under node, not tsc)
} from "../scripts/lib/anonymize-capture.mjs";
import {
  classifyToolNames,
  harvestToolNames,
  promoteSlice,
  // @ts-expect-error — plain .mjs script, no types (it runs under node, not tsc)
} from "../scripts/promote-capture.mjs";

// The SAME vocabulary the promoter derives — from the vendored coverage manifest, so this
// suite cannot pass against a hand-written key list the promoter does not use.
const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(HERE, rel), "utf8"));
const KNOWN_KEYS = knownKeysFromCoverage(
  readJson("../protocol/openclaw/coverage/2026.7.1.json"),
  // BOTH vendored artifacts, exactly as the promoter does it: the coverage manifest and
  // the derived session snapshot. Building the vocabulary from the manifest alone masked
  // twelve real protocol fields the gateway flattens onto agent events.
  (readJson("../protocol/openclaw/2026.7.1/session-event-snapshot.json") as {
    fields: string[];
  }).fields,
);

const MARKER = "Zorglub";

function newStats() {
  return { frames: 0, verbatim: 0, pseudonymised: 0, masked: 0, maskedKeys: 0, unparsable: 0 };
}

// The harvested tool names feed BOTH the pseudonymiser (so a delivery run id stays
// readable) and the anonymiser (so a tool card keeps its name) — one set, as in the
// promoter.
function anonymize(frame: unknown, toolNames: string[] = []): unknown {
  return anonymizeFrame(
    frame,
    createPseudonymiser(toolNames),
    newStats(),
    KNOWN_KEYS,
    new Set(toolNames),
  );
}

describe("capture anonymiser — nothing content-bearing survives", () => {

  it("keeps the 2026.8.1+ delivery LANE inside a task run id (found by the fidelity gate, 2026-09-04)", () => {
    // 2026.8.1 appends the delivery lane (`…:ok:agent-loop`, upstream
    // subagent-announce-delivery.ts:219,230). The rule stopped at ok|error, so the
    // whole run id fell through to `opaque()`: the promoted capture lost the
    // delivery family and read DIFFERENTLY from the raw one, which is exactly what
    // the fidelity gate refused. Only the documented lane is kept.
    const p = createPseudonymiser(["image_generate"]);
    expect(
      p.identifier("image_generate:3ad339f9-e04a-4ee8-8b3b-641c6479d32f:ok:agent-loop"),
    ).toMatch(/^image_generate:[0-9a-f-]{36}:ok:agent-loop$/);
    expect(
      p.identifier("image_generate:3ad339f9-e04a-4ee8-8b3b-641c6479d32f:ok"),
    ).toMatch(/^image_generate:[0-9a-f-]{36}:ok$/);
    expect(
      p.identifier("image_generate:3ad339f9-e04a-4ee8-8b3b-641c6479d32f:ok:other-lane"),
    ).not.toMatch(/^image_generate:/);
  });

  it("a marker in EVERY position is gone from the output", () => {
    const frame = {
      type: "event",
      event: "agent",
      payload: {
        runId: `webchat-${MARKER}deadbeef`,
        sessionKey: `agent:${MARKER}:atrium:chat:${MARKER}-user:${MARKER}chat`,
        spawnedBy: `agent:${MARKER}:atrium:chat:${MARKER}-user:${MARKER}chat`,
        stream: "tool",
        seq: 7,
        [`${MARKER}Key`]: `${MARKER} in a foreign field`,
        data: {
          name: "shell",
          phase: "result",
          toolCallId: `call_${MARKER}`,
          args: { command: `echo ${MARKER}`, files: [`/home/${MARKER}/secret.txt`] },
          result: {
            content: [{ type: "text", text: `the answer mentions ${MARKER} twice: ${MARKER}` }],
          },
          errorMessage: `failed on ${MARKER}`,
        },
        message: {
          content: [{ type: "text", text: `Bonjour ${MARKER}, voici la reponse.` }],
        },
      },
    };
    const out = JSON.stringify(anonymize(frame));
    expect(out).not.toContain(MARKER);
    expect(out.toLowerCase()).not.toContain(MARKER.toLowerCase());
  });

  it("an UNCLASSIFIED key is masked, never passed through", () => {
    // The allowlist is the whole design: a key nobody thought about must fail CLOSED.
    // A denylist would have let `payload.somethingNew` through the day upstream adds it.
    const out = anonymize({
      payload: { somethingNobodyClassified: `${MARKER} content`, nested: { deep: MARKER } },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(MARKER);
    // The KEY is masked too: an unknown key is exactly the one that might BE data (a map
    // keyed by an address or a name), and no code branches on it, so nothing is lost.
    expect(json).not.toContain("somethingNobodyClassified");
    expect(json, "the key survives only as its shape").toContain(maskText("somethingNobodyClassified"));
  });

  it("a NUMBER under an unclassified key does not survive", () => {
    // The header used to claim numbers are never content. That holds for `seq`, `ts` and
    // counts — fields somebody classified — and not at all for a free-form tool result,
    // where a number is whatever the payload put there: an age, an amount, an account.
    // They were passing through untouched into a public corpus (raised in review).
    const out = anonymize({
      payload: { data: { result: { patientAge: 42, phone: 33612345678 }, seq: 7 } },
    }) as { payload: { data: { result: Record<string, number>; seq: number } } };
    expect(JSON.stringify(out)).not.toContain("42");
    expect(JSON.stringify(out)).not.toContain("33612345678");
    expect(out.payload.data.seq, "a classified count still passes").toBe(7);
  });

  it("a BOOLEAN or a globally-known key inside a free-form blob does not survive", () => {
    // The deeper half of the same defect: masking the unknown KEY did not stop the value,
    // and a key that is protocol SOMEWHERE (`id`) licensed a raw number ANYWHERE. A tool
    // result is free-form by definition — the manifest cannot vouch for what is in it.
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "lookup",
          phase: "result",
          result: { hasCancer: true, id: 12345, details: { async: true, taskId: "t-9" } },
        },
      },
    }, ["lookup"]) as {
      payload: {
        data: { result: Record<string, unknown> & { details: { async: boolean; taskId: string } } };
      };
    };
    const r = out.payload.data.result;
    // The unknown key is masked, so it is read by its SHAPE — and its value is gone.
    expect(r[maskText("hasCancer")], "a free-form boolean keeps its type, not its value").
      toBe(false);
    // `id` IS vocabulary in here — the cron card is built from it — and that changes
    // nothing about the value: a known key never licenses the number under it.
    expect(r.id, "a known key licenses no value").toBe(0);
    // …while the two scalars the reading stack actually consumes still work, or the
    // background-task ack dies with them.
    expect(r.details.async).toBe(true);
    expect(typeof r.details.taskId).toBe("string");
  });

  it("a content `name` that HAPPENS to equal a tool name is still masked", () => {
    // Matching by value published a real name the moment a user-facing `name` collided
    // with a tool that ran in the same capture (raised in review). Position decides:
    // only the `data` of a `stream:"tool"` event names a tool.
    const out = anonymize(
      {
        payload: {
          stream: "lifecycle",
          childSessions: [{ name: "exec" }],
          data: { name: "exec" },
        },
      },
      ["exec"],
    ) as { payload: { childSessions: { name: string }[]; data: { name: string } } };
    expect(out.payload.childSessions[0]!.name).not.toBe("exec");
    expect(out.payload.data.name, "not a tool event, so not a tool name").not.toBe("exec");
    // …and inside a real tool event it IS kept, or the corpus loses the tool cards.
    const tool = anonymize(
      { payload: { stream: "tool", data: { name: "exec", phase: "start" } } },
      ["exec"],
    ) as { payload: { data: { name: string } } };
    expect(tool.payload.data.name).toBe("exec");
  });

  it("the mask keeps LENGTH and character classes, and nothing else", () => {
    expect(maskText("Bonjour Alice, 42 messages!")).toBe("Xxxxxxx Xxxxx, 00 xxxxxxxx!");
    expect(maskText("café ☕")).toHaveLength("café ☕".length);
  });
});

describe("capture anonymiser — what the reader branches on survives", () => {
  it("discriminants are kept VERBATIM", () => {
    const out = anonymize({
      type: "event",
      event: "chat",
      payload: { state: "delta", stream: "assistant", stopReason: "end_turn", seq: 3 },
    }) as { type: string; event: string; payload: Record<string, unknown> };
    expect(out.type).toBe("event");
    expect(out.event).toBe("chat");
    expect(out.payload.state).toBe("delta");
    expect(out.payload.stream).toBe("assistant");
    expect(out.payload.stopReason).toBe("end_turn");
    expect(out.payload.seq, "numbers pass through").toBe(3);
  });

  it("the session-key GRAMMAR survives (separators and protocol tokens)", () => {
    const key = anonymize({
      payload: { sessionKey: "agent:alice:atrium:chat:u-repro:turn-abc123" },
    }) as { payload: { sessionKey: string } };
    const parts = key.payload.sessionKey.split(":");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("agent");
    expect(parts[2]).toBe("atrium");
    expect(parts[3]).toBe("chat");
    expect(parts[1]).not.toBe("alice");
  });

  it("the run FAMILIES survive (announce / task delivery / inject)", () => {
    // `image_generate` is vocabulary because the capture itself declares it as a tool
    // name — harvested, not hard-coded, exactly as the promoter does it.
    const out = anonymize(
      {
        payload: {
          runId: "announce:97af12",
          parentSessionKey: "image_generate:1c983f76-2eec-4381-a78b-5946010ed323:ok",
          id: "inject-mid42",
        },
      },
      ["image_generate"],
    ) as { payload: { runId: string; parentSessionKey: string; id: string } };
    expect(out.payload.runId.startsWith("announce:")).toBe(true);
    expect(out.payload.parentSessionKey.startsWith("image_generate:")).toBe(true);
    expect(out.payload.parentSessionKey.endsWith(":ok")).toBe(true);
    expect(out.payload.id.startsWith("inject-")).toBe(true);
  });

  it("identifier RELATIONSHIPS survive (the isolation gate still matches)", () => {
    // The normalizer admits a child frame when `spawnedBy === sessionKey`. Pseudonymising
    // the two independently would silently turn every sub-agent capture into a dropped
    // frame — a corpus that replays green while testing nothing.
    const pseudo = createPseudonymiser();
    const parent = "agent:alice:atrium:chat:u-repro:turn-abc";
    const a = anonymizeFrame(
      { payload: { sessionKey: parent } },
      pseudo,
      newStats(),
      KNOWN_KEYS,
    ) as { payload: { sessionKey: string } };
    const b = anonymizeFrame(
      { payload: { spawnedBy: parent, sessionKey: "agent:files:subagent:uuid-1" } },
      pseudo,
      newStats(),
      KNOWN_KEYS,
    ) as { payload: { spawnedBy: string; sessionKey: string } };
    expect(b.payload.spawnedBy, "the gate compares these two").toBe(a.payload.sessionKey);
    expect(b.payload.sessionKey).not.toBe(a.payload.sessionKey);
    // A child runs under its OWN agent (live: parent `agent:alice:…`, child
    // `agent:files:subagent:…`), so the agent token differs — what must survive is the
    // `subagent` marker and the fact that the two keys are still different keys.
    expect(b.payload.sessionKey.split(":")[2]).toBe("subagent");
  });

  it("streamed text keeps its PREFIX structure (the snapshot/replace path)", () => {
    // `mask` is applied per character, so it distributes over concatenation. Without that
    // property a promoted delta would no longer be a prefix of its snapshot, and the
    // replace path — which is exactly what a golden corpus is for — would never be taken.
    const head = "Bonjour, voici";
    const tail = " la reponse complete.";
    expect(maskText(head + tail)).toBe(maskText(head) + maskText(tail));
    expect(maskText(head + tail).startsWith(maskText(head))).toBe(true);
  });
});

describe("tool-name harvesting cannot be poisoned by the capture", () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("only a TOOL frame's own name becomes vocabulary", () => {
    // The first version walked the frame for any `name` key and harvested the AGENT names
    // out of the session snapshot (`Alice`, `Bob`, `Fichiers`). They then counted as
    // protocol tokens, and `alice` survived verbatim inside every session key of three
    // fixtures. An allowlist the payload can write to is not an allowlist.
    const slice = [
      line({
        receivedAt: 1,
        frame: { event: "agent", payload: { stream: "tool", data: { name: "exec" } } },
      }),
      line({
        receivedAt: 2,
        frame: {
          event: "agent",
          payload: {
            stream: "lifecycle",
            childSessions: [{ name: "Alice" }, { name: "Bob" }],
          },
        },
      }),
    ].join("\n");
    expect(harvestToolNames(slice)).toEqual(["exec"]);
  });

  it("an identity position resists even a POISONED vocabulary", () => {
    // This started as proof that the narrowing mattered: with `alice` in the vocabulary,
    // the old token-matching pseudonymiser published it. Reading identifiers by GRAMMAR
    // removed the whole class — the second segment of a session key is identity whatever
    // the vocabulary says, so the harvest can no longer poison it at all.
    const key = "agent:alice:atrium:chat:u-x:turn-y";
    const poisoned = anonymizeFrame(
      { payload: { sessionKey: key } },
      createPseudonymiser(["alice"]),
      newStats(),
      KNOWN_KEYS,
    ) as { payload: { sessionKey: string } };
    expect(poisoned.payload.sessionKey).not.toContain("alice");
    expect(poisoned.payload.sessionKey).toContain(":atrium:chat:");
  });
});

describe("promoteSlice", () => {
  const line = (o: unknown) => JSON.stringify(o);

  const KEY = "agent:a:atrium:chat:u:c";
  const ACK = line({ receivedAt: 5, frame: { type: "res", payload: { runId: "webchat-r1" } } });
  const TURN = (extra: Record<string, unknown>) =>
    line({
      receivedAt: 10,
      frame: { event: "chat", payload: { sessionKey: KEY, runId: "webchat-r1", ...extra } },
    });

  it("is DETERMINISTIC — the same capture promotes to the same bytes", () => {
    const slice = [ACK, TURN({ state: "delta", deltaText: "hello" }), TURN({ state: "final" })].join("\n");
    expect(promoteSlice(slice).lines).toEqual(promoteSlice(slice).lines);
  });

  it("keeps arrival INTERVALS, rebased, and marks their absence as null", () => {
    // Offsets, not dates: an absolute timestamp says when a real conversation happened,
    // and the replay only ever needs the intervals between frames.
    const enveloped = promoteSlice([ACK, TURN({ state: "final" })].join("\n"));
    expect(JSON.parse(enveloped.lines[0]!).receivedAt, "the origin is zero").toBe(0);
    expect(JSON.parse(enveloped.lines[1]!).receivedAt, "10ms after the ack, at 5").toBe(5);
    // A pre-envelope capture: null, never a fabricated zero — a replay must be able to
    // tell "no arrival time recorded" from "arrived at t=0".
    const bare = promoteSlice(
      [
        line({ type: "res", payload: { runId: "webchat-r1" } }),
        line({ event: "chat", payload: { sessionKey: KEY, runId: "webchat-r1", state: "final" } }),
      ].join("\n"),
    );
    expect(JSON.parse(bare.lines[0]!).receivedAt).toBeNull();
  });

  it("counts unparsable lines instead of dropping them silently", () => {
    const slice = `${ACK}\n${TURN({ state: "final" })}\n{ not json\n`;
    const { stats, lines } = promoteSlice(slice);
    expect(lines).toHaveLength(2);
    expect(stats.unparsable).toBe(1);
  });
});

describe("free-form strings: only the reader's control values survive", () => {
  it("a protocol-NAMED key does not license a free-text value", () => {
    // `result: { status: "Alice's diagnosis" }` was published verbatim because `status`
    // is vocabulary somewhere. Inside a blob the protocol cannot vouch for a key.
    const out = anonymize({
      payload: {
        stream: "tool",
        data: { name: "lookup", phase: "result", result: { status: "Alice's diagnosis" } },
      },
    }, ["lookup"]) as { payload: { data: { result: { status: string } } } };
    expect(out.payload.data.result.status).not.toContain("Alice");
  });

  it("…while the exact control values the reader compares against DO survive", () => {
    // `messageToolText` branches on these; masking them made the replay read an in-chat
    // send as an external message and skip the visible-reply path entirely.
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "message",
          phase: "start",
          args: { action: "send", channel: "webchat", body: "le texte de la reponse" },
        },
      },
    }, ["message"]) as {
      payload: { data: { args: { action: string; channel: string; body: string } } };
    };
    expect(out.payload.data.args.action).toBe("send");
    expect(out.payload.data.args.channel).toBe("webchat");
    expect(out.payload.data.args.body, "the message itself is still masked").
      not.toContain("reponse");
  });

  it("the MEDIA: directive keeps its prefix and loses its file name", () => {
    // The normalizer matches `^MEDIA:/home/node/.openclaw/media/outbound/…` verbatim.
    // Masking the line removed the tool-result media path from the corpus outright.
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "exec",
          phase: "result",
          result: { content: [{ type: "text", text: "MEDIA:/home/node/.openclaw/media/outbound/rapport-final.pdf" }] },
        },
      },
    }, ["exec"]) as {
      payload: { data: { result: { content: { text: string }[] } } };
    };
    const text = out.payload.data.result.content[0]!.text;
    expect(text.startsWith("MEDIA:/home/node/.openclaw/media/outbound/")).toBe(true);
    expect(text).not.toContain("rapport-final");
  });
});

describe("the media sentinel is spliced, not spared", () => {
  it("a long free text that MENTIONS a media path is still masked around it", () => {
    // The first version replaced the directive and returned the rest of the string
    // untouched, so a whole task description survived because it happened to contain a
    // media path. Mask first, splice the directive back — the mask is length-preserving,
    // so the offsets line up exactly.
    const text =
      "OBJECTIF secret: livrer le rapport via MEDIA:/home/node/.openclaw/media/outbound/rapport.pdf puis conclure";
    const out = anonymize({
      payload: {
        stream: "tool",
        data: { name: "exec", phase: "result", result: { content: [{ type: "text", text }] } },
      },
    }, ["exec"]) as { payload: { data: { result: { content: { text: string }[] } } } };
    const masked = out.payload.data.result.content[0]!.text;
    expect(masked).toContain("MEDIA:/home/node/.openclaw/media/outbound/");
    expect(masked).not.toContain("OBJECTIF");
    expect(masked).not.toContain("rapport");
    expect(masked, "length preserved, so the splice offsets hold").toHaveLength(text.length);
  });
});

describe("pre-envelope captures are rebased too", () => {
  it("derives an origin from the FRAMES when there is no arrival time", () => {
    // A bare capture carries no `receivedAt`, so the origin was null and nothing was
    // rebased — absolute gateway timestamps went straight into the corpus for exactly the
    // captures the promoter says it still accepts.
    const bare = [
      JSON.stringify({ type: "res", payload: { runId: "webchat-r1" } }),
      JSON.stringify({
        event: "chat",
        payload: {
          sessionKey: "agent:a:atrium:chat:u:c",
          runId: "webchat-r1",
          state: "final",
          ts: 1_785_204_000_000,
          startedAt: 1_785_203_990_000,
        },
      }),
    ].join("\n");
    // With the real vocabulary, as the promoter runs it — `ts` is a manifest field.
    const { lines } = promoteSlice(bare, KNOWN_KEYS);
    const payload = JSON.parse(lines[1]!).frame.payload as {
      ts: number;
      startedAt: number;
    };
    expect(Math.abs(payload.ts), "no absolute date survives").toBeLessThan(1_000_000_000_000);
    expect(payload.ts - payload.startedAt, "the interval is exact").toBe(10_000);
  });
});

describe("serialised free-form containers", () => {
  it("args sent as a JSON STRING stay readable to the reader", () => {
    // `messageToolText` accepts that shape and parses it. A character mask turned it into
    // an unparsable blob, so the corpus could not cover a supported form of the
    // message-tool path at all.
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "message",
          phase: "start",
          args: JSON.stringify({ action: "send", channel: "webchat", body: "texte secret" }),
        },
      },
    }, ["message"]) as { payload: { data: { args: string } } };
    const args = JSON.parse(out.payload.data.args) as Record<string, string>;
    expect(args.action).toBe("send");
    expect(args.channel).toBe("webchat");
    expect(args.body, "the message itself is still masked").not.toContain("secret");
  });

  it("a string that merely LOOKS numeric is not treated as structure", () => {
    // Only an object or an array is parsed: a bare number or a quoted word also parses as
    // JSON, and treating those as structure would lift content straight out of the mask.
    const out = anonymize({
      payload: { stream: "tool", data: { name: "x", phase: "result", result: "42 rue de la Paix" } },
    }, ["x"]) as { payload: { data: { result: string } } };
    expect(out.payload.data.result).not.toContain("Paix");
  });
});

describe("structuredContent is free-form like any tool-result envelope", () => {
  it("a globally-known sub-key does not keep its text", () => {
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "lookup",
          phase: "result",
          structuredContent: { status: "Alice a un diagnostic", model: "dossier-patient-42" },
        },
      },
    }, ["lookup"]) as {
      payload: { data: { structuredContent: { status: string; model: string } } };
    };
    const sc = out.payload.data.structuredContent;
    expect(JSON.stringify(sc)).not.toContain("Alice");
    expect(JSON.stringify(sc)).not.toContain("dossier");
  });
});

describe("tool names: built-ins are published, custom ones are renamed", () => {
  const custom = "acme_patient_lookup";

  it("a CUSTOM tool name never reaches the corpus, on the card or in the run id", () => {
    // A shape regexp validates the form, not the safety: a plugin tool can be named after
    // a client, a project or a patient. Built-ins are gateway registry entries and stay
    // readable — reading `tool:exec` in a snapshot is most of what makes a red one
    // diagnosable — everything else gets a stable, grammar-compatible pseudonym.
    const { verbatim, renamed } = classifyToolNames(["exec", custom]);
    const pseudo = createPseudonymiser(verbatim, renamed);
    const card = anonymizeFrame(
      { payload: { stream: "tool", data: { name: custom, phase: "result" } } },
      pseudo,
      newStats(),
      KNOWN_KEYS,
      verbatim,
      null,
      renamed,
    ) as { payload: { data: { name: string } } };
    const run = pseudo.identifier(`${custom}:1c983f76-2eec-4381-a78b-5946010ed323:ok`);
    expect(card.payload.data.name).not.toContain("acme");
    expect(run).not.toContain("acme");
    expect(
      run.startsWith(`${card.payload.data.name}:`),
      "the card and the delivery run still name the same tool",
    ).toBe(true);
    // …and the pseudonym still parses as a delivery family.
    expect(run).toMatch(
      /^[a-z][a-z0-9_]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:ok$/,
    );
  });

  it("a BUILT-IN keeps its name", () => {
    const { verbatim, renamed } = classifyToolNames(["exec"]);
    const out = anonymizeFrame(
      { payload: { stream: "tool", data: { name: "exec", phase: "start" } } },
      createPseudonymiser(verbatim, renamed),
      newStats(),
      KNOWN_KEYS,
      verbatim,
      null,
      renamed,
    ) as { payload: { data: { name: string } } };
    expect(out.payload.data.name).toBe("exec");
  });
});

describe("outbound media survives in every shape the reader accepts", () => {
  it("a BARE outbound path in free text keeps its root", () => {
    // `isOutboundMediaPath` gates on that exact prefix; masking it left the corpus blind
    // to a delivery form the normalizer supports.
    const masked = maskKeepingMediaSentinel(
      "Le fichier secret est /home/node/.openclaw/media/outbound/rapport.pdf voila",
    );
    expect(masked).toContain("/home/node/.openclaw/media/outbound/");
    expect(masked).not.toContain("rapport");
    expect(masked).not.toContain("secret");
  });

  it("mediaUrls inside a tool RESULT keeps its root and loses the file name", () => {
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "exec",
          phase: "result",
          result: { mediaUrls: ["/home/node/.openclaw/media/outbound/img-secret.png"] },
        },
      },
    }, ["exec"]) as { payload: { data: { result: { mediaUrls: string[] } } } };
    const url = out.payload.data.result.mediaUrls[0]!;
    expect(url.startsWith("/home/node/.openclaw/media/outbound/")).toBe(true);
    expect(url).not.toContain("secret");
  });
});

describe("astral characters do not shift the splice", () => {
  it("the mask preserves UTF-16 length, so a prefix after an emoji survives", () => {
    // Iterating code points emitted ONE mask char for a two-unit astral character, so the
    // masked string was shorter than the source and every later splice landed off by one.
    const s = "😀 voir /home/node/.openclaw/media/outbound/rapport.pdf";
    expect(maskText(s)).toHaveLength(s.length);
    const out = maskKeepingMediaSentinel(s);
    expect(out).toContain("/home/node/.openclaw/media/outbound/");
    expect(out).not.toContain("rapport");
  });
});

describe("a pseudonym is recognisable as one", () => {
  it("a UUID pseudonym is NOT derivable from the original", () => {
    // Deriving it was a presence oracle: a third party holding a candidate id computes
    // its pseudonym and searches the corpus. Two capture-local mints of the SAME id give
    // the same value within a capture and carry no relation to it.
    const a = createPseudonymiser().identifier("1c983f76-2eec-4381-a78b-5946010ed323");
    const b = createPseudonymiser().identifier("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(a, "the first UUID of each capture gets the same pseudonym").toBe(b);
    const p = createPseudonymiser();
    expect(p.identifier("1c983f76-2eec-4381-a78b-5946010ed323")).toBe(
      p.identifier("1c983f76-2eec-4381-a78b-5946010ed323"),
    );
  });

  it("a UUID pseudonym keeps the grammar and announces itself", () => {
    // A review of this corpus reported the pseudonyms as raw identifiers — they were not,
    // but nothing distinguished them by eye. The reserved first group removes the doubt
    // permanently without touching the `8-4-4-4-12` grammar the readers key on.
    const pseudo = createPseudonymiser();
    const out = pseudo.identifier("1c983f76-2eec-4381-a78b-5946010ed323");
    expect(out).toMatch(
      /^00000000-0000-4000-8000-[0-9a-f]{12}$/,
    );
    expect(out).not.toBe("1c983f76-2eec-4381-a78b-5946010ed323");
  });

  it("the CORPUS carries no identifier from its source capture", () => {
    // The property the review was actually asking about, asserted rather than eyeballed.
    const raw = "1c983f76-2eec-4381-a78b-5946010ed323";
    const pseudo = createPseudonymiser();
    expect(pseudo.identifier(`image_generate:${raw}:ok`)).not.toContain(raw);
  });
});

describe("identifier grammars, not a token allowlist", () => {
  it("a protocol-ISH word in an identity position is still pseudonymised", () => {
    // `main` is both a protocol-sounding word and a real agent id. A position-blind token
    // list published it verbatim inside `agent:main:atrium:chat:…` (raised in review).
    const out = createPseudonymiser().identifier("agent:main:atrium:chat:u-x:turn-y");
    expect(out).not.toContain("main");
    expect(out.startsWith("agent:")).toBe(true);
    expect(out).toContain(":atrium:chat:");
  });

  it("a path root is kept as a WHOLE prefix, never as loose tokens", () => {
    const p = createPseudonymiser();
    const media = p.identifier("/home/node/.openclaw/media/outbound/x.png");
    expect(media.startsWith("/home/node/.openclaw/media/outbound/")).toBe(true);
    // …and the same words elsewhere are identity, not infrastructure.
    expect(p.identifier("agent:node:atrium:chat:home:outbound")).not.toContain("node");
  });

  it("a custom tool with a dash or a dot is renamed CONSISTENTLY", () => {
    // The token split ran before the rename lookup, so the card said `tool_1` while the
    // delivery run said `id1-id2:…` — and the dotted form did not even parse as a
    // delivery family any more (raised in review).
    const renamed = new Map([
      ["acme-patient", "tool_1"],
      ["acme.patient", "tool_2"],
    ]);
    const p = createPseudonymiser([], renamed);
    const uuid = "1c983f76-2eec-4381-a78b-5946010ed323";
    for (const [name, alias] of renamed) {
      const run = p.identifier(`${name}:${uuid}:ok`);
      expect(run).not.toContain("acme");
      expect(run.startsWith(`${alias}:`)).toBe(true);
      expect(run).toMatch(
        /^[a-z][a-z0-9_]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:ok$/,
      );
    }
  });
});

describe("tool aliases are case-sensitive", () => {
  it("two tools differing only in case keep DISTINCT aliases everywhere", () => {
    // Lower-casing the lookup collapsed `Acme` and `acme` onto one alias: the cards stayed
    // distinct while both run ids took the second, so a delivery could be attributed to
    // the wrong tool. A tool name is an identifier; case is part of it.
    const renamed = new Map([
      ["Acme", "tool_1"],
      ["acme", "tool_2"],
    ]);
    const p = createPseudonymiser([], renamed);
    const uuid = "1c983f76-2eec-4381-a78b-5946010ed323";
    expect(p.identifier(`Acme:${uuid}:ok`).startsWith("tool_1:")).toBe(true);
    expect(p.identifier(`acme:${uuid}:ok`).startsWith("tool_2:")).toBe(true);
  });
});

describe("media delivered in the VISIBLE text", () => {
  it("a MEDIA: directive inside a chat message keeps its prefix", () => {
    // `collectMedia` reads that exact prefix from the visible text, so a media delivered
    // only there is a supported form. Streamed text is otherwise a pure character mask —
    // the prefix relation the snapshot/replace path rides on — and the fidelity gate is
    // what arbitrates the two properties per capture.
    const out = anonymize({
      payload: {
        state: "final",
        message: {
          content: [
            {
              type: "text",
              text: "Voici le fichier\nMEDIA:/home/node/.openclaw/media/outbound/rapport.pdf",
            },
          ],
        },
      },
    }) as { payload: { message: { content: { text: string }[] } } };
    const text = out.payload.message.content[0]!.text;
    expect(text).toContain("MEDIA:/home/node/.openclaw/media/outbound/");
    expect(text).not.toContain("rapport");
    expect(text).not.toContain("Voici");
  });
});

describe("a scalar under a reader key is still a value", () => {
  it("only the two flags the reader tests survive as booleans", () => {
    // `readerKeys` says a KEY is known; it says nothing about the value. Allowing any
    // scalar under one published `{"status": 123456789}` and `{"taskId": 12345}` verbatim.
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "lookup",
          phase: "result",
          result: {
            status: 123456789,
            taskId: 12345,
            details: { async: true, isError: false, secretFlag: true },
          },
        },
      },
    }, ["lookup"]) as {
      payload: {
        data: {
          result: Record<string, unknown> & {
            details: Record<string, unknown> & { async: boolean; isError: boolean };
          };
        };
      };
    };
    const r = out.payload.data.result;
    expect(r.status, "a number under a reader key is still data").toBe(0);
    expect(r.taskId).toBe(0);
    expect(r.details.async, "the ack flag survives").toBe(true);
    expect(r.details.isError, "so does the error flag").toBe(false);
    expect(r.details[maskText("secretFlag")], "any other flag does not").toBe(false);
  });
});

describe("serialised structure is recognised wherever it sits", () => {
  it("JSON inside result.content[].text keeps the keys its reader needs", () => {
    // `sessions_spawn` returns its JSON there, and keying the parse on the CONTAINER name
    // missed it: `childSessionKey` was masked and `extractChildSessionKey` could never
    // register the spawned child.
    const inner = JSON.stringify({
      childSessionKey: "agent:files:subagent:1c983f76-2eec-4381-a78b-5946010ed323",
      note: "texte secret",
    });
    const out = anonymize({
      payload: {
        stream: "tool",
        data: {
          name: "sessions_spawn",
          phase: "result",
          result: { content: [{ type: "text", text: inner }] },
        },
      },
    }, ["sessions_spawn"]) as {
      payload: { data: { result: { content: { text: string }[] } } };
    };
    const parsed = JSON.parse(out.payload.data.result.content[0]!.text) as {
      childSessionKey: string;
    };
    expect(parsed.childSessionKey).toMatch(/^agent:[^:]+:subagent:/);
    expect(parsed.childSessionKey).not.toContain("files");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });
});

describe("the anonymiser's mirrors match the reader they mirror", () => {
  // Hand-copied lists drift, and here the drift is silent: a value the normalizer
  // recognises and the anonymiser masks turns a visible reply into an external send. The
  // tables are small literals, so they are read straight out of the normalizer's source —
  // one chain, the same discipline as the derived known-field set.
  const source = readFileSync(resolve(HERE, "../src/providers/openclaw/normalizer.ts"), "utf8");

  function literalSet(name: string): string[] {
    const at = source.indexOf(`const ${name}`);
    if (at < 0) throw new Error(`${name} not found in the normalizer source`);
    const open = source.indexOf("[", at);
    const close = source.indexOf("]", open);
    if (open < 0 || close < 0) throw new Error(`${name} is not a literal list`);
    return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
  }

  it("CURRENT_CHAT_CHANNELS", () => {
    const expected = literalSet("CURRENT_CHAT_CHANNELS");
    expect(expected.length).toBeGreaterThan(3);
    for (const key of ["channel", "provider"]) {
      const allowed = anonymize(
        { payload: { stream: "tool", data: { name: "message", phase: "start", args: Object.fromEntries(expected.map((v) => [key, v])) } } },
        ["message"],
      ) as { payload: { data: { args: Record<string, string> } } };
      // Every channel the reader treats as "this chat" must survive verbatim.
      for (const value of expected) {
        const probe = anonymize(
          { payload: { stream: "tool", data: { name: "message", phase: "start", args: { [key]: value } } } },
          ["message"],
        ) as { payload: { data: { args: Record<string, string> } } };
        expect(probe.payload.data.args[key], `${key}: ${value}`).toBe(value);
      }
      expect(allowed).toBeDefined();
    }
  });

  it("EXTERNAL_TARGET_KEYS and VISIBLE_TEXT_KEYS survive as KEYS", () => {
    for (const name of ["EXTERNAL_TARGET_KEYS", "VISIBLE_TEXT_KEYS"]) {
      for (const key of literalSet(name)) {
        const out = anonymize(
          { payload: { stream: "tool", data: { name: "message", phase: "start", args: { [key]: "x" } } } },
          ["message"],
        ) as { payload: { data: { args: Record<string, unknown> } } };
        expect(Object.keys(out.payload.data.args), `${name}: ${key}`).toContain(key);
      }
    }
  });
});
