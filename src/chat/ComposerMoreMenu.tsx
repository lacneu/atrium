// The composer's "More" menu: the controls the action bar could not keep. They
// leave in Olivier's order (composerFit.ts OVERFLOW_ORDER) and are SHOWN in
// MORE_MENU_ORDER: one-line actions first, as they sit in the bar, then the two
// settings sections. A popover rather than a menu, because those two stay open while
// one adjusts them (the permission modes, Talk's voice and sensitivity) — the same
// reason the header's "Advanced" is one.
import type { ReactNode } from "react";
import {
  Check,
  Maximize2,
  Mic,
  Minimize2,
  MoreHorizontal,
  Pin,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MORE_MENU_ORDER, type OverflowKey } from "./composerFit";

export function ComposerMoreMenu({
  open,
  onOpenChange,
  moved,
  hold,
  expand,
  tools,
  onManageConversation,
  onDictate,
  permission,
  talkSettingsSlot,
  talkStartSlot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The controls moved out of the bar. */
  moved: ReadonlySet<OverflowKey>;
  hold: { held: boolean; disabled: boolean; onHold: () => void; onRelease: () => void };
  expand: { expanded: boolean; onToggle: () => void };
  tools: { shown: boolean; onToggle: () => void };
  onManageConversation: () => void;
  onDictate: () => void;
  /** The permission choice, as a section (rendered only when moved). */
  permission: ReactNode;
  /** Where Talk renders its moved parts (it owns their state). */
  talkSettingsSlot: (el: HTMLDivElement | null) => void;
  talkStartSlot: (el: HTMLDivElement | null) => void;
}) {
  const close = () => onOpenChange(false);
  const item = (key: OverflowKey): ReactNode => {
    switch (key) {
      case "tools":
        return (
          <Button
            key={key}
            variant="ghost"
            className="oc-composer__more-item w-full justify-start"
            aria-pressed={tools.shown}
            onClick={tools.onToggle}
          >
            <SlidersHorizontal aria-hidden />
            {m.chat_tools()}
            {tools.shown ? <Check className="ml-auto" aria-hidden /> : null}
          </Button>
        );
      case "room-settings":
        return (
          <Button
            key={key}
            variant="ghost"
            className="oc-composer__more-item w-full justify-start"
            onClick={() => {
              close();
              onManageConversation();
            }}
          >
            <Settings2 aria-hidden />
            {m.conversation_manage()}
          </Button>
        );
      case "hold":
        return hold.held ? (
          <Button
            key={key}
            variant="ghost"
            className="oc-composer__more-item w-full justify-start"
            onClick={() => {
              close();
              hold.onRelease();
            }}
          >
            <Pin aria-hidden />
            {m.chat_composer_release()}
          </Button>
        ) : (
          <Button
            key={key}
            variant="ghost"
            className="oc-composer__more-item w-full justify-start"
            disabled={hold.disabled}
            onClick={() => {
              close();
              hold.onHold();
            }}
          >
            <Pin aria-hidden />
            {m.chat_composer_detach()}
          </Button>
        );
      case "expand":
        return (
          <Button
            key={key}
            variant="ghost"
            className="oc-composer__more-item w-full justify-start"
            aria-pressed={expand.expanded}
            onClick={() => {
              close();
              expand.onToggle();
            }}
          >
            {expand.expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            {expand.expanded ? m.chat_composer_collapse() : m.chat_composer_expand()}
          </Button>
        );
      case "mic":
        return (
          <Button
            key={key}
            variant="ghost"
            className="oc-composer__more-item w-full justify-start"
            onClick={() => {
              close();
              onDictate();
            }}
          >
            <Mic aria-hidden />
            {m.chat_mic_start()}
          </Button>
        );
      case "talk":
        // Talk renders its own start entry here (it owns the call).
        return <div key={key} ref={talkStartSlot} />;
      case "perm":
        return (
          <div key={key} className="oc-composer__more-section">
            {permission}
          </div>
        );
      case "talk-settings":
        // …and its own settings, inside this section.
        return (
          <div
            key={key}
            ref={talkSettingsSlot}
            className="oc-composer__more-section"
            role="group"
            aria-label={m.chat_composer_more_talk()}
          />
        );
    }
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="oc-composer__icon oc-composer__more"
          title={m.chat_composer_more()}
          aria-label={m.chat_composer_more()}
        >
          <MoreHorizontal size={18} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="oc-composer__more-pop w-80 p-1">
        {MORE_MENU_ORDER.filter((key) => moved.has(key)).map(item)}
      </PopoverContent>
    </Popover>
  );
}
