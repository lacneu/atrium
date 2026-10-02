// EVERY `chat.send` GOES THROUGH issueChatSend (providers/openclaw/chat-send.ts).
//
// The gate that re-checks the conversation's knowledge choice right before the request
// only closes the "check, then await, then send" class if nothing can send around it.
// This walks every bridge source file's SYNTAX TREE (comments cannot count, and a string
// in a comment is not code) and fails on any "chat.send" string literal outside
// chat-send.ts. An indirect method name is already refused by rpc-scope.test.ts ("no
// `.request(` call hides its method behind a variable").

import { readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  chatSendFrameBytes,
  issueChatSend,
  NO_CONVERSATION_CHOICE,
  wasWithheldBeforeSend,
} from "../src/providers/openclaw/chat-send.js";
import { FrameTooLargeError } from "../src/core/frame-size.js";

const SRC = new URL("../src/", import.meta.url);

function files(dir: URL): string[] {
  return readdirSync(dir).flatMap((name) => {
    const child = new URL(name, dir);
    if (statSync(child).isDirectory()) return files(new URL(`${name}/`, dir));
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [child.pathname] : [];
  });
}

function chatSendLiterals(path: string): number {
  const sf = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === "chat.send"
    ) {
      n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

describe("one door for chat.send", () => {
  it("no bridge source issues chat.send except chat-send.ts", () => {
    const offenders = files(SRC)
      .filter((p) => !p.endsWith("/providers/openclaw/chat-send.ts"))
      .filter((p) => chatSendLiterals(p) > 0)
      .map((p) => p.slice(p.indexOf("/src/") + 1));
    expect(offenders, "send through issueChatSend, with the gate that applies").toEqual([]);
    // …and the door itself is found (the scan is not vacuous): the request it issues,
    // and the measure of the frame that request writes (`chatSendFrameBytes`).
    expect(chatSendLiterals(new URL("providers/openclaw/chat-send.ts", SRC).pathname)).toBe(2);
  });

  it("the gate runs before the request and a refusal issues nothing, marked as never sent", async () => {
    const request = vi.fn(async () => ({ payload: {} }));
    const refusal = new Error("withheld");
    await expect(
      issueChatSend({ request }, { sessionKey: "k" }, 1_000, {
        check: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(request).not.toHaveBeenCalled();
    expect(wasWithheldBeforeSend(refusal)).toBe(true);
    await issueChatSend({ request }, { sessionKey: "k" }, 1_000, NO_CONVERSATION_CHOICE);
    expect(request).toHaveBeenCalledWith("chat.send", { sessionKey: "k" }, 1_000);
    expect(wasWithheldBeforeSend(new Error("other"))).toBe(false);
  });

  it("the gate's read is the LAST await: nothing runs between the check and the request", async () => {
    const order: string[] = [];
    const request = vi.fn(async () => {
      order.push("request");
      return { payload: {} };
    });
    await issueChatSend({ request }, {}, 1_000, {
      refresh: async () => {
        order.push("refresh");
        await Promise.resolve();
      },
      check: () => {
        order.push("check");
      },
    });
    expect(order).toEqual(["refresh", "check", "request"]);
    // A failing read withholds too (never sent), marked as such.
    const readFailed = new Error("read");
    await expect(
      issueChatSend({ request }, {}, 1_000, { refresh: async () => Promise.reject(readFailed), check: () => {} }),
    ).rejects.toBe(readFailed);
    expect(wasWithheldBeforeSend(readFailed)).toBe(true);
  });

  it("performSend hands its knowledge gate to the send, whichever socket carries it", () => {
    const src = readFileSync(new URL("server.ts", SRC), "utf-8");
    // The third argument is the body with the widget declaration the conversation's
    // socket actually holds (see performSend); what this test pins is the gate.
    expect(src).toMatch(
      /sendAsSpeaker\(\s*conn,\s*params,[^;]*?\{ \.\.\.body, inlineWidgets: session\.runManager\.widgetsEnabled \},\s*presendConfig,\s*speakers,\s*knowledgeGate,\s*\)/,
    );
    expect(src).toMatch(/const send = \(via: OpenClawConnection\) => issueChatSend\(via, params, 20_000, gate\);/);
  });
});

describe("the door measures the frame against the socket that carries it", () => {
  const params = { sessionKey: "k", message: "é".repeat(1_000), idempotencyKey: "webchat-1" };

  it("over the socket's maxPayload: withheld by name, NO request issued", async () => {
    const request = vi.fn(async () => ({ payload: {} }));
    const err = await issueChatSend({ request, maxPayload: 1_024 }, params, 1_000, NO_CONVERSATION_CHOICE).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FrameTooLargeError);
    expect(wasWithheldBeforeSend(err)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("a frame of EXACTLY the limit goes out; an unknown limit is not a refusal", async () => {
    const exact = chatSendFrameBytes(params);
    const request = vi.fn(async () => ({ payload: {} }));
    await issueChatSend({ request, maxPayload: exact }, params, 1_000, NO_CONVERSATION_CHOICE);
    await issueChatSend({ request, maxPayload: null }, params, 1_000, NO_CONVERSATION_CHOICE);
    await issueChatSend({ request }, params, 1_000, NO_CONVERSATION_CHOICE);
    expect(request).toHaveBeenCalledTimes(3);
    const err = await issueChatSend({ request, maxPayload: exact - 1 }, params, 1_000, NO_CONVERSATION_CHOICE).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FrameTooLargeError);
  });
});
