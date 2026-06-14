import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { useQuery } from "convex/react";
import { BookOpenText, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { m } from "@/paraglide/messages.js";
import type { ProvenancePartView } from "./convexTypes";
import {
  groupLabel,
  itemMeta,
  itemTitle,
  orderedParts,
  summarizeProvenance,
  summaryLabel,
} from "./sourcesView";

// Per-message "Sources" affordance: WHAT the gateway's context-injecting
// plugins (conversational memory / document RAG) fed the LLM for this turn —
// the user's answer to "which documents relate to this reply?" and "where
// does this wrong fact come from?". Same UX grammar as ToolActivity: one
// compact always-visible summary line, expandable detail on demand.
//
// DATA-DRIVEN: renders NOTHING when the message carries no provenance parts
// (instance without plugins, reports disabled, old bridge) — the data itself
// is the capability signal (docs/PROVENANCE_CONTRACT.md).
//
// PAYLOAD DISCIPLINE (Codex review P2): the reactive stream only carries the
// COMPACT projection (titles/chips, no excerpts). The full reports — bounded
// to ONE message — are fetched on demand the first time the panel expands,
// and only when the compact data says there are excerpts to fetch
// (hasExcerpts). Collapsed panels cost zero extra bytes.
// Stable empty fallback: the useMessage selector runs as a useSyncExternalStore
// getSnapshot — returning a FRESH `[]` per call makes React loop ("getSnapshot
// should be cached"). One module-level constant keeps the reference stable for
// every message without provenance (optimistic echoes included).
const NO_PARTS: ProvenancePartView[] = [];

export function SourcesActivity() {
  const compactParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as { provenanceParts?: ProvenancePartView[] })
        ?.provenanceParts ?? NO_PARTS,
  );
  const messageId = useMessage(
    (msg) => (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  const [expanded, setExpanded] = useState(false);
  const wantsDetail =
    expanded &&
    messageId !== undefined &&
    compactParts.some((p) => p.hasExcerpts === true);
  const detail = useQuery(
    api.messages.getProvenanceParts,
    wantsDetail ? { messageId: messageId as Id<"messages"> } : "skip",
  ) as ProvenancePartView[] | undefined;
  // Progressive enhancement: the compact data renders the summary + the
  // expanded titles/chips instantly; excerpts swap in when the detail lands.
  const parts = detail !== undefined && detail.length > 0 ? detail : compactParts;
  if (compactParts.length === 0) return null;
  const summary = summarizeProvenance(compactParts);
  if (summary.memory + summary.documents === 0) return null;

  return (
    <div className="oc-sources">
      <button
        type="button"
        className="oc-sources__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown size={13} aria-hidden />
        ) : (
          <ChevronRight size={13} aria-hidden />
        )}
        <BookOpenText size={13} aria-hidden />
        <span className="oc-sources__label">{m.sources_label()}</span>
        <span className="oc-sources__counts">{summaryLabel(summary)}</span>
      </button>
      {expanded ? (
        <div className="oc-sources__detail">
          {orderedParts(parts).map((part, i) => (
            <section key={`${part.pluginId}-${part.group}-${i}`} className="oc-sources__group">
              <h4 className="oc-sources__group-title">
                {groupLabel(part.group)}
                <span className="oc-sources__plugin" title={part.pluginId}>
                  {part.source}
                </span>
              </h4>
              <ul className="oc-sources__items">
                {part.items.map((item, j) => (
                  <li key={j} className="oc-sources__item">
                    <div className="oc-sources__item-head">
                      <span className="oc-sources__item-title">
                        {itemTitle(item)}
                      </span>
                      {itemMeta(item).map((chip) => (
                        <span key={chip} className="oc-sources__chip">
                          {chip}
                        </span>
                      ))}
                    </div>
                    {item.text ? (
                      <blockquote className="oc-sources__excerpt">
                        {item.text}
                      </blockquote>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
