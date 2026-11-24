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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTouchReveal } from "@/lib/useMediaQuery";

/** A small `?` help bubble next to a form field label: a tooltip under a mouse, a
 *  TOGGLETIP where a finger can be used — a tooltip opens on hover or focus, never
 *  on a tap, so on a phone the help was simply unreachable. */
export function FieldHelp({ text }: { text: string }) {
  const touch = useTouchReveal();
  if (touch) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="oc-field__help oc-hit" aria-label={text}>
            <HelpCircle aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className="oc-fieldhelp w-auto p-3 text-sm text-pretty">
          {text}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="oc-field__help"
            aria-label={text}
            // Keeps the tooltip open on click (Radix closes it unless the click's
            // default is prevented).
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
