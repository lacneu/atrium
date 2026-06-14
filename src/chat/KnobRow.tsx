import { useCallback, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { m } from "@/paraglide/messages.js";
import {
  SPEED_OPTIONS,
  capitalize,
  shortLevelLabel,
  isOverridden,
  speedKnobValue,
  speedOptionLabel,
  speedSelection,
  type KnobField,
  type SessionMetaView,
  type SessionSettingsView,
  type SpeedOption,
} from "./sessionKnobs";
import { knobRowVisibility } from "./capabilities";
import { useInstanceCapabilities } from "./useInstanceCapabilities";

// Shared session-knob rows (design amendment A11): the SAME components render
// a knob in the composer "Advanced" popover AND in the session panel Sheet: one
// state, one mutation path, one provenance treatment, never two
// implementations. Provenance is the VS Code gutter pattern (.oc-prefs__row
// precedent): an accent border-left when the knob is overridden for THIS chat
// (its key present in sessionSettings — amendment A1), an "inherited" badge
// otherwise; ↺ (reset to inherited = explicit gateway unset, bench-lifted A2)
// renders ONLY when overridden.

export type KnobValue = string | boolean | null;

/**
 * Per-chat knob write-back state machine: one in-flight apply at a time
 * (controls disable while pending), inline per-row error with retry (A11).
 * The mutation persists the intent + schedules the immediate bridge patch;
 * the visible value then refreshes through the reactive sessionMeta echo.
 */
export function useSessionKnobs(chatId: ConvexId<"chats">) {
  const setKnob = useMutation(api.chats.setSessionKnob);
  const [pending, setPending] = useState<KnobField | null>(null);
  const [error, setError] = useState<{
    field: KnobField;
    value: KnobValue;
  } | null>(null);

  const apply = useCallback(
    async (field: KnobField, value: KnobValue) => {
      setPending(field);
      setError(null);
      const args: {
        chatId: Id<"chats">;
        thinkingLevel?: string | null;
        model?: string | null;
        fastMode?: boolean | null;
      } = { chatId: chatId as Id<"chats"> };
      if (field === "fastMode") args.fastMode = value as boolean | null;
      else args[field] = value as string | null;
      try {
        await setKnob(args);
      } catch {
        setError({ field, value });
      } finally {
        setPending(null);
      }
    },
    [chatId, setKnob],
  );

  return { apply, pending, error };
}

/** One labelled setting row: provenance gutter + badge/↺ + inline states.
 *  `resettable` (default true) gates the ↺ affordance on the gateway's
 *  knobUnset capability: an overridden row on a gateway without unset support
 *  keeps its provenance gutter but offers no reset it cannot honor. */
export function KnobRow({
  label,
  overridden,
  onReset,
  pending,
  error,
  onRetry,
  help,
  children,
  resettable = true,
}: {
  label: string;
  overridden: boolean;
  onReset: () => void;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
  help?: string;
  children: ReactNode;
  resettable?: boolean;
}) {
  return (
    <div className={`oc-spanel__row${overridden ? " is-overridden" : ""}`}>
      <div className="oc-spanel__rowhead">
        <span className="oc-spanel__label">{label}</span>
        {pending ? (
          <LoaderCircle
            size={13}
            className="oc-spanel__spin"
            aria-label={m.conf_applying()}
          />
        ) : overridden ? (
          resettable ? (
            <button
              type="button"
              className="oc-spanel__reset"
              title={m.conf_reset_to_inherited()}
              aria-label={m.conf_reset_to_inherited()}
              onClick={onReset}
            >
              <RotateCcw size={12} aria-hidden />
            </button>
          ) : null
        ) : (
          <span className="oc-spanel__badge">{m.conf_badge_inherited()}</span>
        )}
      </div>
      <div className="oc-spanel__ctl">{children}</div>
      {help ? <p className="oc-spanel__help">{help}</p> : null}
      {error ? (
        <p className="oc-spanel__error" role="alert">
          {m.conf_apply_error()}
          <button type="button" className="oc-spanel__retry" onClick={onRetry}>
            {m.conf_retry()}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** Segmented control (≤ 6 named, ordered options — widget rules + A5). */
export function KnobSegmented({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { id: string; label: string; title?: string }[];
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="oc-spanel__seg" role="group">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`oc-spanel__seg-btn${value === o.id ? " is-active" : ""}`}
          aria-pressed={value === o.id}
          title={o.title ?? o.label}
          aria-label={o.title ?? o.label}
          disabled={disabled}
          onClick={() => {
            if (o.id !== value) onChange(o.id);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Dropdown fallback for > 4 options (widget rules: 5-15 → dropdown). */
function KnobSelect({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: { id: string; label: string }[];
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  const known = value === null || options.some((o) => o.id === value);
  return (
    <select
      className="oc-spanel__select"
      value={value ?? ""}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        if (e.target.value && e.target.value !== value) onChange(e.target.value);
      }}
    >
      {value === null ? <option value="" disabled hidden /> : null}
      {!known ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The GENERATION knobs (model / reasoning / speed) — the single shared
 * implementation mounted by BOTH the "Advanced" popover and the session panel.
 * Current values come from sessionMeta (gateway truth) for model/thinking and
 * from the intent for speed (no fastMode echo in sessionMeta).
 *
 * Capability-gated (VCOMPAT-C): each row renders only when the chat's
 * instance supports its knob (knobRowVisibility). Popover knobs are HIDDEN
 * (not disabled) when unsupported — the popover stays lean. While the compat
 * query loads, only the LEGACY set (model/thinking) shows, so a control can
 * appear when the snapshot lands but never flashes and disappears.
 */
export function SessionKnobsGroup({
  chatId,
  sm,
  settings,
}: {
  chatId: ConvexId<"chats">;
  sm: SessionMetaView;
  settings: SessionSettingsView;
}) {
  const { apply, pending, error } = useSessionKnobs(chatId);
  const { can } = useInstanceCapabilities(chatId);
  const busy = pending !== null;
  const retry = useCallback(() => {
    if (error) void apply(error.field, error.value);
  }, [apply, error]);

  const levels = sm.thinkingLevels ?? [];
  const models = sm.availableModels ?? [];
  const speedValue = speedSelection(settings);
  const vis = knobRowVisibility(can, {
    hasModels: models.length > 0,
    hasLevels: levels.length > 0,
  });

  return (
    <>
      {vis.model ? (
        <KnobRow
          label={m.chat_model()}
          overridden={isOverridden(settings, "model")}
          onReset={() => void apply("model", null)}
          pending={pending === "model"}
          error={error?.field === "model"}
          onRetry={retry}
          resettable={vis.reset}
        >
          {models.length <= 4 ? (
            <KnobSegmented
              options={models}
              value={sm.model ?? null}
              onChange={(id) => void apply("model", id)}
              disabled={busy}
            />
          ) : (
            <KnobSelect
              options={models}
              value={sm.model ?? null}
              onChange={(id) => void apply("model", id)}
              disabled={busy}
              ariaLabel={m.chat_model()}
            />
          )}
        </KnobRow>
      ) : null}
      {vis.thinking ? (
        <KnobRow
          label={m.conf_thinking_label()}
          overridden={isOverridden(settings, "thinkingLevel")}
          onReset={() => void apply("thinkingLevel", null)}
          pending={pending === "thinkingLevel"}
          error={error?.field === "thinkingLevel"}
          onRetry={retry}
          resettable={vis.reset}
        >
          <KnobSegmented
            options={levels.map((l) => ({
              id: l.id,
              label: shortLevelLabel(l.id, capitalize(l.label)),
              title: capitalize(l.label),
            }))}
            value={sm.thinkingLevel ?? null}
            onChange={(id) => void apply("thinkingLevel", id)}
            disabled={busy}
          />
        </KnobRow>
      ) : null}
      {vis.speed ? (
        <KnobRow
          label={m.conf_speed_label()}
          overridden={isOverridden(settings, "fastMode")}
          onReset={() => void apply("fastMode", null)}
          pending={pending === "fastMode"}
          error={error?.field === "fastMode"}
          onRetry={retry}
          resettable={vis.reset}
        >
          <KnobSegmented
            options={SPEED_OPTIONS.map((o) => ({
              id: o,
              label: speedOptionLabel(o),
            }))}
            value={speedValue}
            onChange={(id) =>
              void apply("fastMode", speedKnobValue(id as SpeedOption))
            }
            disabled={busy}
          />
        </KnobRow>
      ) : null}
    </>
  );
}
