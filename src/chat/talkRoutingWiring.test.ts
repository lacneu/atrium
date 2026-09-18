/// <reference types="vite/client" />
//
// The composer → voice → consult wiring, guarded at the SOURCE.
//
// THE DEFECT. A user picks another agent in the composer and presses the voice
// button: the session was minted for the agent the THREAD last engaged, not the one
// the picker shows. Agents differ in instructions, tools and access, so this is not
// cosmetic. Convex now authorizes an explicit `routedAgent` on every Talk lane, and
// the Convex tests pin that half.
//
// THIS half is a handful of lines of React that no runtime test in this repo reaches
// today: the component opens a WebRTC peer connection and a microphone, and nothing
// here fakes either. That is a gap in the harness, not an impossibility — both are
// fakeable — and until it is closed these expressions can each be deleted without
// breaking a type:
//   1. ConvexChat passes the composer's current selection to <TalkControl>;
//   2. TalkControl forwards it to the mint;
//   3. TalkControl keeps the MINT's session handle — the server's own record of
//      which agent and conversation the call was opened on;
//   4. the consult carries that handle;
//   5. `start` lists `routedAgent` among its deps — the file disables the
//      exhaustive-deps rule for an unrelated reason, so nothing else would notice a
//      stale selection being minted;
//   6. the mount is keyed on the chat, so navigating away ends the call instead of
//      leaving a microphone and a gateway session live under another chat's UI.
// So the guard reads the source. It is a weaker instrument than a test that runs the
// code, and it is named as such rather than dressed up as one. It matches against
// COMMENT-STRIPPED source: a first version was satisfied by the prose beside the
// code it was meant to pin.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf-8");
const CONVEX_CHAT = read("src/chat/ConvexChat.tsx");
const TALK_CONTROL = read("src/chat/TalkControl.tsx");

/** The `<TalkControl …/>` element as written in ConvexChat. */
function talkControlElement(): string {
  const at = CONVEX_CHAT.indexOf("<TalkControl");
  expect(at, "ConvexChat no longer mounts <TalkControl>").toBeGreaterThan(-1);
  return stripComments(CONVEX_CHAT.slice(at, CONVEX_CHAT.indexOf("/>", at)));
}

/** Line and block comments removed, so a guard cannot be satisfied by the prose
 *  that explains the code it is pinning. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The body of a `const <name> = useCallback(…)` / plain function in TalkControl. */
function talkControlSlice(from: string, to: string): string {
  const a = TALK_CONTROL.indexOf(from);
  expect(a, `TalkControl no longer contains ${from}`).toBeGreaterThan(-1);
  const b = TALK_CONTROL.indexOf(to, a);
  expect(b, `TalkControl no longer contains ${to} after ${from}`).toBeGreaterThan(
    -1,
  );
  return stripComments(TALK_CONTROL.slice(a, b));
}

describe("the composer's selection reaches the voice session", () => {
  test("ConvexChat hands TalkControl the current selection", () => {
    const el = talkControlElement();
    expect(el).toMatch(/routedAgent=/);
    // The composer's OWN selection — not the chat's binding, which is exactly the
    // value that made the picker and the voice disagree.
    expect(el).toMatch(/composerSelected/);
  });

  test("NOTHING conditions the mount — the decision is inside the control", () => {
    // A condition around the mount unmounts the control when it flips, and the
    // unmount effect hangs up: an answer landing mid-call would cut the microphone.
    // Inside, the same answer can only hide an IDLE button (hidesTalkControl).
    //
    // The check is for a ternary at all, not for one particular predicate: a guard
    // that only forbade `chatCan("talk")` stayed green against
    // `!capsLoading && capsResolved ? <TalkControl …>`, which reintroduces exactly
    // the same unmount. The window is measured on COMMENT-STRIPPED source — a raw
    // slice is mostly the JSX comment above the element, which pushed a wrapper out
    // of view — and matching is case-insensitive, since an earlier version looked for
    // `can("talk")` while the call site spells it `chatCan("talk")` and therefore
    // passed against the very regression it was written for.
    const at = CONVEX_CHAT.indexOf("<TalkControl");
    expect(at, "ConvexChat no longer mounts <TalkControl>").toBeGreaterThan(-1);
    // The JSX EXPRESSION the element sits in, from its opening brace: checking only
    // the characters immediately before the tag missed `capsResolved && <TalkControl`
    // and a ternary wrapping a fragment, both of which unmount it just the same.
    const stripped = stripComments(CONVEX_CHAT.slice(0, at));
    const open = stripped.lastIndexOf("{");
    const expr = stripped.slice(open, at);
    for (const operator of ["?", "&&", "||"]) {
      expect(
        expr,
        `the mount is conditioned with \`${operator}\``,
      ).not.toContain(operator);
    }
    expect(expr).not.toMatch(/can\("talk"\)/i);
    // …and the server's one answer really GATES the render. `hidesTalkControl({`
    // anywhere would also be satisfied by a `void hidesTalkControl({…})`.
    expect(stripComments(TALK_CONTROL)).toMatch(
      /if\s*\(hidesTalkControl\(\{[\s\S]{0,200}\)\)\s*return null;/,
    );
  });

  test("the visibility probe is asked about that agent too", () => {
    // Otherwise the button reflects the thread's agent while the picker shows
    // another: a talk-disabled instance would still offer a button that fails.
    const probe = talkControlSlice("useQuery(api.talk.talkAvailable, {", "});");
    expect(probe).toMatch(/\{\s*routedAgent\s*\}/);
  });

  test("the control is handed the composer's selection to begin with", () => {
    // Bounded to the element: a bare `composerSelected` search matches the next
    // unrelated use a few lines below and stays green after the prop is deleted.
    expect(talkControlElement()).toMatch(/routedAgent=\{[\s\S]{0,200}composerSelected/);
  });

  test("the mint is asked for that agent", () => {
    // The call ends in `}).catch(...)`, so `});` does NOT bound it — a slice cut
    // there ran on to getUserMedia and matched code that has nothing to do with the
    // mint.
    const start = talkControlSlice("const minted = await mint({", "}).catch(");
    expect(start).toMatch(/\{\s*routedAgent\s*\}/);
  });

  test("`start` re-binds when the selection changes", () => {
    // The file disables exhaustive-deps for an unrelated reason, so a missing
    // dependency here is invisible: the click would mint the PREVIOUS selection.
    const deps = talkControlSlice(
      "}, [advance, chatId, mint, teardown",
      "]);",
    );
    expect(deps).toMatch(/routedAgent/);
  });
});

describe("the call is pinned to the agent it actually reached", () => {
  test("the handle is taken from the MINT's answer", () => {
    // Scoped to `start`: the same assignment sitting in dead code elsewhere in the
    // file would satisfy a whole-file match.
    const start = talkControlSlice("const minted = await mint({", "advance(\"connected\")");
    expect(start).toMatch(/sessionIdRef\.current\s*=\s*minted\.sessionId/);
    // Keeping the client's own override instead is the subtle wrong version: it is
    // null on a normal session, so the consult would re-resolve.
    expect(start).not.toMatch(/sessionIdRef\.current\s*=\s*routedAgent/);
  });

  test("the consult carries the session handle", () => {
    // Without it the server re-resolves, and a thread that moved mid-call sends the
    // consult into a different gateway session than the one on the line. Bounded at
    // `}).catch(` — the call's real end; `});` ran on to the submit() below.
    const relay = talkControlSlice(
      "const res = await relayToolCall({",
      "}).catch(",
    );
    expect(relay).toMatch(/sessionId:\s*sessionIdRef\.current/);
  });

  test("the handle does not survive the call", () => {
    // A stale handle would address whatever the PREVIOUS session belonged to.
    const teardown = talkControlSlice("const teardown = useCallback(", "}, []);");
    expect(teardown).toMatch(/sessionIdRef\.current\s*=\s*null/);
  });

  test("the control is REMOUNTED per chat", () => {
    // This route component is reused across chats. Without a key, navigating away
    // leaves the microphone and the gateway session of the previous conversation
    // live under the new one's UI — and `teardown` never runs, so the handle stays.
    expect(talkControlElement()).toMatch(/key=\{chatId\}/);
  });
});

describe("a call that cannot continue is ENDED, not left open", () => {
  test("a terminal consult code hangs up", () => {
    // Reporting it to the voice model and carrying on gives the user a
    // conversation whose agent is unreachable and will stay unreachable.
    const relay = talkControlSlice("const res = await relayToolCall({", "const output =");
    expect(relay).toMatch(/endsTheCall\(res\.code\)/);
    expect(relay).toMatch(/hangup\(\)/);
  });

  test("a rejected mint becomes a code instead of a stuck control", () => {
    // The action throws before its own try block when an authorization gate
    // refuses; without a catch the control sits in `connecting` forever.
    const start = talkControlSlice("const minted = await mint({", "if (genRef.current !== gen)");
    expect(start).toMatch(/\.catch\(/);
  });

  test("hangup and unmount really call teardown", () => {
    // The guard above only proves teardown CLEARS the handle; if nothing calls it,
    // the microphone and the handle both survive.
    const hangup = talkControlSlice("const hangup = useCallback(", "}, [advance, teardown]);");
    expect(hangup).toMatch(/teardown\(\)/);
    const unmount = talkControlSlice("useEffect(\n    () => () => {", "[teardown],");
    expect(unmount).toMatch(/teardown\(\)/);
  });
});

describe("the handle table is swept on a schedule", () => {
  test("the janitor is registered as a cron", () => {
    // Calling the mutation in a test proves it deletes; only this proves anything
    // ever calls it. The opportunistic sweep runs on mint alone, so a deployment
    // that stops minting would keep its last expired rows forever.
    // Comment-stripped like every other guard here: commenting the registration out
    // is exactly how it would disappear.
    const crons = stripComments(
      readFileSync(join(process.cwd(), "convex/crons.ts"), "utf-8"),
    );
    expect(crons).toMatch(/internal\.talk\.sweepTalkSessions/);
  });
});
