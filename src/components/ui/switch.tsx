import * as React from "react";
import { cn } from "@/lib/utils";

// Shared Switch (chart-token styled, no extra dependency): a role="switch"
// toggle for on/off preferences — visually distinct from Checkbox (which the
// app keeps for consent-style boxes). Controlled-only, keyboard accessible
// (space/enter via native button semantics).
function Switch({
  className,
  checked,
  onCheckedChange,
  disabled,
  ...props
}: Omit<React.ComponentProps<"button">, "onClick"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export { Switch };
