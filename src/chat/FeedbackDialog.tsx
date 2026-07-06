import * as React from "react";
import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { useMutation, useQuery } from "convex/react";
import { Check, Copy, Flag } from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";

// OpenRouter-style "Report Feedback". Flagging a message FREEZES a forensic
// snapshot server-side (convex/feedback.ts) so a later delete/regenerate cannot
// erase the disputed evidence, and surfaces the server's browser-fidelity verdict.
//
// ARCHITECTURE: the dialog is rendered ONCE at app root via <FeedbackProvider>,
// NOT inside the per-message action bar. The action bar uses assistant-ui
// `autohide` which UNMOUNTS its children on mouse-leave — a dialog nested in it
// dies the instant the cursor leaves the bubble (which is exactly what a user
// does to reach the dialog). So `FeedbackButton` only CAPTURES the target +
// rendered text at click time and hands it to the root dialog, whose lifecycle
// is independent of the hover/autohide state. Mirrors the useConfirm pattern.

const COMMENT_MAX = 1000;

type MsgRole = "user" | "assistant" | "system";

// Category id -> French label, PER ROLE. The ids MUST exist in
// convex/feedback.ts FEEDBACK_CATEGORIES (server is the single source of truth).
// An AI report and a user report are different acts: the assistant-response set
// is about generation quality; the user-message set is about "what I typed was
// changed on the way out" (the headline dispute).
function aiCategories(): { id: string; label: string }[] {
  return [
    { id: "incorrect", label: m.feedbackdlg_cat_incorrect() },
    { id: "incoherence", label: m.feedbackdlg_cat_incoherence() },
    { id: "altered_words", label: m.feedbackdlg_cat_altered_words_ai() },
    { id: "formatting", label: m.feedbackdlg_cat_formatting_ai() },
    { id: "latency", label: m.feedbackdlg_cat_latency() },
    { id: "api_error", label: m.feedbackdlg_cat_api_error() },
    { id: "other", label: m.feedbackdlg_cat_other() },
  ];
}
function userCategories(): { id: string; label: string }[] {
  return [
    { id: "altered_words", label: m.feedbackdlg_cat_altered_words_user() },
    { id: "formatting", label: m.feedbackdlg_cat_formatting_user() },
    { id: "other", label: m.feedbackdlg_cat_other() },
  ];
}

function categoriesFor(role: MsgRole) {
  return role === "user" ? userCategories() : aiCategories();
}

// Known text-mutating browser extensions and the DOM footprint they inject.
// Extensions are NOT API-enumerable (privacy), but the ones that rewrite text
// add identifiable nodes — detecting those is the useful forensic signal for
// "did a client tool alter the words?". We match on extension-INJECTED elements,
// never on our own `data-gramm="false"` attribute (which would false-positive).
const EXTENSION_SIGNATURES: { name: string; selector: string }[] = [
  {
    name: "Grammarly",
    selector:
      "grammarly-desktop-integration, grammarly-extension, [data-grammarly-shadow-root]",
  },
  { name: "LanguageTool", selector: "[data-lt-installed], .lt-toolbar" },
  { name: "DeepL", selector: "deepl-inline-translate, .deepl-translator" },
  { name: "ProWritingAad", selector: "pwa-shadow-host, .pwa-tag" },
];

// Best-effort browser context for the forensic snapshot.
function captureBrowserContext(): {
  plugins: string[];
  extensionsDetected: string[];
} {
  let plugins: string[] = [];
  try {
    // Privacy-neutered in modern Chrome (fixed PDF list); kept for completeness.
    plugins = Array.from(navigator.plugins ?? [])
      .map((p) => p.name)
      .slice(0, 40);
  } catch {
    plugins = [];
  }
  const extensionsDetected: string[] = [];
  for (const { name, selector } of EXTENSION_SIGNATURES) {
    try {
      if (document.querySelector(selector)) extensionsDetected.push(name);
    } catch {
      /* invalid selector / detached doc — skip */
    }
  }
  return { plugins, extensionsDetected };
}

type FeedbackTarget = {
  chatId: string;
  messageId: string;
  role: MsgRole;
  // Client declarations captured AT CLICK TIME, in the message context:
  displayedText: string;
  sourceWasOpen: boolean;
};

type FeedbackApi = (target: FeedbackTarget) => void;

const FeedbackContext = React.createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const ctx = React.useContext(FeedbackContext);
  if (!ctx) {
    throw new Error("useFeedback must be used within <FeedbackProvider>");
  }
  return ctx;
}

// App-root dialog. Holds the form state + the active target; immune to the
// per-message action bar's autohide unmount.
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const submit = useMutation(api.feedback.submitFeedback);

  const [target, setTarget] = useState<FeedbackTarget | null>(null);
  const [category, setCategory] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verdict, setVerdict] = useState<boolean | null | undefined>(null);
  // The submitted report's reference — shown + copyable so the user can hand
  // it to support/another user on any channel (live request 2026-07-04).
  const [reference, setReference] = useState<string | null>(null);
  const [refCopied, setRefCopied] = useState(false);

  const open: FeedbackApi = React.useCallback((t) => {
    setCategory("");
    setComment("");
    setSubmitting(false);
    setVerdict(null);
    setReference(null);
    setRefCopied(false);
    setTarget(t);
  }, []);

  function onOpenChange(next: boolean) {
    if (!next) setTarget(null);
  }

  async function onSubmit() {
    if (!target || !category || submitting) return;
    setSubmitting(true);
    try {
      const res = await submit({
        chatId: target.chatId as Id<"chats">,
        messageId: target.messageId as Id<"messages">,
        category,
        comment: comment.trim() || undefined,
        client: {
          displayedText: target.displayedText,
          sourceWasOpen: target.sourceWasOpen,
          userAgent: navigator.userAgent,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
          ...captureBrowserContext(),
        },
      });
      setVerdict(res.displayedMatchesStored);
      setReference(
        String(
          (res as { reference?: string }).reference ?? res.feedbackId,
        ),
      );
    } catch {
      setSubmitting(false);
    }
  }

  const submitted = verdict !== null;
  const isUser = target?.role === "user";

  return (
    <FeedbackContext.Provider value={open}>
      {children}

      <Dialog open={target !== null} onOpenChange={onOpenChange}>
        {target ? (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{m.feedbackdlg_title()}</DialogTitle>
              <DialogDescription>
                {submitted
                  ? m.feedbackdlg_desc_submitted()
                  : isUser
                    ? m.feedbackdlg_desc_user()
                    : m.feedbackdlg_desc_assistant()}
              </DialogDescription>
            </DialogHeader>

            {submitted ? (
              <div className="oc-feedback__result" role="status">
                {/* HONEST verdict: the strong display-fidelity claim is made ONLY
                    when the source view was open (we read the actual rendered
                    `.oc-msg__source-pre` textContent). With it closed,
                    displayedText fell back to the received `rawText` — a match
                    proves transport consistency, NOT faithful rendering. */}
                {target.sourceWasOpen ? (
                  verdict === true ? (
                    <p className="oc-feedback__fidelity is-ok">
                      {m.feedbackdlg_fidelity_ok()}
                    </p>
                  ) : (
                    <p className="oc-feedback__fidelity is-warn">
                      {m.feedbackdlg_fidelity_warn()}
                    </p>
                  )
                ) : (
                  <p className="oc-feedback__fidelity">
                    {m.feedbackdlg_fidelity_closed()}
                  </p>
                )}
                {reference ? (
                  <div className="oc-feedback__ref">
                    <span className="oc-feedback__ref-label">
                      {m.feedbackdlg_ref_label()}
                    </span>
                    <code className="oc-feedback__ref-id" title={reference}>
                      {reference}
                    </code>
                    <button
                      type="button"
                      className="oc-iconbtn"
                      title={m.feedbackdlg_ref_copy()}
                      aria-label={m.feedbackdlg_ref_copy()}
                      onClick={() => {
                        void navigator.clipboard.writeText(reference).then(() => {
                          setRefCopied(true);
                          window.setTimeout(() => setRefCopied(false), 1500);
                        });
                      }}
                    >
                      {refCopied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="oc-feedback__form">
                <label className="oc-feedback__label">
                  {m.feedbackdlg_category_label()}
                </label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder={m.feedbackdlg_category_placeholder()} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoriesFor(target.role).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <label
                  className="oc-feedback__label"
                  htmlFor="oc-feedback-comment"
                >
                  {m.feedbackdlg_comment_label()}
                </label>
                <textarea
                  id="oc-feedback-comment"
                  className="oc-feedback__textarea"
                  placeholder={m.feedbackdlg_comment_placeholder()}
                  value={comment}
                  maxLength={COMMENT_MAX}
                  onChange={(e) =>
                    setComment(e.target.value.slice(0, COMMENT_MAX))
                  }
                  rows={4}
                />
                <div className="oc-feedback__count">
                  {comment.length}/{COMMENT_MAX}
                </div>
              </div>
            )}

            <DialogFooter>
              {submitted ? (
                <Button onClick={() => onOpenChange(false)}>
                  {m.feedbackdlg_close()}
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    {m.feedbackdlg_cancel()}
                  </Button>
                  <Button
                    onClick={() => void onSubmit()}
                    disabled={!category || submitting}
                  >
                    {submitting ? m.feedbackdlg_sending() : m.feedbackdlg_send()}
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </FeedbackContext.Provider>
  );
}

// Read what the BROWSER actually rendered for this message, byte-exact. Prefer
// the open source view (`.oc-msg__source-pre`, ligatures disabled) over the
// markdown body (which transforms text by design → false mismatches). Falls back
// to the client's received copy (`rawText`) when the source view is closed.
function captureDisplayed(
  btn: HTMLElement,
  rawText: string,
): { displayedText: string; sourceWasOpen: boolean } {
  const root = btn.closest(".oc-msg");
  const pre = root?.querySelector<HTMLElement>(".oc-msg__source-pre");
  const t = pre?.textContent;
  if (pre && t != null && t !== "(aucun texte)") {
    return { displayedText: t, sourceWasOpen: true };
  }
  return { displayedText: rawText, sourceWasOpen: false };
}

// The per-message flag. Lives inside the (autohiding) action bar, but only
// captures + delegates to the root dialog — so the dialog survives the bar's
// unmount on mouse-leave.
export function FeedbackButton() {
  const openFeedback = useFeedback();
  const messageId = useMessage(
    (m) => (m.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  const chatId = useMessage(
    (m) => (m.metadata?.custom as { chatId?: string } | undefined)?.chatId,
  );
  const role = useMessage((m) => m.role) as MsgRole;
  const rawText = useMessage(
    (m) => (m.metadata?.custom as { rawText?: string } | undefined)?.rawText ?? "",
  );

  const reported = useQuery(
    api.feedback.myReportedMessageIds,
    chatId ? { chatId: chatId as Id<"chats"> } : "skip",
  );

  if (!messageId || !chatId) return null;
  const alreadyReported = (reported ?? []).includes(messageId);

  function onFlag(e: React.MouseEvent<HTMLButtonElement>) {
    const cap = captureDisplayed(e.currentTarget, rawText);
    openFeedback({
      chatId: chatId as string,
      messageId: messageId as string,
      role,
      ...cap,
    });
  }

  return (
    <button
      type="button"
      className={`oc-iconbtn${alreadyReported ? " is-on" : ""}`}
      title={
        alreadyReported
          ? m.feedbackdlg_btn_reported()
          : m.feedbackdlg_btn_report()
      }
      aria-label={m.feedbackdlg_btn_aria()}
      onClick={onFlag}
    >
      <Flag size={15} aria-hidden />
    </button>
  );
}
