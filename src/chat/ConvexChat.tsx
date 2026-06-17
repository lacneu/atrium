import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAttachment,
  useMessage,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { APP_HOST } from "@/lib/appHost";
import type { ConvexId, ConvexMessageView } from "./convexTypes";
import {
  transcriptToMarkdown,
  transcriptToJson,
  exportFilename,
  type ExportMessage,
} from "./transcriptExport";
import {
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  ArrowUp,
  Mic,
  Trash2,
  Code,
  Search,
  CircleAlert,
  Bot,
  LoaderCircle,
  Paperclip,
  Image as ImageIcon,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { useConvexChatRuntime, type TurnGate } from "./useConvexChatRuntime";
import { uiPrefOptimisticUpdate } from "./uiPrefOptimistic";
import { deleteMessageOptimisticUpdate } from "./deleteMessageOptimistic";
import { RunStatus } from "./RunStatus";
import { ToolActivity } from "./ToolActivity";
import { SourcesActivity } from "./SourcesActivity";
import { MediaPart } from "./MediaPart";
import { MarkdownText } from "./MarkdownText";
import { FeedbackButton } from "./FeedbackDialog";
import { SessionKnobsGroup } from "./KnobRow";
import { SessionPanel } from "./SessionPanel";
import {
  capitalize,
  formatTokens,
  isOverridden,
  type SessionMetaView,
  type SessionSettingsView,
} from "./sessionKnobs";

// Top-level chat surface. Wires the reactive Convex-backed runtime into
// assistant-ui and renders the thread with custom renderers for run status,
// tool cards, and media (audio for TTS). No HTTP chat transport is used.

export interface ConvexChatProps {
  chatId: ConvexId<"chats"> | null;
}

// Effective per-user UI toggles, resolved by getMe.ui (see convex/lib/uiPrefs).
// Provided via context so the deep action-bar buttons render conditionally
// without prop-drilling through assistant-ui's message primitives.
export type UiEffective = {
  showSource: boolean;
  showReport: boolean;
  copyAssistant: boolean;
  copyUser: boolean;
  showDelete: boolean;
  showTools: boolean;
  voiceInput: boolean;
};
const DEFAULT_UI: UiEffective = {
  showSource: true,
  showReport: true,
  copyAssistant: true,
  copyUser: true,
  showDelete: true,
  showTools: true,
  voiceInput: false,
};
const UiPrefsContext = createContext<UiEffective>(DEFAULT_UI);
function useUiPrefs(): UiEffective {
  return useContext(UiPrefsContext);
}

// Imperative turn-gate handle (see useConvexChatRuntime.TurnGate): lets the
// delete-assistant flow arm the SAME thinking placeholder + composer lock a
// send uses, from inside any message row.
const TurnGateContext = createContext<TurnGate | null>(null);

export function ConvexChat({ chatId }: ConvexChatProps) {
  const { runtime, turnGate } = useConvexChatRuntime({ chatId });
  // Resolved UI preferences (reactive): the single source for which interface
  // elements render. The composer "Outils" quick toggle writes through the same
  // single path (setUiPref), so it stays consistent with the Préférences panel.
  // `showTools` semantics: whether the ToolActivity DETAIL starts expanded —
  // the summary line is always visible (no more invisible tool-heavy turns).
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const ui = (me?.ui?.effective as UiEffective | undefined) ?? DEFAULT_UI;
  const showTools = ui.showTools;
  // OPTIMISTIC (shared updater — see uiPrefOptimistic.ts): the toggle flips in the
  // local getMe cache IMMEDIATELY; the write + its getMe-invalidation cascade run
  // in the background instead of blocking the click.
  const setUiPref = useMutation(api.me.setUiPref).withOptimisticUpdate(
    uiPrefOptimisticUpdate,
  );

  // Not-found detection for a deep-linked chat. getSessionMeta returns `null` once
  // LOADED for a malformed/deleted chat (and `undefined` while still loading), so
  // `meta === null` with a chatId present means "this conversation does not exist"
  // — we render a clean in-shell message instead of an empty thread. (The backend
  // queries tolerate a malformed id via normalizeId, so this never throws.)
  const meta = useQuery(
    api.messages.getSessionMeta,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );
  const notFound = chatId !== null && meta === null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TurnGateContext.Provider value={turnGate}>
      <UiPrefsContext.Provider value={ui}>
        <div className="oc-chat">
          {chatId ? (
            notFound ? (
              <ChatNotFound />
            ) : (
              <ChatThread
                chatId={chatId}
                showTools={showTools}
                onToggleTools={() =>
                  void setUiPref({ key: "showTools", value: !showTools })
                }
              />
            )
          ) : (
            <div className="oc-empty">{m.chat_empty_select()}</div>
          )}
        </div>
      </UiPrefsContext.Provider>
      </TurnGateContext.Provider>
    </AssistantRuntimeProvider>
  );
}

// Clean, in-application "conversation not found" state for a stale/typo'd deep
// link (the backend returns not-found rather than throwing, so the user never
// sees the router's raw error screen). Stays inside the app shell (sidebar +
// top bar remain) and offers a way forward.
function ChatNotFound() {
  const navigate = useNavigate();
  return (
    <div className="oc-notfound" role="status">
      <div className="oc-notfound__icon" aria-hidden>
        <Search size={28} />
      </div>
      <h2 className="oc-notfound__title">{m.chat_notfound_title()}</h2>
      <p className="oc-notfound__body">{m.chat_notfound_body()}</p>
      <button
        type="button"
        className="oc-notfound__cta"
        onClick={() => void navigate({ to: "/" })}
      >
        <Plus size={16} aria-hidden />
        {m.chat_new_conversation()}
      </button>
    </div>
  );
}

function ChatThread({
  chatId,
  showTools,
  onToggleTools,
}: {
  chatId: ConvexId<"chats">;
  showTools: boolean;
  onToggleTools: () => void;
}) {
  // Chat availability gate: if the bridge is down/erroring (active health poll),
  // grey out the composer and show a banner BEFORE a turn is persisted — the
  // user never sends a message that cannot reach the agent. Fail-open: while
  // health is unknown (undefined / known:false) we do NOT block. The
  // failDispatch error bubble remains the backstop for a send that slips through.
  const avail = useQuery(api.bridgeHealth.getBridgeAvailability, {});
  const unavailable = avail && !avail.available ? avail : null;
  return (
    <ThreadPrimitive.Root className="oc-thread">
      <ChatHeader chatId={chatId} />
      <ThreadAnnouncer chatId={chatId} />
      <ThreadPrimitive.Viewport className="oc-thread__viewport">
        <ThreadPrimitive.Empty>
          <ThreadEmptyState />
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
            SystemMessage,
          }}
        />
      </ThreadPrimitive.Viewport>
      {/* Auto-hides (returns null) when the viewport is at the bottom; also
          suppressed on an empty thread (nothing to scroll to). */}
      <ThreadPrimitive.If empty={false}>
        <ThreadPrimitive.ScrollToBottom className="oc-scrolldown">
          <IconArrowDown />
          <span>{m.chat_latest_messages()}</span>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.If>
      {unavailable ? <BridgeUnavailableBanner /> : null}
      <Composer
        showTools={showTools}
        onToggleTools={onToggleTools}
        unavailable={unavailable !== null}
      />
    </ThreadPrimitive.Root>
  );
}

// Standardized, user-facing "chat unavailable" notice shown above a greyed-out
// composer. Generic on purpose (the technical reason is admin-only, in Settings →
// Santé / Traces); the user just needs to know not to type and to retry.
function BridgeUnavailableBanner() {
  return (
    <div className="oc-chat-banner oc-chat-banner--error" role="status">
      <CircleAlert size={16} aria-hidden />
      <span>{m.chat_unavailable_banner()}</span>
    </div>
  );
}

// Screen-reader announcement of turn COMPLETION (CHAT_UX_DESIGN a11y). The
// RunStatus chip (role="status") announces "Réflexion…"/"Erreur" but goes to null
// on complete — so without this a SR user hears the start then SILENCE. This is a
// PERSISTENT, initially-EMPTY aria-live region (mounting it WITH text suppresses
// the announcement on many SRs); it is populated with a SHORT CUE once per
// completed assistant turn (NOT the full answer — a polite region would read it
// all; the answer stays in the transcript for normal navigation).
function ThreadAnnouncer({ chatId }: { chatId: ConvexId<"chats"> }) {
  // Reuses the runtime's owner-scoped query (Convex dedupes identical args).
  const messages = useQuery(api.messages.listByChat, {
    chatId: chatId as Id<"chats">,
  }) as ConvexMessageView[] | undefined;
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedId = useRef<string | null>(null);

  // Reset the baseline when switching chats (the component is reused, not
  // remounted), so a prior chat's last turn never re-announces in the new one.
  useEffect(() => {
    lastAnnouncedId.current = null;
    setAnnouncement("");
  }, [chatId]);

  useEffect(() => {
    if (!messages) return;
    let latest: ConvexMessageView | undefined;
    for (const m of messages) if (m.role === "assistant") latest = m;
    if (!latest || latest.status !== "complete") return;
    if (lastAnnouncedId.current === null) {
      // First settled assistant turn after load/switch: adopt as baseline
      // WITHOUT announcing (it is history, not a just-arrived reply).
      lastAnnouncedId.current = latest._id;
      return;
    }
    if (lastAnnouncedId.current !== latest._id) {
      lastAnnouncedId.current = latest._id;
      // Toggle a trailing space so the textContent actually CHANGES even for a
      // second identical cue (a polite region only announces on content change).
      setAnnouncement((prev) =>
        prev === m.chat_announce_reply()
          ? `${m.chat_announce_reply()} `
          : m.chat_announce_reply(),
      );
    }
  }, [messages]);

  return (
    <div aria-live="polite" aria-atomic="true" className="oc-sr-only">
      {announcement}
    </div>
  );
}

// Empty-state (CHAT_UX_DESIGN Part 3): capability transparency + a few
// suggested prompts for the "vague prompt" conversation type. Each suggestion
// Minimal welcome — a calm avatar + prompt, NO suggestion cards (per product
// feedback: a new chat should not push canned suggestions).
function ThreadEmptyState() {
  return (
    <div className="oc-emptystate">
      <div className="oc-emptystate__avatar" aria-hidden>
        OC
      </div>
      <h2 className="oc-emptystate__title">{m.chat_empty_help()}</h2>
    </div>
  );
}

// Chat-header "spotted strip" (CHAT_UX_DESIGN.md Part 3): surfaces the OpenClaw
// session knobs as FEATURES — current model, reasoning (thinking) level with its
// inheritance hint, and the always-visible context-usage meter. Data comes from
// the gateway's self-describing `sessions.describe` (mirrored to Convex by the
// bridge), so a new model / thinking level surfaces with no frontend change.
// Read-only here; the write-back ("Advanced ▾") is a later increment. Renders
// nothing until session meta exists, so it never flashes an empty bar.
function ChatHeader({ chatId }: { chatId: ConvexId<"chats"> }) {
  // ConvexId<"chats"> is our structural string-id type; the generated arg
  // validator wants the branded Id (same cast the runtime uses for listByChat).
  const meta = useQuery(api.messages.getSessionMeta, {
    chatId: chatId as Id<"chats">,
  });
  // Which agent this conversation is bound to — surfaced ONLY when the user has
  // more than one agent (server-decided `multiAgent`), so a single-agent user
  // never sees disambiguation they don't need. Read-only: the binding is
  // write-once after the first dispatch (swapping forks the gateway session).
  const agentInfo = useQuery(api.agents.getChatAgent, {
    chatId: chatId as Id<"chats">,
  });
  const sm = (meta?.sessionMeta ?? null) as SessionMetaView | null;
  const settings = (meta?.sessionSettings ?? null) as SessionSettingsView;
  const agent = agentInfo?.multiAgent ? agentInfo.agent : null;
  // "All session settings" Sheet, opened from the popover's footer.
  const [panelOpen, setPanelOpen] = useState(false);
  // Render the strip when there is EITHER session meta OR a multi-agent chip to
  // show (a returning chat with no meta yet must still name its agent).
  if (!sm && !agent) return null;

  const pct =
    sm && sm.totalTokens != null && sm.contextTokens && sm.contextTokens > 0
      ? Math.round((sm.totalTokens / sm.contextTokens) * 100)
      : null;
  // "Spotted" meter color: calm until the context window fills, then escalates.
  const meterLevel =
    pct == null ? "" : pct >= 90 ? "is-critical" : pct >= 75 ? "is-warn" : "is-ok";
  // BINARY, intent-based provenance (CONF amendment A1): inherited = no
  // thinkingLevel key in sessionSettings. The old value-equality heuristic
  // (level === default) was wrong when overriding TO the default's value.
  const inherited = !isOverridden(settings, "thinkingLevel");

  return (
    <header className="oc-chathead">
      <div className="oc-chathead__title" title={meta?.title ?? undefined}>
        {meta?.title || m.chat_conversation_fallback()}
      </div>
      <div className="oc-chathead__meta">
        {agent ? (
          <span
            className={`oc-chip oc-chip--agent${
              agent.state !== "ok" ? " is-warn" : ""
            }`}
            title={
              m.chat_agent_of_conversation({
                name: agent.displayName ?? agent.agentId,
              }) +
              (agent.inheritedDefault ? m.chat_agent_default_suffix() : "") +
              (agent.state === "deleted"
                ? m.chat_agent_deleted_suffix()
                : agent.state === "stale"
                  ? m.chat_agent_stale_suffix()
                  : "")
            }
          >
            {agent.emoji ? (
              <span className="oc-chip__emoji" aria-hidden>
                {agent.emoji}
              </span>
            ) : (
              <Bot size={13} aria-hidden />
            )}
            {agent.displayName ?? agent.agentId}
          </span>
        ) : null}
        {sm?.model ? (
          <span
            className="oc-chip"
            title={
              sm.modelProvider
                ? m.chat_model_with_provider({ provider: sm.modelProvider })
                : m.chat_model()
            }
          >
            <IconCpu />
            {sm.model}
          </span>
        ) : null}
        {sm?.thinkingLevel ? (
          <span
            className="oc-chip"
            title={
              inherited
                ? m.chat_thinking_inherited_title()
                : m.chat_thinking_specific_title()
            }
          >
            <IconBrain />
            {m.chat_thinking_label()}&nbsp;: {capitalize(sm.thinkingLevel)}
            {inherited ? (
              <span className="oc-chip__hint">{m.chat_thinking_inherited_hint()}</span>
            ) : null}
          </span>
        ) : null}
        {sm && pct != null ? (
          <span
            className={`oc-meter ${meterLevel}`}
            title={m.chat_context_used({
              pct,
              used: formatTokens(sm.totalTokens as number),
              total: formatTokens(sm.contextTokens as number),
            })}
          >
            <span className="oc-meter__track">
              <span
                className="oc-meter__fill"
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </span>
            <span className="oc-meter__label">
              {pct}% · {formatTokens(sm.totalTokens as number)}/
              {formatTokens(sm.contextTokens as number)}
            </span>
          </span>
        ) : null}
        <ExportMenu chatId={chatId} title={meta?.title ?? null} />
        {sm ? (
          <SessionKnobsMenu
            chatId={chatId}
            sm={sm}
            settings={settings}
            onOpenPanel={() => setPanelOpen(true)}
          />
        ) : null}
      </div>
      <SessionPanel
        chatId={chatId}
        open={panelOpen}
        onOpenChange={setPanelOpen}
      />
    </header>
  );
}

// Trigger a client-side file download from in-memory text (no server round-trip
// beyond the owner-scoped query that produced it).
function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Export the current transcript as Markdown or JSON. Reads the owner-scoped
// `listByChat` query imperatively on click (bounded to the 200-message window);
// when that cap is hit the serialized file carries an EXPLICIT truncation marker
// (a silent drop of older turns would betray "the transcript"). Serialization is
// the pure, unit-tested `transcriptTo*`. PHI: never logged — this is a
// user-initiated download of the user's OWN data.
function ExportMenu({
  chatId,
  title,
}: {
  chatId: ConvexId<"chats">;
  title: string | null;
}) {
  const convex = useConvex();

  async function run(format: "md" | "json"): Promise<void> {
    const rows = (await convex.query(api.messages.listByChat, {
      chatId: chatId as Id<"chats">,
    })) as ConvexMessageView[];
    const messages: ExportMessage[] = rows.map((m) => ({
      role: m.role,
      text: m.text,
      createdAt: m.updatedAt ?? m._creationTime,
      parts: m.parts.map((p) => ({
        kind: p.kind,
        filename: "filename" in p ? p.filename : undefined,
        name: "name" in p ? p.name : undefined,
      })),
    }));
    // 200 = MESSAGE_WINDOW; a full window means older messages may be omitted.
    const truncated = rows.length >= 200;
    const opts = { title: title ?? undefined, truncated, exportedAt: Date.now() };
    const stem = exportFilename(title);
    if (format === "md") {
      downloadText(transcriptToMarkdown(messages, opts), `${stem}.md`, "text/markdown");
    } else {
      downloadText(transcriptToJson(messages, opts), `${stem}.json`, "application/json");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="oc-chip oc-chip--btn" title={m.chat_export_conversation()}>
          <Download size={13} aria-hidden />
          {m.chat_export()}
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{m.chat_export()}</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => void run("md")}>{m.chat_export_markdown()}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run("json")}>{m.chat_export_json()}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// "Advanced" write-back popover (CONF-4a): the daily session knobs (model,
// reasoning, speed) rendered by the SAME SessionKnobsGroup the session panel
// mounts (amendment A11: one implementation). A real Popover (not a menu): the
// segmented controls are adjusted repeatedly without the surface closing. The
// applied value is pushed IMMEDIATELY by the bridge (sessions.patch) and the
// live `sessionMeta` refreshes, so the controls reflect the gateway's real
// state, never an optimistic guess. ↺ per row = explicit gateway unset (A2,
// bench-lifted) — never a patch-to-default-value fake override. `verboseLevel`
// is intentionally NOT exposed (pinned by the bridge; read-only row in the
// session panel). Footer opens the all-session-settings Sheet — the
// 2nd and LAST disclosure level.
function SessionKnobsMenu({
  chatId,
  sm,
  settings,
  onOpenPanel,
}: {
  chatId: ConvexId<"chats">;
  sm: SessionMetaView;
  settings: SessionSettingsView;
  onOpenPanel: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="oc-chip oc-chip--btn" title={m.chat_advanced_settings_title()}>
          <SlidersHorizontal size={13} aria-hidden />
          {m.chat_advanced()}
          <ChevronDown size={13} className="oc-chip__chev" aria-hidden />
        </button>
      </PopoverTrigger>
      {/* w-80/p-2 go through tw-merge (they MUST beat the component's w-72/p-4;
          relying on stylesheet cascade order against utilities is not safe). */}
      <PopoverContent align="end" className="oc-spanel-pop w-80 p-2">
        <SessionKnobsGroup chatId={chatId} sm={sm} settings={settings} />
        <button
          type="button"
          className="oc-spanel-pop__all"
          onClick={() => {
            setOpen(false);
            onOpenPanel();
          }}
        >
          <SlidersHorizontal size={13} aria-hidden />
          {m.conf_all_settings()}
          <ChevronRight size={13} aria-hidden />
        </button>
      </PopoverContent>
    </Popover>
  );
}

// Inline Lucide-style icons (no emoji, no extra dep). 16px, currentColor.
function IconCpu() {
  return (
    <svg
      className="oc-chip__icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  );
}

function IconBrain() {
  return (
    <svg
      className="oc-chip__icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

// Shared 16px inline-SVG icon (Lucide geometry, currentColor) for the buttons.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconArrowDown() {
  return (
    <Icon>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Icon>
  );
}

function IconCopy() {
  return (
    <Icon>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

function IconCheck() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

// Component overrides for MessagePrimitive.Parts (assistant-ui 0.14):
//   - file parts (media + attachments) -> MediaPart
// Tool calls no longer flow through content (convertMessage diverts them to
// metadata.custom.toolParts, rendered by ToolActivity above the body), so no
// tools.Fallback mapping is needed. Typed loosely at this seam: our MediaPart
// accepts the structural props assistant-ui passes; the exact exported
// component types shifted in 0.14.
//
// Assistant turns ALSO override Text -> MarkdownText (GFM rendering). User and
// system turns intentionally do NOT: a user's literal input must not be
// reinterpreted as markdown (typing `*foo*` must stay `*foo*`), so they keep the
// default plain-text renderer.
const plainComponents = {
  File: MediaPart as never,
};
const assistantComponents = {
  ...plainComponents,
  Text: MarkdownText,
};

// User turn: a subtle, low-contrast bubble aligned right (Open WebUI style).
// Uses --muted (light grey in light, elevated grey in dark) instead of the
// high-contrast --primary, so it never flips to a tiring solid white/black.
// Per-message delete. Reads the Convex message id from metadata (authoritative,
// set in convertMessage) and calls deleteMessage. Truncate-forward semantics live
// in the mutation: deleting an assistant turn regenerates the last user turn;
// deleting a user turn removes it + all following. The cascade is destructive +
// has no undo, so the user-message variant confirms first.
function DeleteMessageButton({ kind }: { kind: "user" | "assistant" }) {
  const messageId = useMessage(
    (m) => (m.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  // OPTIMISTIC truncation (perceived performance, same science as the send
  // echo): the deleted turn — and everything after it — vanishes on the NEXT
  // FRAME; Convex swaps in the server truth on commit and rolls back on error.
  const del = useMutation(api.messages.deleteMessage).withOptimisticUpdate(
    deleteMessageOptimisticUpdate,
  );
  // Styled, promise-based confirm (radix AlertDialog) — replaces window.confirm.
  // BOTH roles confirm (the action is destructive either way), with copy that
  // matches the actual behavior: user = cascade, assistant = delete + regenerate.
  const confirm = useConfirm();
  const toast = useToast();
  const turnGate = useContext(TurnGateContext);
  // In-flight latch: blocks a double-fire and feeds the button's spinner state
  // (visible system status — the optimistic paths make the window tiny, but the
  // affordance must exist for the slow/failure cases).
  const [busy, setBusy] = useState(false);
  if (!messageId) return null;

  async function onDelete(): Promise<void> {
    const ok = await confirm(
      kind === "assistant"
        ? {
            title: m.chat_delete_assistant_title(),
            description: m.chat_delete_assistant_desc(),
            confirmLabel: m.chat_regenerate(),
            cancelLabel: m.chat_cancel(),
            destructive: true,
          }
        : {
            title: m.chat_delete_user_title(),
            description: m.chat_delete_user_desc(),
            confirmLabel: m.chat_delete(),
            cancelLabel: m.chat_cancel(),
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    // Assistant delete = regenerate: arm the in-flight gate THIS FRAME so the
    // thinking placeholder + composer lock engage instantly, exactly like a
    // send. The reactive machinery clears it when the regenerated reply (or its
    // failDispatch error bubble) lands.
    if (kind === "assistant") turnGate?.begin();
    try {
      await del({ messageId: messageId as Id<"messages"> });
    } catch (err) {
      // Convex already rolled the optimistic truncation back (the messages
      // visibly snap back). Release the gate — no reply will arrive to clear it
      // — and SAY WHY (e.g. the "wait for the reply to settle" guard). The old
      // `void` fire-and-forget swallowed this entirely.
      if (kind === "assistant") turnGate?.cancel();
      toast.error(m.chat_delete_error(), err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="oc-iconbtn oc-iconbtn--danger"
      title={
        kind === "assistant"
          ? m.chat_delete_assistant_btn_title()
          : m.chat_delete_user_btn_title()
      }
      aria-label={m.chat_delete_message_aria()}
      aria-busy={busy}
      disabled={busy}
      onClick={() => void onDelete()}
    >
      {busy ? (
        <LoaderCircle size={15} className="oc-iconbtn__spin" aria-hidden />
      ) : (
        <Trash2 size={15} aria-hidden />
      )}
    </button>
  );
}

// "Source" view: the EXACT stored text, verbatim — no markdown, no autocorrect,
// no transformation of any kind. This is the convention-free trust guarantee:
// for a USER turn it's exactly what was typed/sent; for an ASSISTANT turn it's
// the gateway's final text (our pipeline leaves prose byte-identical — only
// server paths are stripped for security; see bridge/sanitize.ts). It lets a
// user verify a word was not silently changed by autocorrect or by rendering.
function MessageSource() {
  const raw = useMessage(
    (m) => (m.metadata?.custom as { rawText?: string } | undefined)?.rawText ?? "",
  );
  const [copied, setCopied] = useState(false);
  // Count CODE POINTS, not UTF-16 units (`.length`), so an emoji / non-BMP char
  // does not inflate the count — the number must be trustworthy.
  const codePoints = [...raw].length;
  return (
    <div className="oc-msg__source">
      <div className="oc-msg__source-head">
        <span className="oc-msg__source-label">
          {codePoints > 1
            ? m.chat_source_label_plural({ count: codePoints })
            : m.chat_source_label({ count: codePoints })}
        </span>
        <button
          type="button"
          className="oc-iconbtn"
          title={m.chat_copy_source()}
          aria-label={m.chat_copy_source()}
          onClick={() => {
            void navigator.clipboard?.writeText(raw).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <pre className="oc-msg__source-pre">{raw.length > 0 ? raw : m.chat_source_empty()}</pre>
    </div>
  );
}

// Toggle between the rendered message and its raw source.
function SourceToggleButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`oc-iconbtn${active ? " is-on" : ""}`}
      onClick={onToggle}
      aria-pressed={active}
      title={active ? m.chat_show_rendered() : m.chat_show_source()}
      aria-label={m.chat_show_source_aria()}
    >
      <Code size={15} aria-hidden />
    </button>
  );
}

// User turn: subtle right-aligned bubble + a hover/last-visible action bar with a
// delete (deleting a user turn removes it + every following turn — confirmed).
function UserMessage() {
  const [showSource, setShowSource] = useState(false);
  const ui = useUiPrefs();
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--user">
      <div className="oc-msg__col oc-msg__col--user">
        <div className="oc-msg__bubble">
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={plainComponents} />
          )}
        </div>
        <ActionBarPrimitive.Root
          className="oc-msg__actions oc-msg__actions--user"
          hideWhenRunning
          autohide="not-last"
        >
          {ui.copyUser ? (
            <ActionBarPrimitive.Copy className="oc-iconbtn" title={m.chat_copy_message()}>
              <MessagePrimitive.If copied>
                <IconCheck />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <IconCopy />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          ) : null}
          {ui.showSource ? (
            <SourceToggleButton
              active={showSource}
              onToggle={() => setShowSource((s) => !s)}
            />
          ) : null}
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="user" /> : null}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

// Assistant turn: NO background bubble — content sits on the page background and
// fills the readable column (Open WebUI style). An avatar + name header carries
// the identity; RunStatus shows the live status (and hides itself when done).
function AssistantMessage() {
  const [showSource, setShowSource] = useState(false);
  const ui = useUiPrefs();
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--assistant">
      <div className="oc-msg__avatar" aria-hidden>
        OC
      </div>
      <div className="oc-msg__col">
        <div className="oc-msg__name">OpenClaw</div>
        <div className="oc-msg__body">
          {/* Grouped tool activity (summary + collapsible ToolCards), BEFORE the
              body so the streamed text always lands below it, in view of the
              bottom-following auto-scroll. Initial detail state follows the
              showTools pref; the summary line renders regardless. */}
          <ToolActivity defaultExpanded={ui.showTools} />
          {showSource ? (
            <MessageSource />
          ) : (
            <MessagePrimitive.Parts components={assistantComponents} />
          )}
          {/* "Sources" (provenance/v1): what memory/document plugins fed the
              LLM this turn. Data-driven — renders nothing without reports. */}
          <SourcesActivity />
          <RunStatus />
        </div>
        {/* Per-message actions, hidden while a turn runs + revealed on hover for
            non-last turns (always shown on the last). Copy + Delete. Deleting an
            assistant turn truncates from here and REGENERATES the last user turn
            (see messages.deleteMessage) — no confirm (recoverable). */}
        <ActionBarPrimitive.Root
          className="oc-msg__actions"
          hideWhenRunning
          autohide="not-last"
        >
          {ui.copyAssistant ? (
            <ActionBarPrimitive.Copy className="oc-iconbtn" title={m.chat_copy_response()}>
              <MessagePrimitive.If copied>
                <IconCheck />
              </MessagePrimitive.If>
              <MessagePrimitive.If copied={false}>
                <IconCopy />
              </MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          ) : null}
          {ui.showSource ? (
            <SourceToggleButton
              active={showSource}
              onToggle={() => setShowSource((s) => !s)}
            />
          ) : null}
          {ui.showReport ? <FeedbackButton /> : null}
          {ui.showDelete ? <DeleteMessageButton kind="assistant" /> : null}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage() {
  return (
    <MessagePrimitive.Root className="oc-msg oc-msg--system">
      <div className="oc-msg__body">
        <MessagePrimitive.Parts components={plainComponents} />
      </div>
    </MessagePrimitive.Root>
  );
}

// NOTE: the send->first-token "thinking" gap is filled by assistant-ui's own
// upcoming-message placeholder (it injects an assistant frame whenever the
// runtime is `isRunning` and the last message is not an assistant). That
// placeholder carries no status, so RunStatus renders it as "Réflexion…" (see
// runStatusView's `undefined` case) and hands off seamlessly to the real
// streaming doc. We deliberately do NOT render a second gap-filler frame here —
// doing so double-stacks the assistant avatar/name during every gap.

// Composer attachment chip (BUG-2 fix). Without an `Attachment` component
// passed to <ComposerPrimitive.Attachments>, assistant-ui's getComponent
// returns undefined for every attachment type and renders NOTHING — so a
// selected file was added to the composer state but stayed INVISIBLE (no chip,
// no upload status, no error surfaced): "the import does nothing, no trace".
// This chip restores the missing feedback for ALL types (images + documents):
// an icon, the filename, the live upload status, and a remove button.
function ComposerAttachmentChip() {
  const status = useAttachment((a) => a.status?.type);
  const type = useAttachment((a) => a.type);
  // A composer attachment is "pending" (status "running") between selection and
  // message-send: the upload is deferred to composer.send() (assistant-ui calls
  // adapter.send() then), so the chip is NOT actively uploading here — showing
  // "envoi…" persistently would lie. The chip's presence + filename IS the
  // feedback (the bug was that NO chip rendered at all). Only a genuine failure
  // ("incomplete") surfaces a state, so an upload error is never silent.
  const failed = status === "incomplete";
  return (
    <AttachmentPrimitive.Root
      className={`oc-attach${failed ? " oc-attach--error" : ""}`}
      data-status={status}
    >
      <span className="oc-attach__icon" aria-hidden>
        {failed ? (
          <CircleAlert size={14} />
        ) : type === "image" ? (
          <ImageIcon size={14} />
        ) : (
          <Paperclip size={14} />
        )}
      </span>
      <span className="oc-attach__name">
        <AttachmentPrimitive.Name />
      </span>
      {failed ? (
        <span className="oc-attach__state">{m.chat_attach_failed()}</span>
      ) : null}
      <AttachmentPrimitive.Remove
        className="oc-attach__remove"
        aria-label={m.chat_attach_remove()}
      >
        <X size={13} aria-hidden />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function Composer({
  showTools,
  onToggleTools,
  unavailable = false,
}: {
  showTools: boolean;
  onToggleTools: () => void;
  /** Bridge down: disable input + send so no un-sendable turn is persisted. */
  unavailable?: boolean;
}) {
  // Voice-input feature flag: resolved via the UI-preferences module (gated by
  // system enablement + the user's override). The mic only renders when true.
  const voiceInput = useUiPrefs().voiceInput;
  // Unified composer card (per the design reference): the input sits ON TOP, with
  // a single action bar BELOW it — attach (+) and the tools toggle on the left,
  // the circular send (or stop while running) on the right. The CARD owns the
  // border + focus ring (`:focus-within`), so focusing the textarea never shifts
  // layout. (Voice/dictation mic intentionally omitted until the talk.* phase —
  // a non-functional control would mislead.)
  return (
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    <ComposerPrimitive.Root
      className={`oc-composer${unavailable ? " oc-composer--disabled" : ""}`}
    >
      <ComposerPrimitive.Attachments
        components={{ Attachment: ComposerAttachmentChip }}
      />
      {/* Content fidelity: disable the browser/OS conventions that MUTATE typed
          text (autocorrect, auto-capitalize, autocomplete) so a word is sent
          exactly as typed — never silently swapped at submit. `data-gramm`
          disables Grammarly. spellCheck stays ON (it underlines, it does NOT
          mutate). NB: no third-party extension is 100% controllable — the
          per-message "Source" view is the real, convention-free guarantee. */}
      <ComposerPrimitive.Input
        className="oc-composer__input"
        placeholder={
          unavailable ? m.chat_composer_unavailable() : m.chat_composer_placeholder()
        }
        autoFocus
        rows={1}
        disabled={unavailable}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
      />
      <div className="oc-composer__bar">
        <div className="oc-composer__group">
          <ComposerPrimitive.AddAttachment
            className="oc-composer__icon"
            aria-label={m.chat_attach_file()}
          >
            <Plus size={18} aria-hidden />
          </ComposerPrimitive.AddAttachment>
          <button
            type="button"
            className={`oc-composer__tools${showTools ? " is-on" : ""}`}
            onClick={onToggleTools}
            aria-pressed={showTools}
            title={
              showTools ? m.chat_tools_hide() : m.chat_tools_show()
            }
          >
            <SlidersHorizontal size={15} aria-hidden />
            {m.chat_tools()}
          </button>
        </div>
        <div className="oc-composer__group">
          {voiceInput ? (
            <button
              type="button"
              className="oc-composer__icon"
              title={m.chat_voice_soon_title()}
              aria-label={m.chat_voice_soon_aria()}
            >
              <Mic size={18} aria-hidden />
            </button>
          ) : null}
          {unavailable ? (
            // Greyed, non-clickable send: the bridge is down, so persisting a
            // turn would only produce an unanswerable message.
            <button
              type="button"
              className="oc-composer__send"
              disabled
              aria-label={m.chat_send_unavailable_aria()}
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          ) : (
            <>
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="oc-composer__send" aria-label={m.chat_send()}>
                  <ArrowUp size={18} aria-hidden />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                {/* A turn is in flight. We have no gateway-abort endpoint, so a
                    "Stop" control would be a DEAD affordance (cancel capability
                    is absent → assistant-ui renders it disabled, implying you can
                    interrupt when you can't). Show an HONEST disabled send instead
                    ("réponse en cours") — the input stays usable for type-ahead,
                    but Enter is blocked while running (assistant-ui), so this also
                    keeps the double-send hole closed. */}
                <button
                  type="button"
                  className="oc-composer__send"
                  disabled
                  aria-label={m.chat_response_in_progress()}
                  title={m.chat_response_in_progress()}
                >
                  <ArrowUp size={18} aria-hidden />
                </button>
              </ThreadPrimitive.If>
            </>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}
