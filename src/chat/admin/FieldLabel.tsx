// Shared form-field label + `?` help bubble (hover/focus tooltip). Extracted from
// BridgeTab so the per-instance bridge config AND the dedicated Prompt-injections tab
// render the SAME help affordance without duplicating it or cross-importing a lazy chunk.

import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** A small `?` help bubble next to a form field label (hover/focus tooltip). */
export function FieldHelp({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="oc-field__help"
            aria-label={text}
            onClick={(e) => e.preventDefault()}
          >
            <HelpCircle aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-pretty">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function FieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="oc-field__label">
      {label}
      <FieldHelp text={help} />
    </span>
  );
}
