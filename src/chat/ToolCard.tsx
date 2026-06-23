import { useState } from "react";
import {
  CircleDot,
  LoaderCircle,
  CircleAlert,
  ChevronRight,
  Copy,
  Check,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import {
  formatToolResult,
  toolOutcomeLabel,
  toolPreview,
} from "./toolActivityView";

// Small copy button for a tool's input/output block. Hover-revealed in the
// block's top-right (the standard code-copy affordance); flips to a check for a
// moment after copying. navigator.clipboard works on localhost (secure context).
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="oc-copybtn"
      title="Copier"
      aria-label="Copier le contenu"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

// Props mirror assistant-ui's tool-call content-part component shape. We type
// them locally because the exported `ToolCallContentPartComponent` type was
// removed/renamed in @assistant-ui/react 0.14; the runtime contract (the fields
// passed to a tool component) is unchanged.
type ToolCardProps = {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  status?: { type?: string } | undefined;
};

// Renders a single tool invocation. The bridge normalizer emits
// `tool.status {name, phase, runId}` events; the bridge stores them as
// messageParts of kind:"tool" (name, phase, input?, output?). convertMessage
// turns each into an assistant-ui `tool-call` content part, and assistant-ui
// routes it here. Phase/output stream in reactively as the bridge patches the
// part, so the card fills in (input first, output when the tool completes)
// without any per-turn HTTP request.

function phaseClass(phaseRaw: unknown, hasResult: boolean): string {
  const phase = typeof phaseRaw === "string" ? phaseRaw : undefined;
  if (phase === "error") return "error";
  if (hasResult || phase === "completed") return "completed";
  if (phase === "running" || phase === "started") return "running";
  return "running";
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCard({
  toolName,
  args,
  argsText,
  result,
  status,
}: ToolCardProps) {
  const hasResult = result !== undefined && result !== null;
  // assistant-ui status.type is "running" | "complete" | "incomplete" | ...
  const phase = phaseClass(status?.type, hasResult);
  const inputText = argsText ?? pretty(args);
  const preview = toolPreview(args, argsText);
  // Classify the result so a bare exec OUTCOME envelope (no stdout -- the gateway
  // does not transmit it; see formatToolResult) renders as a clear outcome line
  // instead of misleading raw JSON, while real text/rich results show in full.
  const out = hasResult ? formatToolResult(result) : null;

  // Agent-plan-style status glyph (neutral — NO loud green check; the "completed"
  // text already carries the state). running = spinner, error = alert, otherwise
  // a quiet circle-dot. Colour stays muted/destructive, never green. This is the
  // base "task" representation we can grow into a full plan view later
  // (subtasks/steps) — see https://21st.dev/.../agent-plan.
  const StatusIcon =
    phase === "running" ? LoaderCircle : phase === "error" ? CircleAlert : CircleDot;

  // Two-level collapse (by design): the WHOLE tool is a <details> collapsed by
  // default — only the name/status header shows. Expanding it reveals the IO,
  // where OUTPUT is open by default and INPUT stays folded (the result is what
  // you usually want to read first).
  return (
    <details className={`oc-tool oc-tool--${phase}`}>
      <summary className="oc-tool__header">
        <StatusIcon
          className={`oc-tool__status${phase === "running" ? " oc-tool__status--spin" : ""}`}
          size={14}
          aria-hidden
        />
        <span className="oc-tool__name">{toolName}</span>
        {preview ? (
          <span className="oc-tool__preview" title={preview}>
            {preview}
          </span>
        ) : null}
        <span className="oc-tool__phase">{phase}</span>
        <ChevronRight size={15} className="oc-tool__chevron" aria-hidden />
      </summary>
      <div className="oc-tool__body">
        {inputText ? (
          <details className="oc-tool__io">
            <summary>input</summary>
            <div className="oc-tool__prewrap">
              <pre className="oc-tool__pre">{inputText}</pre>
              <CopyButton text={inputText} />
            </div>
          </details>
        ) : null}
        {out && out.kind === "outcome" ? (
          <div className="oc-tool__outcome">
            <span className="oc-tool__outcome-label">
              {toolOutcomeLabel(out)}
            </span>
            <span className="oc-tool__outcome-note">
              {m.tools_output_not_transmitted()}
            </span>
          </div>
        ) : out ? (
          <details className="oc-tool__io" open>
            <summary>output</summary>
            <div className="oc-tool__prewrap">
              <pre className="oc-tool__pre">{out.text}</pre>
              <CopyButton text={out.text} />
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}
