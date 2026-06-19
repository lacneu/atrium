import { memo, type ComponentPropsWithoutRef } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
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
function AgentAnchor({
  href,
  children,
  ...rest
}: ComponentPropsWithoutRef<"a">) {
  if (!isNavigableHref(href)) {
    return <span {...rest}>{children}</span>;
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// Renders an assistant text part as GitHub-flavored markdown (bold, inline code
// chips, lists, links, code blocks, tables). Visuals live in the `.oc-md` scope
// in convexChat.css so light/dark stay coherent with the shadcn tokens.
//
// Memoized: assistant-ui re-renders the message on every streamed token; without
// memo the whole markdown tree would re-parse each time. MarkdownTextPrimitive
// itself is streaming-aware (it tolerates partial/incomplete markdown).
export const MarkdownText = memo(function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="oc-md"
      components={{ a: AgentAnchor }}
    />
  );
});
