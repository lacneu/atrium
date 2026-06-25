import {
  createElement,
  memo,
  type ComponentPropsWithoutRef,
  type JSX,
} from "react";
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { isNavigableHref } from "./markdownLinks";

// A plain passthrough component for an intrinsic tag, so it can be wrapped in
// React.memo by memoizeMarkdownComponents (which requires ComponentType values,
// not bare tag strings). Styling stays in the `.oc-md` CSS scope.
function makeTag<T extends keyof JSX.IntrinsicElements>(tag: T) {
  return function Tag(props: ComponentPropsWithoutRef<T>) {
    return createElement(tag, props);
  };
}

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

// Per-BLOCK memoized component map. assistant-ui re-renders the assistant message
// on EVERY streamed token, and react-markdown re-parses the whole string each time.
// Without per-block memoization every already-complete block (paragraph, heading,
// list item, table row, blockquote) re-renders + re-reconciles + re-lays-out on
// each token, so the per-token main-thread cost GROWS with reply length — an O(n^2)
// that is invisible on short/plain replies but janks long markdown ones (measured:
// inter-frame gap 12ms→41ms and dropped frames 2%→76% across a long stream).
//
// memoizeMarkdownComponents wraps each element in React.memo keyed by its parsed
// hast node, so unchanged blocks bail out of rendering and only the single growing
// (last) block re-renders → render cost stays ~flat per token. Styling is unchanged:
// these are plain tags scoped by `.oc-md` in convexChat.css.
//
// `pre`/`code`/`SyntaxHighlighter`/`CodeHeader` are deliberately OMITTED so code
// blocks keep assistant-ui's own handling (PreOverride/CodeOverride, inline-vs-block
// detection, copy header). `a` keeps the untrusted-link AgentAnchor above.
const components = memoizeMarkdownComponents({
  a: AgentAnchor,
  p: makeTag("p"),
  h1: makeTag("h1"),
  h2: makeTag("h2"),
  h3: makeTag("h3"),
  h4: makeTag("h4"),
  h5: makeTag("h5"),
  h6: makeTag("h6"),
  ul: makeTag("ul"),
  ol: makeTag("ol"),
  li: makeTag("li"),
  blockquote: makeTag("blockquote"),
  hr: makeTag("hr"),
  strong: makeTag("strong"),
  em: makeTag("em"),
  del: makeTag("del"),
  table: makeTag("table"),
  thead: makeTag("thead"),
  tbody: makeTag("tbody"),
  tr: makeTag("tr"),
  th: makeTag("th"),
  td: makeTag("td"),
});

// Renders an assistant text part as GitHub-flavored markdown (bold, inline code
// chips, lists, links, code blocks, tables). Visuals live in the `.oc-md` scope
// in convexChat.css so light/dark stay coherent with the shadcn tokens.
export const MarkdownText = memo(function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="oc-md"
      smooth={false}
      components={components}
    />
  );
});
