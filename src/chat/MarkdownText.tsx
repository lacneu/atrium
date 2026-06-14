import { memo, type ComponentPropsWithoutRef } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

// Every link inside AGENT-AUTHORED content opens in a new tab: agent output is
// untrusted/unpredictable, and a same-tab navigation would replace the webchat.
// Enforced HERE at the renderer (deterministic — never delegated to the agents)
// for ALL anchors regardless of href shape; `noopener noreferrer` also blocks
// reverse-tabnabbing from the opened page.
function AgentAnchor(props: ComponentPropsWithoutRef<"a">) {
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
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
