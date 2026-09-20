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
    // The braced body is accepted because the predicate gained a third input and the
    // formatter broke the call across lines: what is asserted is that its result
    // guards a `return null`, not how many lines that takes.
    expect(stripComments(TALK_CONTROL)).toMatch(
      /if\s*\(\s*hidesTalkControl\(\{[\s\S]{0,200}\)\s*\)\s*\{?\s*return null;/,
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
      "}, [advance, chatId, hangupSession, mint",
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
    const hangup = talkControlSlice(
      "const hangup = useCallback(",
      "}, [advance, releaseOwnedCall, teardown]);",
    );
    expect(hangup).toMatch(/teardown\(\)/);
    const unmount = talkControlSlice(
      "useEffect(\n    () => () => {",
      "[releaseOwnedCall, teardown],",
    );
    expect(unmount).toMatch(/teardown\(\)/);
    // A GPT Live call is the GATEWAY's, held open on the bridge's socket: the
    // browser's own teardown does not end it. Both exits must ALSO tell the gateway,
    // or a call outlives the person who hung up (until the gateway's TTL).
    expect(hangup).toMatch(/releaseOwnedCall\(\)/);
    expect(unmount).toMatch(/releaseOwnedCall\(\)/);
    const release = talkControlSlice("const releaseOwnedCall = useCallback(", "}, [chatId, hangupSession]);");
    expect(release).toMatch(/hangupWithRetry\(/);
  });
});

describe("a session that arrives after a hangup is closed at once", () => {
  test("`start` hangs up the minted session, by its own handle", () => {
    // The pure disposition proves the DECISION; only this proves the component
    // acts on it. Replacing the branch by a bare `return` would leave every other
    // guard green while the call sat on a gateway reservation — and the chat's
    // agent frozen — until the call window ran out.
    const branch = talkControlSlice(
      'if (disposition === "hangup-now") {',
      "} else if (genRef.current !== gen) {",
    );
    // BEFORE the branch returns: a `return` placed ahead of the call would leave the
    // text in place as dead code, and a match on the whole branch would stay green.
    const reachable = branch.slice(0, branch.indexOf("return"));
    expect(reachable).toMatch(/hangupSession\(\{/);
    expect(reachable).toMatch(/sessionId:\s*minted\.sessionId/);
    // …and through the bounded retry, like every other hangup: a first network blip
    // must not leave the call held until the gateway's TTL.
    expect(reachable).toMatch(/hangupWithRetry\(/);
  });
});

describe("the two sides agree on how long a send may be in flight", () => {
  test("the direct hold OUTLASTS the deadline Convex gives a send POST", () => {
    // These two numbers live in two repositories and mean one thing together, and
    // each is read from its own top-level export — not from any line that happens to
    // spell the name. Convex
    // allows a send POST four minutes, and its clock starts before the request
    // leaves — so a dispatch that read "no call" just before a mint can still reach
    // the bridge minutes later. The hold exists to refuse that arrival, so a hold
    // shorter than the send's own deadline reopens the hand-off it was written to
    // prevent (codex P1, pass 14). Asserted across the two files because neither
    // side can see the other's constant.
    const read = (rel: string) =>
      stripComments(readFileSync(join(process.cwd(), rel), "utf-8"));
    const num = (src: string, name: string): number => {
      // ANCHORED on the top-level export — the one the server imports. An unanchored
      // match accepted any declaration of that name, so re-exporting a real 3-minute
      // hold under it while a 5-minute local shadowed it inside some function read
      // as 5 and kept every ordering assertion green (codex P3, pass 15).
      const m = new RegExp(`^export const ${name} = ([^;]+);`, "m").exec(src);
      expect(m, `${name} is no longer a top-level export`).not.toBeNull();
      // The constants are written as arithmetic (`5 * 60_000`), so evaluate them.
      return Number(
        new Function(`return ${m![1]!.replace(/_/g, "")}`)() as number,
      );
    };
    const hold = num(read("bridge/src/core/talk-relay.ts"), "TALK_DIRECT_HOLD_MS");
    const deadline = num(read("convex/bridge.ts"), "SEND_POST_TIMEOUT_MS");
    expect(hold).toBeGreaterThan(deadline);
  });
});

describe("a sub-agent send always settles its row", () => {
  test("every step after the row exists is INSIDE the try, and the POST is bounded", () => {
    // The row is written before the POST, and a `pending` row now refuses voice calls
    // to other agents as well as holding the panel — with no reconciler to clear it.
    // So the guarantee is positional: nothing between the row and the response may
    // escape the handler that settles it, and the request must not be able to hang
    // until the platform kills the action with the row still pending (codex P2, pass
    // 21). A runtime test cannot stage a blob read failing or a socket hanging.
    const src = stripComments(
      readFileSync(join(process.cwd(), "convex/subAgentInteractions.ts"), "utf-8"),
    );
    const post = src.indexOf('"")}/subagent-send`');
    expect(post, "the sub-agent POST moved").toBeGreaterThan(-1);
    const tryAt = src.lastIndexOf("try {", post);
    const blobs = src.lastIndexOf("for (const ref of prep.attachmentRefs)", post);
    expect(blobs, "the attachment loop moved").toBeGreaterThan(-1);
    expect(
      blobs,
      "reading the attachments escapes the handler that settles the row",
    ).toBeGreaterThan(tryAt);
    // …and the request is bounded.
    const call = src.slice(post, src.indexOf(");", post));
    expect(call).toMatch(/signal: AbortSignal\.timeout\(/);
  });
});

describe("the sub-agent panel says why its send was refused", () => {
  test("it CATCHES the refusal, names it, and keeps the draft", () => {
    // The freeze refuses this door too — a message to a child of another agent would
    // reach it mid-call. With only a `finally` the rejection died silently: the draft
    // stayed, nothing happened, and the reader had no idea why (codex P3, pass 21).
    const panel = stripComments(
      readFileSync(join(process.cwd(), "src/chat/SubAgentPanel.tsx"), "utf-8"),
    );
    const send = panel.slice(panel.indexOf("const doSend = async () => {"));
    const body = send.slice(0, send.indexOf("\n  };"));
    expect(body).toMatch(/catch \(/);
    expect(body).toMatch(/TALK_CALL_ACTIVE/);
    expect(body).toMatch(/chat_send_call_active\(\)/);
    // …and the draft is cleared only on the ACCEPTED path, never in the catch.
    const accepted = body.slice(0, body.indexOf("catch ("));
    expect(accepted).toMatch(/setDraft\(""\)/);
    expect(body.slice(body.indexOf("catch ("))).not.toMatch(/setDraft\(""\)/);
  });
});

describe("a consult keeps the socket held", () => {
  test("the toolcall route extends the hold before it does anything else", () => {
    // Position is the guarantee: a consult that extended AFTER the long relay would
    // arrive too late on the very call it proves is live. Asserted on source because
    // the hold is bridge memory and the route's work is a detached driver.
    const server = stripComments(
      readFileSync(join(process.cwd(), "bridge/src/server.ts"), "utf-8"),
    );
    const route = server.indexOf('req.url === "/talk-toolcall"');
    expect(route, "the toolcall route moved").toBeGreaterThan(-1);
    const extend = server.indexOf("extendLiveVoiceCalls(", route);
    expect(extend, "a consult no longer extends the hold").toBeGreaterThan(-1);
    const driver = server.indexOf("withOperatorConnection", route);
    expect(extend, "the extension happens after the relay starts").toBeLessThan(driver);
  });
});

describe("a hangup from anywhere ends the call HERE too", () => {
  test("the owning tab tears down when the server no longer has its call", () => {
    // A hangup from elsewhere (the recovery pill in another tab, the end-of-window
    // marker) marks the row ended. On the RELAYED lane the gateway closes the call
    // with it; on the DIRECT lane nothing can reach this browser's peer connection —
    // upstream's close says so in as many words. So this tab kept a live microphone
    // and a voice model on a call the server had ended, while the other tab, seeing
    // no call, could route the conversation to another agent (codex P2, pass 12).
    const control = stripComments(TALK_CONTROL);
    // ASKED ABOUT THIS SESSION, not about the chat. A chat-wide answer can predate
    // this tab's own mint, which forced an earlier version to first WATCH its call
    // appear — and a tab that never saw that intermediate state could then never
    // react at all (codex P1, pass 16). A subscription on this id cannot exist before
    // the row does, so `false` is always "ended", never "not yet".
    expect(control).toMatch(/useQuery\(\s*api\.talk\.talkCallLive/);
    expect(control).toMatch(/ownCall === null \? "skip" : \{ sessionId: ownCall \}/);
    expect(control).toMatch(/ownCallLive === false/);
    // …and nothing gates it on having observed the call being up.
    expect(control).not.toMatch(/serverSawOursRef/);
    // …then really tears down: a bare state flip would leave the microphone live.
    const effect = control.slice(control.indexOf("if (!serverEndedOurs) return;"));
    const body = effect.slice(0, effect.indexOf("}, ["));
    expect(body).toMatch(/releaseOwnedCall\(\)/);
    expect(body).toMatch(/teardown\(\)/);
    expect(body).toMatch(/genRef\.current\+\+/);
    // …and says what happened. "The voice session expired" would send the reader
    // looking for a timeout that never occurred (codex P3, pass 13).
    expect(body).toMatch(/talk_error_ended_elsewhere\(\)/);
  });

  test("the watch starts at the mint and stops at teardown", () => {
    // Started anywhere later and a call hung up from elsewhere in between would go
    // unnoticed; left running after teardown and the next render would tear down a
    // call that no longer exists.
    const control = stripComments(TALK_CONTROL);
    expect(control).toMatch(
      /sessionIdRef\.current = minted\.sessionId;\s*\n\s*setOwnCall\(minted\.sessionId\);/,
    );
    expect(control).toMatch(
      /sessionIdRef\.current = null;\s*\n\s*setOwnCall\(null\);/,
    );
  });
});

describe("the freeze is re-asked with the POST in hand", () => {
  test("the LAST thing before /send is the check, not the attachment work", () => {
    // The dispatch checks at the top, then resolves the owner and the routing and
    // fetches and base64-encodes every attachment. A call minted in that gap is bound
    // to the socket the POST is about to re-key. The BRIDGE refuses such a re-key —
    // that is what makes the guarantee hold — but its hold is sized to the race
    // around the mint (two minutes), and a dispatch carrying large files can arrive
    // later than that. Position is the whole point here, so position is what is
    // asserted: a runtime test cannot stage a call landing between two awaits.
    const dispatch = stripComments(
      readFileSync(join(process.cwd(), "convex/bridge.ts"), "utf-8"),
    );
    const post = dispatch.indexOf('")}/send`');
    expect(post, "the dispatch no longer POSTs /send").toBeGreaterThan(-1);
    // The attachment/mention work, then the check, then the POST — in that order.
    const mentions = dispatch.lastIndexOf("canonicalsForUsers", post);
    expect(mentions, "the mention resolution moved").toBeGreaterThan(-1);
    const recheck = dispatch.lastIndexOf("internal.bridge.reparkIfBusy", post);
    expect(
      recheck,
      "nothing re-asks the freeze between the attachment work and the POST",
    ).toBeGreaterThan(mentions);
    // …and it RETURNS on a re-park: falling through would post anyway.
    expect(dispatch.slice(recheck, post)).toMatch(/\)\)\s*\{?\s*return;/);
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

describe("the agent cannot be switched while a call is in progress", () => {
  test("TalkControl reports the call up, and the thread feeds the gate with it", () => {
    // Three links, and a break in any one of them silently re-opens the selector:
    // the control raises it, the composer forwards it, the thread hands it to the
    // gate. The server refuses the switch as well (`TALK_CALL_ACTIVE`); this is the
    // half that closes the control BEFORE the click.
    const el = talkControlElement();
    expect(el).toMatch(/onCallActiveChange=\{onTalkCallActiveChange\}/);
    const thread = stripComments(CONVEX_CHAT);
    expect(thread).toMatch(/onTalkCallActiveChange=\{setTalkCallActive\}/);
    expect(thread).toMatch(/callActive:\s*talkCallActive/);
  });

  test("the thread also asks the SERVER, so a reload or a second tab is not blind", () => {
    // The local flag is this tab's TalkControl: false after a reload, false in a
    // second tab. Without this read the selector looked open while every send came
    // back TALK_CALL_ACTIVE — enforced but never explained (codex pass 3).
    const thread = stripComments(CONVEX_CHAT);
    expect(thread).toMatch(/useQuery\(api\.talk\.chatCallState/);
    // …and BOTH sources count: either one alone re-opens the selector.
    expect(thread).toMatch(
      /callActive:\s*talkCallActive \|\| serverCall\?\.active === true/,
    );
  });

  test("the LOCKED control names the agent the CALL is on, not this tab's pick", () => {
    // Its whole job while closed is to say who is on the line. Derived from the tab's
    // own selection it named the wrong agent for a second tab, and for a participant
    // whose pick differs from the owner's call (codex P2, pass 5).
    const thread = stripComments(CONVEX_CHAT);
    // The thread feeds the call's agent onto the gate…
    expect(thread).toMatch(/onCall:\s*\n?\s*serverCall\?\.active === true/);
    // …and the control prefers it over its local selection.
    expect(thread).toMatch(/const shown =\s*\n?\s*gate\.onCall \?\?/);
  });

  test("a call on an agent OUTSIDE the reader's pool is named with its instance", () => {
    // An agent's identity is the PAIR instance/id. A participant whose own agents all
    // sit on one gateway has `multiInstance` false, so the label collapsed to a bare
    // id — indistinguishable from their own agent of the same name, while the call ran
    // on another gateway entirely (codex P3, pass 6).
    const thread = stripComments(CONVEX_CHAT);
    expect(thread).toMatch(/showsForeignAgent =/);
    expect(thread).toMatch(/\(multiInstance \|\| showsForeignAgent\) && shown/);
  });

  test("a call this tab does NOT own can still be hung up from here", () => {
    // The lot made the freeze visible; visible and unclearable is a worse state than
    // invisible. After a reload — or a browser that crashed mid-call — nothing in this
    // tab knows the session, so the pill offered to START a call the mint would
    // refuse, for the whole 31-minute window. It offers to END it instead.
    const thread = stripComments(CONVEX_CHAT);
    expect(thread).toMatch(/serverCallSessionId=\{/);
    // …and only when this tab owns none: its own hangup path runs otherwise.
    expect(thread).toMatch(
      /talkCallActive \? null : \(serverCall\?\.sessionId \?\? null\)/,
    );
    const el = talkControlElement();
    expect(el).toMatch(/serverCallSessionId=\{serverCallSessionId\}/);
    // The control's idle branch acts on it, through the bounded retry like every
    // other hangup.
    const control = stripComments(TALK_CONTROL);
    const idle = control.slice(
      control.indexOf('phase === "idle" && serverCallSessionId !== null'),
    );
    const reachable = idle.slice(0, idle.indexOf(') : phase === "idle" ?'));
    expect(reachable).toMatch(/hangupWithRetry\(/);
    expect(reachable).toMatch(/sessionId: serverCallSessionId/);
  });

  test("a reader with NO selector is still told why the send was refused", () => {
    // The selector says it before the click — but a single-agent PARTICIPANT has no
    // selector (multiAgent false) and no voice control (owner-only), so the server's
    // refusal reached them as the generic "send failed" with nothing to act on
    // (codex P2, pass 8). Named where every send failure passes.
    const runtime = stripComments(
      readFileSync(join(process.cwd(), "src/chat/useConvexChatRuntime.ts"), "utf-8"),
    );
    const toast = runtime.slice(runtime.indexOf('includes("QUEUE_FULL")'));
    const reachable = toast.slice(0, toast.indexOf("return false"));
    expect(reachable).toMatch(/includes\("TALK_CALL_ACTIVE"\)/);
    // ITS OWN STRING: the selector's tooltip says "the agent cannot be changed — hang
    // up first", and this reader changed nothing and cannot hang up someone else's
    // call. Reusing it would have been a sentence that does not describe them.
    expect(reachable).toMatch(/chat_send_call_active\(\)/);
    expect(reachable).not.toMatch(/chat_agent_select_call_hint\(\)/);
  });

  test("the hint names the call, not the first-turn rule", () => {
    // A reader told "the agent is set with the first message" while they are on a
    // call would go looking for a message that has nothing to do with it.
    const thread = stripComments(CONVEX_CHAT);
    expect(thread).toMatch(/gate\.reason === "call-active"/);
    expect(thread).toMatch(/chat_agent_select_call_hint/);
  });
});
