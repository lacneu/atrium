import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

// Right-side slide-in form taking ~4/5 of the horizontal space (overrides the
// shadcn default w-3/4 + sm:max-w-sm cap). Used for add/edit across admin lists
// and the chat rename form, per the requested ergonomics.
export function EntitySheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submitLabel = "Enregistrer",
  submitting = false,
  canSubmit = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  onSubmit: () => void | Promise<void>;
  submitLabel?: string;
  submitting?: boolean;
  canSubmit?: boolean;
}) {
  // Own the in-flight state so EVERY EntitySheet form gives feedback during the
  // save round-trip WITHOUT per-caller wiring: we AWAIT onSubmit, and while it is
  // pending the submit button shows a spinner + is disabled (closes the "did my
  // save register?" void + the double-submit hole). The `submitting` prop still
  // forces busy when a caller tracks its own external pending state.
  const [saving, setSaving] = useState(false);
  const busy = submitting || saving;
  async function handleSubmit() {
    if (!canSubmit || busy) return;
    try {
      setSaving(true);
      await onSubmit();
    } finally {
      setSaving(false);
    }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-4/5 sm:max-w-none gap-0 p-0"
      >
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="oc-sheet__body flex-1 overflow-y-auto px-6 py-4">
            {children}
          </div>
          <SheetFooter className="border-t px-6 py-4">
            <Button type="submit" disabled={!canSubmit || busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {submitLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Annuler
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
