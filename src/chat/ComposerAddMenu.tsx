// The composer's "+" — a MENU: add a file, add an image (both through the composer's own
// attachment pipeline, so the adapter's size limits and its toasts apply unchanged), and
// the "Connaissances" section: which knowledge sources the agent the next message goes
// to will search (convex/knowledge.ts). Every decision lives in knowledgeView.ts (pure,
// unit-tested); this file renders it and sends the owner's pick.
//
// Same primitives and option rows as the composer's siblings (PermissionModePicker): a
// shadcn DropdownMenu, `oc-perm__*` rows.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { useComposerRuntime } from "@assistant-ui/react";
import { Check, FileUp, ImagePlus, LayoutTemplate, Lock, Plus, RotateCcw } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import type { KnowledgeChoice } from "../../convex/lib/knowledge";
import { IMAGE_PICKER_ACCEPT as IMAGE_ACCEPT } from "./attachmentAdapter";
import { useConversationWidgets } from "./widgets/useConversationWidgets";
import {
  knowledgeReasonText,
  knowledgeTargetKey,
  knowledgeView,
  pendingChoiceFor,
  pendingOnDone,
  pendingOnPick,
  pendingOnServer,
  toggledChoice,
  withPending,
  type KnowledgeControlData,
  type PendingKnowledgeChoices,
} from "./knowledgeView";

export function ComposerAddMenu({
  chatId,
  routedAgent,
  attachmentsSupported,
  attachDisabled,
}: {
  chatId: ConvexId<"chats"> | null;
  /** The agent the next message goes to (null = the chat's own resolution). */
  routedAgent: { instanceName: string; agentId: string } | null;
  /** The target takes inbound files at all (Hermes REST does not). */
  attachmentsSupported: boolean;
  /** Queued follow-ups are text-only, an unavailable composer takes nothing. */
  attachDisabled: boolean;
}) {
  const composer = useComposerRuntime();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const control = useQuery(
    api.knowledge.knowledgeControl,
    chatId === null
      ? "skip"
      : {
          chatId: chatId as Id<"chats">,
          ...(routedAgent ? { routedAgent } : {}),
        },
  ) as KnowledgeControlData | null | undefined;
  const setChoice = useMutation(api.knowledge.setKnowledgeChoice);
  // The owner's latest choice PER TARGET AGENT, until the server reflects it
  // (knowledgeView.ts, "Quick toggles" and "Pending choices, per target agent"): every
  // toggle starts from it and the section shows it at once. A switch to another agent
  // keeps it; a mutation settles only its own target's entry.
  const targetKey = control == null ? "" : knowledgeTargetKey(control.target);
  const [pending, setPending] = useState<PendingKnowledgeChoices>({});
  // Pick numbers per target, outside React state: a mutation must know its own.
  const picks = useRef(new Map<string, number>());
  const visibleKey = useRef(targetKey);
  visibleKey.current = targetKey;
  const pendingChoice = pendingChoiceFor(pending, targetKey);
  const serverChoice = control?.choice ?? null;
  useEffect(() => {
    if (control == null) return;
    // Returns the same map when nothing settles, so this does not loop.
    setPending((cur) => pendingOnServer(cur, targetKey, serverChoice));
  }, [control, serverChoice, targetKey, pending]);
  const shown = control == null ? control : withPending(control, pendingChoice);
  const view = knowledgeView(shown);
  const widgets = useConversationWidgets(chatId);

  const onFiles = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      // Reset first: picking the same file twice must fire `change` again.
      e.target.value = "";
      for (const file of files) {
        // The adapter already tells the user why a file was refused (its own toast):
        // a rejection here needs nothing more.
        void composer.addAttachment(file).catch(() => {});
      }
    },
    [composer],
  );

  const pick = useCallback(
    (choice: KnowledgeChoice) => {
      if (control == null) return;
      const key = knowledgeTargetKey(control.target);
      const gen = (picks.current.get(key) ?? 0) + 1;
      picks.current.set(key, gen);
      setPending((cur) => pendingOnPick(cur, key, choice, gen));
      void setChoice({
        chatId: chatId as Id<"chats">,
        instanceName: control.target.instanceName,
        agentId: control.target.agentId,
        choice,
      })
        .then(() => setPending((cur) => pendingOnDone(cur, key, gen, true, visibleKey.current)))
        .catch((err: unknown) => {
          // The server kept its state for THIS target: show it again, not the refused
          // choice — and leave every other target's pending choice alone.
          setPending((cur) => pendingOnDone(cur, key, gen, false, visibleKey.current));
          const reason = /overrides_disabled|source_not_allowed|unavailable|not_openclaw/.exec(
            String((err as Error)?.message ?? ""),
          )?.[0];
          toast.error(
            m.chat_knowledge_set_failed({
              reason: knowledgeReasonText(reason === "unavailable" ? "plugin_absent" : reason),
            }),
            err,
          );
        });
    },
    [chatId, control, setChoice, toast],
  );

  if (!attachmentsSupported && view.hidden && !widgets.offered) return null;
  const editable = view.readOnlyReason === null;
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={onFiles}
        data-testid="composer-add-file-input"
      />
      <input
        ref={imageInput}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={onFiles}
        data-testid="composer-add-image-input"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="oc-composer__icon"
            aria-label={m.chat_add_menu()}
            title={m.chat_add_menu()}
          >
            <Plus size={18} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="oc-perm__menu w-80">
          {attachmentsSupported ? (
            <>
              <DropdownMenuItem
                className="oc-perm__opt"
                disabled={attachDisabled}
                onSelect={() => fileInput.current?.click()}
                data-add-option="file"
              >
                <span className="oc-perm__opt-icon" aria-hidden>
                  <FileUp size={14} />
                </span>
                <span className="oc-perm__opt-copy">
                  <span className="oc-perm__opt-title">{m.chat_add_file()}</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="oc-perm__opt"
                disabled={attachDisabled}
                onSelect={() => imageInput.current?.click()}
                data-add-option="image"
              >
                <span className="oc-perm__opt-icon" aria-hidden>
                  <ImagePlus size={14} />
                </span>
                <span className="oc-perm__opt-copy">
                  <span className="oc-perm__opt-title">{m.chat_add_image()}</span>
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
          {view.hidden || control == null ? null : (
            <>
              {attachmentsSupported ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel className="oc-perm__heading" data-knowledge-origin={view.origin}>
                <span>{m.chat_knowledge_heading()}</span>
                <span className="oc-knowledge__origin">{view.originLabel}</span>
              </DropdownMenuLabel>
              {view.items.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  className={`oc-perm__opt${item.checked ? " is-selected" : ""}`}
                  role="menuitemcheckbox"
                  aria-checked={item.checked}
                  disabled={!editable || item.unavailable}
                  title={
                    item.unavailable
                      ? m.chat_knowledge_source_unavailable()
                      : (view.readOnlyReason ?? undefined)
                  }
                  data-knowledge-source={item.id}
                  // The menu stays open: several sources are toggled in a row.
                  onSelect={(e) => {
                    e.preventDefault();
                    if (editable && !item.unavailable) {
                      pick(toggledChoice(withPending(control, pendingChoice), item.id));
                    }
                  }}
                >
                  <span className="oc-perm__opt-copy">
                    <span className="oc-perm__opt-title">{item.label}</span>
                    {item.description !== "" ? (
                      <span className="oc-perm__opt-desc">{item.description}</span>
                    ) : null}
                  </span>
                  <span className="oc-perm__opt-state" aria-hidden>
                    {!editable || item.unavailable ? (
                      item.checked ? <Check size={14} /> : <Lock size={13} />
                    ) : item.checked ? (
                      <Check size={14} />
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ))}
              {view.emptyNote !== null ? <p className="oc-perm__note">{view.emptyNote}</p> : null}
              {view.allOff && view.emptyNote === null ? (
                <p className="oc-perm__note">{m.chat_knowledge_all_off()}</p>
              ) : null}
              {view.canReset ? (
                <DropdownMenuItem
                  className="oc-perm__opt"
                  onSelect={() => pick({ kind: "default" })}
                  data-knowledge-reset
                >
                  <span className="oc-perm__opt-icon" aria-hidden>
                    <RotateCcw size={14} />
                  </span>
                  <span className="oc-perm__opt-copy">
                    <span className="oc-perm__opt-title">{m.chat_knowledge_reset()}</span>
                  </span>
                </DropdownMenuItem>
              ) : null}
              {view.status !== null ? (
                <p
                  className={`oc-perm__status${view.statusIsError ? " is-error" : ""}`}
                  role={view.statusIsError ? "alert" : "status"}
                >
                  {view.status}
                </p>
              ) : null}
              {view.readOnlyReason !== null ? (
                <p className="oc-perm__note">{view.readOnlyReason}</p>
              ) : null}
            </>
          )}
          {widgets.offered ? (
            <>
              {attachmentsSupported || !view.hidden ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                className={`oc-perm__opt${widgets.enabled ? " is-selected" : ""}`}
                role="menuitemcheckbox"
                aria-checked={widgets.enabled}
                disabled={widgets.pending}
                data-widgets-toggle
                onSelect={(e) => {
                  e.preventDefault();
                  widgets.set(!widgets.enabled);
                }}
              >
                <span className="oc-perm__opt-icon" aria-hidden>
                  <LayoutTemplate size={14} />
                </span>
                <span className="oc-perm__opt-copy">
                  <span className="oc-perm__opt-title">{m.chat_widgets_toggle()}</span>
                  <span className="oc-perm__opt-desc">{m.chat_widgets_toggle_desc()}</span>
                </span>
                <span className="oc-perm__opt-state" aria-hidden>
                  {widgets.enabled ? <Check size={14} /> : null}
                </span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
