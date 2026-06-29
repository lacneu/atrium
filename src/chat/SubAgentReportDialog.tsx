import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
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

// Report a FAILED sub-agent. Flagging FREEZES a forensic snapshot of the child +
// its failed siblings + the spawning turn server-side (convex/subAgentReports.ts)
// so a later reaper/re-spawn cannot erase the evidence, and emits a CONTENT-FREE
// plane-2 anomaly (source:"user") an admin / the MCP can analyze. The dialog is
// rendered ONCE by SubAgentActivity and driven by the `target` prop — unlike the
// per-message FeedbackButton it is NOT inside an autohiding action bar, so no
// root provider is needed.

const COMMENT_MAX = 1000;

// Category ids MUST exist in convex/subAgentReports.SUBAGENT_REPORT_CATEGORIES
// (the server is the single source of truth; an unknown value is dropped there).
function categories(): { id: string; label: string }[] {
  return [
    { id: "hung", label: m.subagentreport_cat_hung() },
    { id: "wrong_result", label: m.subagentreport_cat_wrong_result() },
    { id: "error", label: m.subagentreport_cat_error() },
    { id: "other", label: m.subagentreport_cat_other() },
  ];
}

export type SubAgentReportTarget = {
  subAgentId: string;
  label: string;
};

export function SubAgentReportDialog({
  target,
  onClose,
}: {
  target: SubAgentReportTarget | null;
  onClose: () => void;
}) {
  const submit = useMutation(api.subAgentReports.createSubAgentReport);

  const [category, setCategory] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Reset the form whenever a fresh target opens the dialog.
  useEffect(() => {
    if (target) {
      setCategory("");
      setComment("");
      setSubmitting(false);
      setSubmitted(false);
    }
  }, [target]);

  function close(next: boolean) {
    if (!next) onClose();
  }

  async function onSubmit() {
    if (!target || submitting) return;
    setSubmitting(true);
    try {
      await submit({
        subAgentId: target.subAgentId as Id<"subAgents">,
        category: category || undefined,
        comment: comment.trim() || undefined,
      });
      setSubmitted(true);
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={close}>
      {target ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{m.subagentreport_title()}</DialogTitle>
            <DialogDescription>
              {submitted
                ? m.subagentreport_desc_submitted()
                : m.subagentreport_desc({ label: target.label })}
            </DialogDescription>
          </DialogHeader>

          {submitted ? (
            <div className="oc-feedback__result" role="status">
              <p className="oc-feedback__fidelity is-ok">
                {m.subagentreport_submitted()}
              </p>
            </div>
          ) : (
            <div className="oc-feedback__form">
              <label className="oc-feedback__label">
                {m.subagentreport_category_label()}
              </label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={m.subagentreport_category_placeholder()}
                  />
                </SelectTrigger>
                <SelectContent>
                  {categories().map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <label
                className="oc-feedback__label"
                htmlFor="oc-subagentreport-comment"
              >
                {m.subagentreport_comment_label()}
              </label>
              <textarea
                id="oc-subagentreport-comment"
                className="oc-feedback__textarea"
                placeholder={m.subagentreport_comment_placeholder()}
                value={comment}
                maxLength={COMMENT_MAX}
                onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
                rows={4}
              />
              <div className="oc-feedback__count">
                {comment.length}/{COMMENT_MAX}
              </div>
            </div>
          )}

          <DialogFooter>
            {submitted ? (
              <Button onClick={() => close(false)}>
                {m.subagentreport_close()}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => close(false)}>
                  {m.subagentreport_cancel()}
                </Button>
                <Button onClick={() => void onSubmit()} disabled={submitting}>
                  {submitting
                    ? m.subagentreport_sending()
                    : m.subagentreport_send()}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
