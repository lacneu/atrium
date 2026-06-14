import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// Promise-based, app-wide replacement for the native window.confirm /
// window.prompt (off-brand, un-themeable). Mount <DialogsProvider> once near the
// root; call sites use `const confirm = useConfirm()` then
// `if (await confirm({...})) { ... }` — same control flow as window.confirm.
//
// confirm() renders a radix AlertDialog (role="alertdialog", no outside-click
// dismiss) and supports a type-to-confirm guard for irreversible actions:
// the action button stays disabled until the user types `confirmWord`.
// prompt() renders a plain Dialog with a single text input.

export type ConfirmOptions = {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** When set, the action button is disabled until this word is typed. */
  confirmWord?: string
  /** Render the action button with the destructive style. */
  destructive?: boolean
}

export type PromptOptions = {
  title: string
  description?: React.ReactNode
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
}

type ConfirmReq = { kind: "confirm"; opts: ConfirmOptions }
type PromptReq = { kind: "prompt"; opts: PromptOptions }
type Req = ConfirmReq | PromptReq

type DialogsApi = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  prompt: (opts: PromptOptions) => Promise<string | null>
}

const DialogsContext = React.createContext<DialogsApi | null>(null)

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = React.useState<Req | null>(null)
  // The pending promise resolver. Kept in a ref so a single `settle` guards
  // against double-resolution (e.g. Action onClick + Escape onOpenChange).
  const resolveRef = React.useRef<((v: never) => void) | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [value, setValue] = React.useState("")

  const settle = React.useCallback((result: boolean | string | null) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setReq(null)
    if (resolve) (resolve as (v: boolean | string | null) => void)(result)
  }, [])

  const api = React.useMemo<DialogsApi>(
    () => ({
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          resolveRef.current = resolve as never
          setValue("")
          setReq({ kind: "confirm", opts })
        }),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          resolveRef.current = resolve as never
          setValue(opts.defaultValue ?? "")
          setReq({ kind: "prompt", opts })
        }),
    }),
    []
  )

  const isConfirm = req?.kind === "confirm"
  const isPrompt = req?.kind === "prompt"

  // Type-to-confirm: trimmed, case-insensitive match (friendly but real guard).
  const confirmWord =
    req?.kind === "confirm" ? req.opts.confirmWord : undefined
  const canConfirm =
    !confirmWord ||
    value.trim().toLowerCase() === confirmWord.trim().toLowerCase()

  const promptValid = value.trim().length > 0

  // Deterministically win the focus race against a closing DropdownMenu by
  // focusing our input on open (only when there is an input to focus).
  const focusInput = (e: Event) => {
    e.preventDefault()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <DialogsContext.Provider value={api}>
      {children}

      {/* Destructive / irreversible confirmation. */}
      <AlertDialog
        open={isConfirm}
        onOpenChange={(o) => {
          if (!o) settle(false)
        }}
      >
        {isConfirm ? (
          <AlertDialogContent
            onOpenAutoFocus={confirmWord ? focusInput : undefined}
            // Opt out of radix's description requirement when none is provided
            // (avoids the "Missing Description / aria-describedby" warning).
            {...(req.opts.description ? {} : { "aria-describedby": undefined })}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{req.opts.title}</AlertDialogTitle>
              {req.opts.description ? (
                <AlertDialogDescription>
                  {req.opts.description}
                </AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>

            {confirmWord ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm text-muted-foreground">
                  Pour confirmer, saisissez{" "}
                  <span className="font-medium text-foreground">
                    « {confirmWord} »
                  </span>{" "}
                  ci-dessous.
                </span>
                <Input
                  ref={inputRef}
                  value={value}
                  placeholder={confirmWord}
                  autoComplete="off"
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canConfirm) {
                      e.preventDefault()
                      settle(true)
                    }
                  }}
                />
              </label>
            ) : null}

            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => settle(false)}>
                {req.opts.cancelLabel ?? "Annuler"}
              </AlertDialogCancel>
              <Button
                variant={req.opts.destructive ? "destructive" : "default"}
                disabled={!canConfirm}
                onClick={() => settle(true)}
              >
                {req.opts.confirmLabel ?? "Supprimer"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      {/* Single-field text prompt. */}
      <Dialog
        open={isPrompt}
        onOpenChange={(o) => {
          if (!o) settle(null)
        }}
      >
        {isPrompt ? (
          <DialogContent
            onOpenAutoFocus={focusInput}
            {...(req.opts.description ? {} : { "aria-describedby": undefined })}
          >
            <DialogHeader>
              <DialogTitle>{req.opts.title}</DialogTitle>
              {req.opts.description ? (
                <DialogDescription>{req.opts.description}</DialogDescription>
              ) : null}
            </DialogHeader>

            <label className="flex flex-col gap-1.5">
              {req.opts.label ? (
                <span className="text-sm text-muted-foreground">
                  {req.opts.label}
                </span>
              ) : null}
              <Input
                ref={inputRef}
                value={value}
                placeholder={req.opts.placeholder}
                autoComplete="off"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && promptValid) {
                    e.preventDefault()
                    settle(value.trim())
                  }
                }}
              />
            </label>

            <DialogFooter>
              <Button variant="outline" onClick={() => settle(null)}>
                {req.opts.cancelLabel ?? "Annuler"}
              </Button>
              <Button
                disabled={!promptValid}
                onClick={() => settle(value.trim())}
              >
                {req.opts.confirmLabel ?? "Valider"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </DialogsContext.Provider>
  )
}

function useDialogs(): DialogsApi {
  const ctx = React.useContext(DialogsContext)
  if (!ctx) {
    throw new Error("useConfirm/usePrompt must be used within <DialogsProvider>")
  }
  return ctx
}

export function useConfirm(): DialogsApi["confirm"] {
  return useDialogs().confirm
}

export function usePrompt(): DialogsApi["prompt"] {
  return useDialogs().prompt
}
