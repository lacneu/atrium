import * as React from "react"
import { ActionBarMorePrimitive } from "@assistant-ui/react"

import { cn } from "@/lib/utils"
import { useLayerFocus, type ReturnFocus } from "@/lib/returnFocus"

// The reply's "more actions" menu is assistant-ui's, not the shared DropdownMenu:
// it holds the action bar's interaction lock while open, so the bar — which hides
// on every reply but the last unless hovered — does not unmount its own trigger.
// Underneath it is a Radix menu, closed by Radix's own default: it took back a
// focus the user had just moved to the composer (lot 17). Its content goes
// through the focus rule of every layer (lib/returnFocus), like the shared
// contents; the guard of dialogFocusReturn.test.ts keeps assistant-ui's layer
// primitives to this file.

const ActionBarMore = ActionBarMorePrimitive.Root
const ActionBarMoreTrigger = ActionBarMorePrimitive.Trigger
const ActionBarMoreItem = ActionBarMorePrimitive.Item
const ActionBarMoreSeparator = ActionBarMorePrimitive.Separator

function ActionBarMoreContent({
  className,
  returnFocus,
  ...props
}: Omit<React.ComponentProps<typeof ActionBarMorePrimitive.Content>, "onCloseAutoFocus" | "ref"> & {
  /** Where the focus goes as the menu closes if its trigger is gone or hidden by
   *  then — controls of the view that stay, in order. */
  returnFocus?: ReturnFocus
}) {
  const focus = useLayerFocus("menu", returnFocus)
  // The shared menu's slot: the layer, the reduced motion and the room left above
  // the keyboard of every menu apply to it (convexChat.css); never taller than the
  // room Radix measured.
  return (
    <ActionBarMorePrimitive.Content
      data-slot="dropdown-menu-content"
      className={cn("max-h-(--radix-dropdown-menu-content-available-height)", className)}
      {...props}
      ref={focus.ref}
      onCloseAutoFocus={focus.onCloseAutoFocus}
    />
  )
}

export {
  ActionBarMore,
  ActionBarMoreTrigger,
  ActionBarMoreContent,
  ActionBarMoreItem,
  ActionBarMoreSeparator,
}
