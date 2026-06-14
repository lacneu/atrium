import type { ReactNode } from "react";
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
  onSubmit: () => void;
  submitLabel?: string;
  submitting?: boolean;
  canSubmit?: boolean;
}) {
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
            if (canSubmit && !submitting) onSubmit();
          }}
        >
          <div className="oc-sheet__body flex-1 overflow-y-auto px-6 py-4">
            {children}
          </div>
          <SheetFooter className="border-t px-6 py-4">
            <Button type="submit" disabled={!canSubmit || submitting}>
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
