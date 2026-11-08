import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { useLayerFocus, type ReturnFocus } from "@/lib/returnFocus"

// Minimal shadcn-style Popover (CONF-4). Unlike DropdownMenu, a Popover does
// NOT close on inner activation — required for the session-knob segmented
// controls, which are adjusted repeatedly without reopening the surface.

// A popover's content and its trigger carry the same pair (`data-popover-of` ↔
// `data-popover-trigger`): a dialog opened from inside the popover gives the focus
// back to that trigger once the popover is gone (lib/returnFocus). Radix links
// them only while the popover is open (`aria-controls`), and it closes as the
// dialog opens.
const PopoverPair = React.createContext<string | undefined>(undefined)

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const pair = React.useId()
  return (
    <PopoverPair.Provider value={pair}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PopoverPair.Provider>
  )
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const pair = React.useContext(PopoverPair)
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      data-popover-trigger={pair}
      {...props}
    />
  )
}

// NEVER TALLER THAN THE SCREEN ALLOWS. Radix publishes the room left on the
// chosen side (`--radix-popover-content-available-height`, collision padding
// included): a long popover scrolls inside it instead of running off the screen,
// where its last rows were simply unreachable on a phone (the session settings
// popover ended 26 px below a 740 px screen, 404 px below a landscape one). That
// room is measured on the visual viewport: the iOS keyboard is already out of it.
// A caller's own `overflow-*` still wins (tailwind-merge); its height cap never
// does — a view that wants less writes `min(its cap, this room)` in its stylesheet
// (safeAreas.test.ts). The z-index
// utility stays on the element, after its `data-slot`: overlayLayer.test.ts pairs
// the two by position to prove the surface is raised by the app's layer rule.
export const popoverContentClassName =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-72 max-h-(--radix-popover-content-available-height) origin-(--radix-popover-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-4 shadow-md outline-hidden"

/** Keeps floating content off the screen's edge (it touched it on a phone). */
export const OVERLAY_COLLISION_PADDING = 8

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = OVERLAY_COLLISION_PADDING,
  returnFocus,
  onInteractOutside,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Content>, "onCloseAutoFocus" | "ref"> & {
  /** Where the focus goes as the popover closes if its trigger is gone or hidden
   *  by then — controls of the view that stay, in order. */
  returnFocus?: ReturnFocus
}) {
  const pair = React.useContext(PopoverPair)
  // The focus goes back to the trigger by the one rule of lib/returnFocus — a view
  // only adds fallbacks (`returnFocus`).
  const focus = useLayerFocus("popover", returnFocus, onInteractOutside)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-popover-of={pair}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("z-50", popoverContentClassName, className)}
        {...props}
        ref={focus.ref}
        onCloseAutoFocus={focus.onCloseAutoFocus}
        onInteractOutside={focus.onInteractOutside}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
