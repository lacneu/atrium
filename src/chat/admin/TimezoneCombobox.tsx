// A searchable timezone picker (IANA zones) — the chart-themed replacement for
// the free-text tz Input in the cron editor. Popover + filtered list built on
// pure helpers (searchTimezones). Degrades to a plain Input when the runtime
// lacks Intl.supportedValuesOf. The GATEWAY remains the validator.

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import "./confTabs.css";
import {
  allTimezones,
  browserTimezone,
  searchTimezones,
} from "./cronView";

export function TimezoneCombobox({
  value,
  onChange,
  className,
  fallbackTz,
}: {
  value: string;
  onChange: (tz: string) => void;
  className?: string;
  /** Shown when no value is set — the caller's default (e.g. the user's
   *  preferred zone from Settings), falling back to the browser's. */
  fallbackTz?: string;
}) {
  const zones = useMemo(() => allTimezones(), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // No supportedValuesOf (old runtime): keep the current free-text behavior.
  if (zones.length === 0) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallbackTz || browserTimezone() || "America/Toronto"}
        className={className}
      />
    );
  }

  // No cap: an empty query must list every zone (the popover scrolls). Capping
  // hid zones past the ~60th (America/Argentina/Salta) unless you searched.
  const shown = searchTimezones(zones, query, zones.length, value || undefined);
  const label =
    value !== ""
      ? value
      : fallbackTz || browserTimezone() || m.cron_tz_default();

  return (
    // modal: the combobox lives INSIDE the modal edit Dialog, whose scroll
    // lock (react-remove-scroll) neutralizes wheel events on portaled
    // content — a non-modal popover's zone list simply would not scroll.
    <Popover
      modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`oc-tzcombo__trigger${className ? ` ${className}` : ""}`}
          aria-label={m.cron_tz_label()}
        >
          <span className="oc-tzcombo__value">{label}</span>
          <ChevronsUpDown size={14} aria-hidden className="oc-tzcombo__chev" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="oc-tzcombo__pop p-0">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={m.cron_tz_search()}
          className="oc-tzcombo__search"
        />
        <div className="oc-tzcombo__list" role="listbox">
          {shown.length === 0 ? (
            <p className="oc-tzcombo__empty">{m.cron_tz_none()}</p>
          ) : (
            shown.map((z) => (
              <button
                type="button"
                key={z}
                role="option"
                aria-selected={z === value}
                className="oc-tzcombo__opt"
                onClick={() => {
                  onChange(z);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <Check
                  size={13}
                  aria-hidden
                  className="oc-tzcombo__check"
                  style={{ opacity: z === value ? 1 : 0 }}
                />
                <span>{z}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
