"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useLayerFocus, type ReturnFocus } from "@/lib/returnFocus"
import { Button } from "@/components/ui/button"
import { m } from "@/paraglide/messages.js"

// Centered modal dialog (shadcn convention) built on the unified `radix-ui`
// Dialog primitive — same package the Sheet uses, so the data-open/data-closed
// animation states match. Use this for input/prompt flows; for destructive
// confirmations prefer AlertDialog (role="alertdialog", no outside-click close).

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// NEVER TALLER THAN THE VISIBLE SCREEN: a dialog taller than the viewport used to
// run off both edges with no way to scroll (title and buttons cut on a phone held
// in landscape). Capped at the dynamic viewport height minus the same 1rem margin
// it keeps at the sides, it scrolls inside instead. A caller's own `max-h-*` /
// `overflow-*` still wins (tailwind-merge; unlayered CSS on its class wins too).
// Its width and its place across are the stylesheet's (lot 25): what is shown less
// its safe areas, centred on it, never the layout viewport (convexChat.css).
// Its padding is the CALLER's (lot 29): the default gives way with the room shown
// (`--oc-layer-pad-y`, set by the stylesheet on the slot: 1.25rem down to 0.5rem),
// and is here, in the class, so that a caller's own padding replaces it — a rule on
// the slot beat the search palette's `p-0`.
// The z-index utility stays on the element, after its `data-slot`:
// overlayLayer.test.ts pairs the two by position to prove the surface is raised
// by the app's layer rule.
export const dialogContentClassName =
  "fixed top-1/2 grid max-w-md max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border bg-popover bg-clip-padding px-5 py-(--oc-layer-pad-y) text-sm text-popover-foreground shadow-lg duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

function DialogContent({
  className,
  children,
  showCloseButton = true,
  returnFocus,
  ...props
}: Omit<React.ComponentProps<typeof DialogPrimitive.Content>, "onCloseAutoFocus" | "ref"> & {
  showCloseButton?: boolean
  /** Where the focus goes as the dialog closes if the control that opened it is
   *  gone or hidden by then — controls of the view that stay, in order. */
  returnFocus?: ReturnFocus
}) {
  // The focus goes back where the dialog was opened from, by the one rule of
  // lib/returnFocus — a view only adds fallbacks (`returnFocus`): it cannot pass
  // its own `onCloseAutoFocus`, which would run before the guard.
  const focus = useLayerFocus("dialog", returnFocus)
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn("z-50", dialogContentClassName, className)}
        {...props}
        ref={focus.ref}
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3">
              <XIcon />
              <span className="sr-only">{m.common_close()}</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-6", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
