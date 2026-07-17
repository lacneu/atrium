// Global conversation search — the topbar palette (⌘K / Ctrl-K). A search-box
// trigger sits in the center of the top bar; activating it opens a command
// palette that full-text searches the caller's own conversations (titles +
// message bodies) via `api.search.searchConversations` and deep-links to the
// chosen chat (`/chat/$chatId`).
//
// Built from the existing shadcn primitives (Dialog) + a hand-rolled, keyboard-
// first result list (↑/↓ to move, Enter to open, Esc to close) — no new
// dependency (cmdk), consistent with the project's minimal-deps direction.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { setPendingFocusTerms } from "./pendingFocusTerms";
import { Search, MessageSquare, Hash } from "lucide-react";
import { api } from "./convexApi";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isMac, shortcutLabel, matchesShortcut, SHORTCUT_SEARCH } from "@/lib/shortcuts";
import { m } from "@/paraglide/messages.js";

// Mirror of the backend MIN_QUERY_LEN: below this we don't even subscribe.
const MIN_QUERY_LEN = 2;
// Debounce so each keystroke doesn't open a new reactive subscription.
const DEBOUNCE_MS = 180;

export function GlobalSearch() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);

  // Platform-aware badge: ⌘K on macOS, Ctrl+K on Windows/Linux (same shortcut).
  const searchShortcut = useMemo(
    () => shortcutLabel(SHORTCUT_SEARCH, isMac()),
    [],
  );

  // Debounce the typed query into the value we actually subscribe with.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [q]);

  const term = debounced.trim();
  const results = useQuery(
    api.search.searchConversations,
    term.length >= MIN_QUERY_LEN ? { query: term } : "skip",
  );
  const list = results ?? [];
  const loading = term.length >= MIN_QUERY_LEN && results === undefined;

  // Global ⌘K / Ctrl+K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (matchesShortcut(e, SHORTCUT_SEARCH)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset transient state each time the palette opens.
  useEffect(() => {
    if (open) {
      setQ("");
      setDebounced("");
      setActive(0);
    }
  }, [open]);

  // Snap the highlight back to the top whenever the result set changes.
  useEffect(() => {
    setActive(0);
  }, [results]);

  // Keep the active row scrolled into view as it moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const select = useCallback(
    (chatId: string, messageId?: string) => {
      setOpen(false);
      // A MESSAGE hit lands the thread exactly on the matched message (?m
      // scroll+flash). The TERMS ride an ephemeral store — never the URL
      // (search terms can be sensitive; codex P1) — so their occurrences get
      // highlighted inside it. A title hit opens the chat as before.
      if (messageId && q.trim()) setPendingFocusTerms(messageId, q.trim());
      void navigate({
        to: "/chat/$chatId",
        params: { chatId },
        ...(messageId ? { search: { m: messageId } } : {}),
      });
    },
    [navigate, q],
  );

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = list[active];
      if (hit) select(hit.chatId, hit.messageId);
    }
  };

  return (
    <>
      <button
        type="button"
        className="oc-search-trigger"
        onClick={() => setOpen(true)}
        aria-label={m.search_trigger_aria()}
      >
        <Search className="oc-search-trigger__icon" aria-hidden />
        <span className="oc-search-trigger__label">{m.search_trigger_label()}</span>
        <kbd className="oc-search-trigger__kbd">{searchShortcut}</kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          // Top-anchored, wider, padding/gap removed: a command palette, not a
          // centered dialog. twMerge resolves the position/size overrides.
          className="oc-search-palette top-[12vh] translate-y-0 max-w-xl gap-0 overflow-hidden p-0"
          onOpenAutoFocus={(e) => {
            // Focus the search field rather than the first result button.
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">
            {m.search_dialog_title()}
          </DialogTitle>

          <div className="oc-search-palette__head">
            <Search className="oc-search-palette__head-icon" aria-hidden />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={m.search_input_placeholder()}
              className="oc-search-palette__field"
              autoComplete="off"
              spellCheck={false}
              aria-label={m.search_input_aria()}
            />
          </div>

          <div className="oc-search-palette__results" ref={listRef} role="listbox">
            {term.length < MIN_QUERY_LEN ? (
              <div className="oc-search-palette__hint">
                {m.search_min_length_hint({ count: MIN_QUERY_LEN })}
              </div>
            ) : loading ? (
              <div className="oc-search-palette__hint">{m.search_loading()}</div>
            ) : list.length === 0 ? (
              <div className="oc-search-palette__hint">
                {m.search_no_results({ term })}
              </div>
            ) : (
              list.map((hit, i) => (
                <button
                  key={hit.chatId}
                  type="button"
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  className={cn(
                    "oc-search-result",
                    i === active && "is-active",
                  )}
                  onMouseMove={() => setActive(i)}
                  onClick={() => select(hit.chatId, hit.messageId)}
                >
                  <span className="oc-search-result__icon" aria-hidden>
                    {hit.matchedIn === "title" ? (
                      <Hash size={15} />
                    ) : (
                      <MessageSquare size={15} />
                    )}
                  </span>
                  <span className="oc-search-result__body">
                    <span className="oc-search-result__title">
                      {hit.title || m.search_untitled_chat()}
                    </span>
                    {hit.projectPath && hit.projectPath.length > 0 ? (
                      // Folder path — situates the hit at a glance
                      // ("Client ACME › Devis").
                      <span
                        className="oc-search-result__path"
                        aria-label={m.search_result_path_aria()}
                      >
                        {hit.projectPath.join(" › ")}
                      </span>
                    ) : null}
                    {hit.snippet ? (
                      <span className="oc-search-result__snippet">
                        {hit.snippet}
                      </span>
                    ) : null}
                  </span>
                  <span className="oc-search-result__tag">
                    {hit.matchedIn === "title"
                      ? m.search_tag_title()
                      : m.search_tag_message()}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="oc-search-palette__footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> {m.search_footer_navigate()}
            </span>
            <span>
              <kbd>↵</kbd> {m.search_footer_open()}
            </span>
            <span>
              <kbd>{m.search_footer_esc_key()}</kbd> {m.search_footer_close()}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
