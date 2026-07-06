import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";

// Minimal, dependency-free toast primitive for surfacing server-side mutation
// errors (and the occasional success). Deliberately small: a context provider
// holds a queue of toasts; `useToast()` returns a `toast(...)` function; a fixed
// viewport renders them with auto-dismiss + a manual close. Styling lives in
// convexChat.css (oc-toast*) on design tokens — only the destructive accent uses
// a hex literal, mirroring the trace-status convention.
//
// Why not radix Toast: the project already ships AlertDialog/Dialog for blocking
// flows; this is the non-blocking complement. A self-contained version avoids a
// new dependency and keeps the API trivial (`toast.error(message)`).

type ToastVariant = "error" | "success" | "info";

type ToastItem = {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
};

type ToastInput = {
  variant?: ToastVariant;
  title: string;
  description?: string;
};

type ToastApi = {
  toast: (input: ToastInput) => void;
  /** Convenience: surface a thrown error's message as a destructive toast. */
  error: (title: string, err?: unknown) => void;
  success: (title: string, description?: string) => void;
};

const ToastContext = React.createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 6000;

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  // ConvexError carries its payload in `data` — the server's ACTIONABLE code
  // (e.g. "bridge_error: config-defaults set -> HTTP 502 (GATEWAY_TIMEOUT)").
  // Prefer it over the generic "Server Error" wrapper message.
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data === "string" && data) return data;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return m.toast_unknown_error();
  }
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(0);
  const timers = React.useRef<Map<number, number>>(new Map());

  const dismiss = React.useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = React.useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        variant: input.variant ?? "info",
        title: input.title,
        description: input.description,
      };
      setItems((prev) => [...prev, item]);
      const handle = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timers.current.set(id, handle);
    },
    [dismiss],
  );

  // Snapshot the timers map for the cleanup closure (avoids the exhaustive-deps
  // "ref value may have changed" lint on unmount).
  React.useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) window.clearTimeout(handle);
      map.clear();
    };
  }, []);

  const api = React.useMemo<ToastApi>(
    () => ({
      toast: push,
      error: (title, err) =>
        push({
          variant: "error",
          title,
          description: err !== undefined ? errorMessage(err) : undefined,
        }),
      success: (title, description) =>
        push({ variant: "success", title, description }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="oc-toast__viewport"
        role="region"
        aria-label={m.toast_region_aria()}
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn("oc-toast", `oc-toast--${t.variant}`)}
            role={t.variant === "error" ? "alert" : "status"}
          >
            <div className="oc-toast__body">
              <div className="oc-toast__title">{t.title}</div>
              {t.description ? (
                <div className="oc-toast__desc">{t.description}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="oc-toast__close"
              aria-label={m.common_close()}
              onClick={() => dismiss(t.id)}
            >
              <X aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}
