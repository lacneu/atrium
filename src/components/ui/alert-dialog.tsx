"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { useLayerFocus, type ReturnFocus } from "@/lib/returnFocus"
import { buttonVariants } from "@/components/ui/button"

// Confirmation dialog (shadcn convention) for destructive / irreversible
// actions. Built on the unified `radix-ui` AlertDialog: role="alertdialog",
// it does NOT close on outside click (only Cancel / Action / Escape), which is
// the right behavior for a delete guard.

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// NEVER TALLER THAN THE VISIBLE SCREEN, like every layer (lot 17): a confirmation
// used to keep its natural height, centred on the layout viewport — the iOS
// keyboard opened by its type-to-confirm field covered its buttons, and a short
// landscape screen cut it. Capped like the dialog, it scrolls inside; the
// stylesheet subtracts the keyboard and the safe areas, lifts it, keeps its
// actions in view, and sizes and centres it across what is shown (lot 25;
// convexChat.css, safeAreas.test.ts). Its padding gives way with the room, the
// caller's to replace, as the dialog's (lot 29); its column is its width, as the
// dialog's (lot 32). The z-index utility stays on the element, after its
// `data-slot` (overlayLayer.test.ts).
export const alertDialogContentClassName =
  "fixed top-1/2 grid grid-cols-1 max-w-md max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border bg-popover bg-clip-padding px-5 py-(--oc-layer-pad-y) text-sm text-popover-foreground shadow-lg duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

function AlertDialogContent({
  className,
  returnFocus,
  ...props
}: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Content>, "onCloseAutoFocus" | "ref"> & {
  /** Where the focus goes as the dialog closes if the control that opened it is
   *  gone or hidden by then — controls of the view that stay, in order. */
  returnFocus?: ReturnFocus
}) {
  // The focus goes back where the dialog was opened from, by the one rule of
  // lib/returnFocus — a view only adds fallbacks (`returnFocus`).
  const focus = useLayerFocus("dialog", returnFocus)
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn("z-50", alertDialogContentClassName, className)}
        {...props}
        ref={focus.ref}
        onCloseAutoFocus={focus.onCloseAutoFocus}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants(), className)}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
