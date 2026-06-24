import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMessage } from "@assistant-ui/react";
import { useMutation, useQuery } from "convex/react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  LoaderCircle,
  Network,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast, errorMessage } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import type { ProvenancePartView } from "./convexTypes";
import {
  attachReference,
  entryTitle,
  hasProvenance,
  isContextExcerpt,
  isFindableDocument,
  itemMeta,
  itemSubId,
  sourceEntries,
  sourceMatchesQuery,
  summarizeProvenance,
  summaryLabel,
  type SourceEntry,
} from "./sourcesView";

// Per-message "Sources" affordance (provenance/v1): WHAT the gateway's context-
// injecting plugins (conversational memory / document RAG) fed the LLM for this
// turn. The chip (in the message) opens an INTEGRATED, resizable RIGHT COLUMN —
// not an overlay — so the conversation stays visible + interactive while the user
// reads the sources. The column lives in ConvexChat; this file owns the chip, the
// open/close context, and the panel content ConvexChat renders. The one bulk
// action is L2 "Joindre les documents" (fetch the selected documents' real files
// as downloadable links via a documentary agent).

/** Chip → column wiring. The chip lives in a message; the column in ConvexChat. */
export interface SourcesPanelApi {
  activeMessageId: string | null;
  openFor: (messageId: string) => void;
  close: () => void;
}
export const SourcesPanelContext = createContext<SourcesPanelApi | null>(null);

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
  // L2: how many downloadable source files were fetched for this reply (denormalized
  // onto the message) — shown as a subtle badge ON the existing Sources chip rather
  // than a separate recap message in the conversation.
  const attachedDocCount = useMessage(
    (msg) =>
      (msg.metadata?.custom as { attachedDocCount?: number } | undefined)
        ?.attachedDocCount ?? 0,
  );
  const panel = useContext(SourcesPanelContext);
  const summary = summarizeProvenance(compactParts);
  // Show the chip whenever ANY provenance exists — including a reply whose only
  // provenance is a synthesized CONTEXT excerpt (a LightRAG turn that returned no
  // per-file references): hasProvenance() counts context too, else that message
  // would have no way to open the panel and see its context source.
  if (compactParts.length === 0 || !hasProvenance(summary)) {
    return null;
  }
  const isActive = panel?.activeMessageId === messageId && messageId !== undefined;
  return (
    <button
      type="button"
      className={`oc-sources-trigger${isActive ? " is-active" : ""}`}
      onClick={() => messageId && panel?.openFor(messageId)}
      aria-haspopup="dialog"
      aria-expanded={isActive}
      aria-label={m.sources_trigger_aria()}
    >
      <FileText size={13} className="oc-sources-trigger__icon" aria-hidden />
      <span className="oc-sources-trigger__label">{m.sources_label()}</span>
      <span className="oc-sources-trigger__counts">{summaryLabel(summary)}</span>
      {attachedDocCount > 0 ? (
        <span
          className="oc-sources-trigger__attached"
          title={m.sources_attached_badge({ count: attachedDocCount })}
        >
          <Download size={12} aria-hidden />
          {attachedDocCount}
        </span>
      ) : null}
      <ChevronRight size={14} className="oc-sources-trigger__chev" aria-hidden />
    </button>
  );
}

/**
 * The panel content — rendered by ConvexChat inside the resizable right COLUMN
 * (desktop) or a Sheet (mobile). Owns search / collapsible sections / multi-
 * select / "Approfondir". Reads the FULL reports (with excerpts) on demand.
 */
export function SourcesPanelContent({
  messageId,
  onClose,
}: {
  messageId: string;
  onClose: () => void;
}) {
  const detail = useQuery(api.messages.getProvenanceParts, {
    messageId: messageId as Id<"messages">,
  }) as ProvenancePartView[] | undefined;
  const parts = useMemo(() => detail ?? [], [detail]);

  // L2 "Joindre les documents": availability gate (a granted documentary agent) +
  // the per-reference attachment state (download links, pending, not-found).
  const docAvail = useQuery(api.agents.documentaryAvailable, {}) as
    | { displayName: string }
    | null
    | undefined;
  const attachments = useQuery(api.documentAttachments.getDocumentAttachments, {
    sourceMessageId: messageId as Id<"messages">,
  }) as
    | Array<{
        entryKey: string;
        reference: string;
        status: "pending" | "ready" | "not_found" | "failed";
        url: string | null;
        filename: string | null;
      }>
    | undefined;
  const attach = useMutation(api.documentAttachments.attachDocuments);
  const toast = useToast();
  // Keyed by the source card's UNIQUE entryKey (not file_name) so only the cards the
  // user actually checked light up — an unchecked duplicate or a sibling chunk of the
  // same file never does.
  const attachmentByKey = useMemo(() => {
    const map = new Map<string, NonNullable<typeof attachments>[number]>();
    for (const a of attachments ?? []) map.set(a.entryKey, a);
    return map;
  }, [attachments]);
  const fetchInFlight = (attachments ?? []).some((a) => a.status === "pending");

  const [query, setQuery] = useState("");
  // Both sections COLLAPSED by default (progressive disclosure). DOCUMENTS first.
  const [openDocs, setOpenDocs] = useState(false);
  const [openContext, setOpenContext] = useState(false);
  const [openMem, setOpenMem] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Reset transient UI when the panel switches to another message.
  useEffect(() => {
    setQuery("");
    setOpenDocs(false);
    setOpenContext(false);
    setOpenMem(false);
    setSelected(new Set());
  }, [messageId]);

  // Documents split: FINDABLE sources (file_name → openable/attachable) vs
  // synthesized CONTEXT excerpts (no file_name, e.g. LightRAG's whole-graph blob)
  // shown for transparency but never attachable (the attach would send a non-file
  // reference like "lightrag-context" the documentary agent can never resolve).
  const docEntries = useMemo(
    () =>
      sourceEntries(parts, "documents").filter(
        (e) => isFindableDocument(e) && sourceMatchesQuery(e, query),
      ),
    [parts, query],
  );
  const contextEntries = useMemo(
    () =>
      sourceEntries(parts, "documents").filter(
        (e) => isContextExcerpt(e) && sourceMatchesQuery(e, query),
      ),
    [parts, query],
  );
  const memEntries = useMemo(
    () => sourceEntries(parts, "memory").filter((e) => sourceMatchesQuery(e, query)),
    [parts, query],
  );
  const summary = summarizeProvenance(parts);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const setMany = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  // Selection is DOCUMENT-only: the single bulk action is "Joindre les documents"
  // (memory sources have no fetchable file, so memory cards render no checkbox and
  // `selected` only ever holds document keys). The reference handed to the documentary
  // agent is the item's `file_name` — the STABLE retrieval key (e.g. the gdrive id) the
  // server's attach gate allows — NOT the human `title` (which is display-only).
  const selectedDocs = useMemo(
    () =>
      sourceEntries(parts, "documents").filter(
        (e) => isFindableDocument(e) && selected.has(e.key),
      ),
    [parts, selected],
  );
  const canAttach = docAvail != null && selectedDocs.length > 0 && !fetchInFlight;
  async function attachSelectedDocuments() {
    if (!canAttach) return;
    // The mutation can throw on a REACHABLE race: the global per-user fetch lock
    // (`fetch_in_flight`, when this panel sits on a different message than an
    // in-flight fetch) or a documentary agent revoked since `docAvail` resolved
    // (`no_documentary_agent`). Surface it — a silent `void` swallow on the
    // primary action is the exact failure this feature exists to prevent.
    try {
      await attach({
        sourceMessageId: messageId as Id<"messages">,
        items: selectedDocs.map((e) => ({
          entryKey: e.key,
          // The retrieval key the server allows (file_name), never the display title.
          reference: attachReference(e.item),
        })),
      });
      toast.success(m.sources_attach_dispatched());
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.includes("fetch_in_flight")) toast.error(m.sources_attach_inflight());
      else if (msg.includes("no_documentary_agent")) toast.error(m.sources_attach_none());
      else toast.error(m.sources_attach_error(), e);
    }
  }

  const loading = detail === undefined;

  return (
    <div className="oc-sources-panel">
      <div className="oc-sources-panel__head">
        <div className="oc-sources-panel__heading">
          <h2 className="oc-sources-panel__title">{m.sources_panel_title()}</h2>
          <p className="oc-sources-panel__sub">{summaryLabel(summary)}</p>
        </div>
        <button
          type="button"
          className="oc-iconbtn"
          onClick={onClose}
          aria-label={m.sources_close()}
          title={m.sources_close()}
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="oc-sources-panel__search">
        <Search size={15} aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={m.sources_search_placeholder()}
          aria-label={m.sources_search_placeholder()}
        />
      </div>

      <div className="oc-sources-panel__body">
        {loading ? (
          <p className="oc-sources-panel__empty">
            <LoaderCircle size={14} className="oc-iconbtn__spin" aria-hidden />
          </p>
        ) : (
          <>
            <SourceSection
              icon={<FileText size={14} aria-hidden />}
              label={m.sources_group_documents()}
              count={docEntries.length}
              expanded={openDocs}
              onToggle={() => setOpenDocs((o) => !o)}
              entries={docEntries}
              selectable
              selected={selected}
              onToggle1={toggle}
              onToggleAll={(on) => setMany(docEntries.map((e) => e.key), on)}
              attachmentByKey={attachmentByKey}
            />
            <SourceSection
              icon={<Network size={14} aria-hidden />}
              label={m.sources_group_context()}
              count={contextEntries.length}
              expanded={openContext}
              onToggle={() => setOpenContext((o) => !o)}
              entries={contextEntries}
              selectable={false}
              selected={selected}
              onToggle1={toggle}
              onToggleAll={(on) => setMany(contextEntries.map((e) => e.key), on)}
              attachmentByKey={attachmentByKey}
            />
            <SourceSection
              icon={<Brain size={14} aria-hidden />}
              label={m.sources_group_memory()}
              count={memEntries.length}
              expanded={openMem}
              onToggle={() => setOpenMem((o) => !o)}
              entries={memEntries}
              selectable={false}
              selected={selected}
              onToggle1={toggle}
              onToggleAll={(on) => setMany(memEntries.map((e) => e.key), on)}
              attachmentByKey={attachmentByKey}
            />
            {docEntries.length === 0 &&
            contextEntries.length === 0 &&
            memEntries.length === 0 ? (
              <p className="oc-sources-panel__empty">{m.sources_no_results()}</p>
            ) : null}
          </>
        )}
      </div>

      {selectedDocs.length > 0 ? (
        <div className="oc-sources-panel__actions">
          <div className="oc-sources-panel__actrow">
            <span className="oc-sources-panel__selcount">
              {m.sources_selected_count({ count: selectedDocs.length })}
            </span>
            {/* L2 (the only bulk action): ask a documentary agent to fetch the
                selected documents' real files -> downloadable links in each card's
                "Source d'origine" slot. */}
            <Button
              variant="outline"
              size="sm"
              disabled={!canAttach}
              onClick={() => void attachSelectedDocuments()}
            >
              {fetchInFlight ? (
                <LoaderCircle size={14} className="oc-iconbtn__spin" aria-hidden />
              ) : (
                <Sparkles size={14} aria-hidden />
              )}
              {m.sources_attach()}
            </Button>
          </div>
          {/* Inline, ALWAYS-visible status: explains what the action does, and why
              it is disabled (no documentary agent / a fetch already running). */}
          <p className="oc-sources-panel__acthint">
            {docAvail == null
              ? m.sources_attach_none()
              : fetchInFlight
                ? m.sources_attach_inflight()
                : m.sources_attach_help()}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Per-CARD L2 attachment state (downloadable source file), keyed by entryKey. */
type DocAttachment = {
  entryKey: string;
  reference: string;
  status: "pending" | "ready" | "not_found" | "failed";
  url: string | null;
  filename: string | null;
};

function SourceSection({
  icon,
  label,
  count,
  expanded,
  onToggle,
  entries,
  selectable,
  selected,
  onToggle1,
  onToggleAll,
  attachmentByKey,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  entries: SourceEntry[];
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggle1: (key: string) => void;
  onToggleAll: (on: boolean) => void;
  attachmentByKey: ReadonlyMap<string, DocAttachment>;
}) {
  if (count === 0) return null;
  const allSelected = entries.every((e) => selected.has(e.key));
  return (
    <section className={`oc-srcsec${expanded ? " is-open" : ""}`}>
      <button
        type="button"
        className="oc-srcsec__head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronRight size={14} aria-hidden />
        )}
        {icon}
        <span className="oc-srcsec__label">{label}</span>
        <span className="oc-srcsec__count">{count}</span>
      </button>
      {expanded ? (
        <div className="oc-srcsec__body">
          {selectable ? (
            <label className="oc-srcsec__all">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => onToggleAll(v === true)}
              />
              <span>{m.sources_select_all()}</span>
            </label>
          ) : null}
          {entries.map((entry) => (
            <SourceCard
              key={entry.key}
              entry={entry}
              selectable={selectable}
              selected={selected.has(entry.key)}
              onToggle={() => onToggle1(entry.key)}
              attachment={attachmentByKey.get(entry.key)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SourceCard({
  entry,
  selectable,
  selected,
  onToggle,
  attachment,
}: {
  entry: SourceEntry;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  attachment?: DocAttachment;
}) {
  const [showFull, setShowFull] = useState(false);
  // "Voir plus" appears ONLY when the excerpt is actually clamped. Measured (no
  // CSS signal) + re-measured on resize, because the column is resizable so a
  // width change can truncate / un-truncate the text.
  const excerptRef = useRef<HTMLQuoteElement>(null);
  const [clamped, setClamped] = useState(false);
  const { item } = entry;
  useEffect(() => {
    const el = excerptRef.current;
    if (!el) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.text]);

  const meta = itemMeta(item);
  const score = typeof item.score === "number" ? Math.max(0, Math.min(1, item.score)) : null;
  // Only a FINDABLE document (file_name) gets the "Source d'origine" slot — a
  // context excerpt has no external source file to open/attach.
  const isDocument = isFindableDocument(entry);
  return (
    <div className={`oc-srccard${selectable && selected ? " is-selected" : ""}`}>
      {selectable ? (
        <label className="oc-srccard__pick">
          <Checkbox checked={selected} onCheckedChange={onToggle} />
        </label>
      ) : null}
      <div className="oc-srccard__body">
        <div className="oc-srccard__title">{entryTitle(entry)}</div>
        {isDocument && itemSubId(entry.item) ? (
          // The stable underlying reference (e.g. the gdrive id) kept visible under the
          // human title, so the user sees — and can search/cite — the real document ref.
          // Only for a FINDABLE document — never a context excerpt (whose file_name is
          // not an openable/citable ref even if a title is present).
          <div className="oc-srccard__subid" title={itemSubId(entry.item)}>
            {itemSubId(entry.item)}
          </div>
        ) : null}
        {meta.length > 0 || score !== null ? (
          <div className="oc-srccard__meta">
            {meta.map((chip) => (
              <span key={chip} className="oc-srccard__chip">
                {chip}
              </span>
            ))}
            {score !== null ? (
              <span className="oc-srccard__relev" title={m.sources_score({ score: score.toFixed(2) })}>
                <span className="oc-srccard__relev-track" aria-hidden>
                  <span
                    className="oc-srccard__relev-fill"
                    style={{ width: `${Math.round(score * 100)}%` }}
                  />
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
        {item.text ? (
          <>
            <blockquote
              ref={excerptRef}
              className={`oc-srccard__excerpt${showFull ? " is-full" : ""}`}
            >
              {item.text}
            </blockquote>
            {clamped || showFull ? (
              <button
                type="button"
                className="oc-srccard__more"
                onClick={() => setShowFull((s) => !s)}
              >
                {showFull ? m.sources_excerpt_less() : m.sources_excerpt_more()}
              </button>
            ) : null}
          </>
        ) : null}
        {isDocument ? (
          // ASYMMETRY: a document has a real external referent -> a reserved
          // "original source" slot. L2 fills it with the fetched file's state:
          // a download link when ready, a spinner while fetching, a muted note
          // when the agent could not resolve the reference.
          <DocOriginSlot attachment={attachment} />
        ) : null}
      </div>
    </div>
  );
}

/** The per-document "original source" slot, rendered by fetch state. */
function DocOriginSlot({ attachment }: { attachment?: DocAttachment }) {
  if (attachment?.status === "ready" && attachment.url) {
    const label = attachment.filename ?? m.sources_origin_ready();
    return (
      <a
        className="oc-srccard__origin oc-srccard__origin--ready"
        href={attachment.url}
        download={attachment.filename ?? undefined}
        target="_blank"
        rel="noreferrer"
        title={m.sources_origin_ready()}
      >
        <Download size={13} aria-hidden />
        <span className="oc-srccard__origin-name">{label}</span>
      </a>
    );
  }
  if (attachment?.status === "pending") {
    return (
      <div className="oc-srccard__origin oc-srccard__origin--pending">
        <LoaderCircle size={13} aria-hidden />
        {m.sources_origin_pending()}
      </div>
    );
  }
  if (attachment?.status === "not_found" || attachment?.status === "failed") {
    return (
      <div className="oc-srccard__origin oc-srccard__origin--missing" aria-disabled>
        <X size={13} aria-hidden />
        {m.sources_origin_notfound()}
      </div>
    );
  }
  // No fetch requested yet for this document: a muted, reserved placeholder.
  return (
    <div className="oc-srccard__origin" aria-disabled>
      <Download size={13} aria-hidden />
      {m.sources_origin()}
    </div>
  );
}
