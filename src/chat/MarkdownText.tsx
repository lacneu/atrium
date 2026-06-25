import { memo, type ComponentPropsWithoutRef } from "react";
import {
  StreamdownTextPrimitive,
  type StreamdownTextComponents,
} from "@assistant-ui/react-streamdown";
import { isNavigableHref } from "./markdownLinks";

// Anchor renderer for AGENT-AUTHORED markdown. Two cases:
//   - A real, browser-navigable URL (absolute http(s)/mailto) → open in a NEW tab
//     (agent output is untrusted; a same-tab nav would replace the webchat) with
//     `noopener noreferrer` (anti reverse-tabnabbing).
//   - Anything else (a server-side FILE PATH, a bare filename, a media:// ref —
//     what an agent writes when it mentions a file it produced) is NOT navigable:
//     rendering it as <a> made a click resolve RELATIVE to the app origin, so the
//     SPA router showed the home/404 screen ("opens the home page instead of the
//     file"). Render those as plain TEXT — the name stays visible, no broken nav.
//     (A genuinely downloadable agent file is hosted separately as a media part
//     with an absolute storage URL, which IS navigable and unaffected here.)
// Exported for testing (the render-level untrusted-link behavior, not just the pure
// `isNavigableHref` helper).
export function AgentAnchor({
  href,
  children,
  // Streamdown passes the parsed hast `node` to every component; strip it so it is
  // never spread onto the DOM element (React would warn on an unknown attribute).
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  if (!isNavigableHref(href)) {
    return <span {...rest}>{children}</span>;
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// Streamdown's `components` type carries a strict index signature (every entry must
// accept loosely-typed `Record<string, unknown> & { node }` props), which rejects a
// precisely-typed anchor — a known markdown-renderer typing quirk. AgentAnchor is
// correct at runtime (it reads href/children, ignores node); the cast localizes the
// quirk here rather than loosening the component's own signature.
const components = { a: AgentAnchor } as StreamdownTextComponents;

// Renders an assistant text part as GitHub-flavored markdown via Streamdown
// (`@assistant-ui/react-streamdown`). Streamdown parses the text into INDEPENDENT
// blocks and memoizes each one, so during streaming only the LAST (growing) block
// re-parses on each token — per-token cost O(last block) instead of O(whole reply).
// This is the fundamental fix for the O(n²) markdown re-parse that janked long
// streamed replies (the 0.10.8 palliative just turned the animation off + memoized
// reconcile; Streamdown removes the re-parse itself, so `smooth` is back on).
//
// Styling stays in the `.oc-md` scope (convexChat.css, shadcn tokens, light/dark) —
// Streamdown emits standard markdown elements, so the existing descendant rules
// apply; we deliberately do NOT import Streamdown's own stylesheet (it would fight
// the shadcn tokens). GFM (tables/strikethrough/task lists) is built in. `a` keeps
// the untrusted-link AgentAnchor above; HTML is sanitized by Streamdown.
export const MarkdownText = memo(function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      className="oc-md"
      // `smooth` reveals text per animation frame, which re-parses the LAST block more
      // often than the network cadence. For a single growing block (e.g. one long code
      // fence) that could amplify cost — BUT we do not install `@streamdown/code`
      // (Shiki), so a code block re-parses as cheap plain text: measured FLAT (~10-11ms
      // inter-frame, ≤4% dropped) on a 500-delta single-code-block stream with smooth on.
      // If `@streamdown/code` (syntax highlighting) is ever added, re-evaluate — per-frame
      // re-highlight of one growing code block would reintroduce jank; cap it via
      // SmoothOptions or disable smooth for code.
      smooth
      components={components}
    />
  );
});
