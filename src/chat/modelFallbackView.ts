// The model-fallback notice's wording (pure: no React).
//
// The gateway states, after a run's work, that the run was answered by another model
// than the one selected — or that the session is back on its selected one. The bridge
// carries the model names only; the wording is the gateway's own Control UI's
// ("Fallback active: {model}", "Fallback cleared: {model}", detail "Selected: {model}").

import { m } from "@/paraglide/messages.js";

/** The per-bubble marker written by the bridge (null = no fallback stated). */
export interface ModelFallbackMeta {
  state: "active" | "cleared";
  /** The name printed: the active model, or the selected one once cleared. */
  model: string;
  /** The model that was asked for, while a fallback holds. */
  selected?: string;
}

export interface ModelFallbackView {
  cleared: boolean;
  label: string;
  /** The line under the label on hover; null when there is nothing more to say. */
  detail: string | null;
}

export function modelFallbackView(meta: ModelFallbackMeta | null | undefined): ModelFallbackView | null {
  if (!meta || typeof meta.model !== "string" || meta.model.trim() === "") return null;
  if (meta.state === "cleared") {
    return { cleared: true, label: m.model_fallback_cleared({ model: meta.model }), detail: null };
  }
  if (meta.state !== "active") return null;
  return {
    cleared: false,
    label: m.model_fallback_active({ model: meta.model }),
    detail:
      typeof meta.selected === "string" && meta.selected.trim() !== ""
        ? m.model_fallback_selected({ model: meta.selected })
        : null,
  };
}
