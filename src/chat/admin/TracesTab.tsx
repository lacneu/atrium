import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { X } from "lucide-react";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { FilterBar } from "./filters/FilterBar";
import { AdvancedFilter } from "./filters/AdvancedFilter";
import { useResolvedRange } from "./filters/TimeRangePicker";
import type { Predicate, TimeRange } from "./filters/types";
import {
  decodeRange,
  encodeRange,
  encodeAdv,
  parseAdv,
} from "@/lib/routing/searchSchemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages.js";

// "Traces" tab — recent observability events (D2: redacted metadata only, no
// message content). Reads api.observability.listEvents, an admin query that
// returns a BOUNDED recent window (newest first). All filtering described below
// that is NOT a backend arg happens client-side over that fetched window.
//
// Two-query structure (the non-obvious bit):
//  - `unfiltered` (no kind) feeds BOTH the kind <Select> option list AND the
//    "follow a turn" correlationId filter. Deriving the option list from the
//    UNfiltered window means picking a kind never collapses the dropdown, and a
//    correlationId turn spanning multiple kinds is shown whole.
//  - `filtered` (kind passed to the backend, which over-fetches + post-filters)
//    is what the table renders in the normal case. Server-side `kind` is kept
//    because it surfaces rare kinds the bounded `unfiltered` window might miss.
//  When kind === "all" both queries have identical args, so Convex dedupes the
//  subscription (no extra cost in the common case).

type TraceEventView = {
  _id: Id<"traceEvents">;
  at: number;
  kind: string;
  direction: "inbound" | "outbound" | "internal" | null;
  principalType: "user" | "service" | "system";
  principalId: string | null;
  roleKey: string | null;
  route: string | null;
  method: string | null;
  status: number | null;
  latencyMs: number | null;
  chatId: string | null;
  runId: string | null;
  correlationId: string | null;
  redacted: boolean;
  meta: string | null;
};

// Backend caps at MAX_LIST_LIMIT (500); offer a few sensible window sizes.
const LIMIT_OPTIONS = [50, 100, 200, 500] as const;
type LimitValue = (typeof LIMIT_OPTIONS)[number];

const ALL_KINDS = "all";
// "Select all" sentinel for the new quick <Select>s (radix has no empty value).
const ALL = "__all__";

// Fixed enum option lists (closed sets — not derived from the window).
const STATUS_CLASSES = ["2xx", "4xx", "5xx"] as const;
const PRINCIPAL_TYPES = ["user", "service", "system"] as const;
const DIRECTIONS = ["inbound", "outbound", "internal"] as const;

// Default time window for the traces table. Wide (30d) so seeded/older events
// surface on load — traces previously had NO time filter, so a narrow default
// would silently hide rows older than it within the bounded window.
const DEFAULT_RANGE: TimeRange = { kind: "relative", from: "now-30d", to: "now" };

// Field list for the traces advanced builder (view fields the backend exposes).
const TRACES_ADV_FIELDS = [
  { value: "kind", label: "kind" },
  { value: "status", label: "status" },
  { value: "latencyMs", label: "latence (ms)" },
  { value: "principalType", label: "principal" },
  { value: "direction", label: "direction" },
  { value: "roleKey", label: "rôle" },
  { value: "route", label: "route" },
  { value: "correlationId", label: "correlationId" },
];

export function TracesTab() {
  const search = useSearch({ from: "/settings/traces" });
  const navigate = useNavigate({ from: "/settings/traces" });

  // `limit` + `kind` are TOP-LEVEL query args (not inside `filter`).
  const limit = search.limit as LimitValue;
  const kind = search.kind;
  // Named *Filter to avoid shadowing the module-level statusClass() helper that
  // colors the status column (a bare `statusClass` would no longer be callable).
  const statusClassFilter = search.statusClass ?? ALL;
  const principalType = search.principalType ?? ALL;
  const direction = search.direction ?? ALL;
  const roleKey = search.roleKey ?? ALL;
  const q = search.q ?? "";
  // URL stores time-range TOKENS; resolve to live epoch ms at component level.
  const range = decodeRange(search.from, search.to);
  const advanced = useMemo(() => parseAdv(search.adv), [search.adv]);
  const { from, to } = useResolvedRange(range);

  // Active "follow a turn" filter (client-only ephemeral, over the unfiltered
  // window). The open `meta` row is also client-only. Both intentionally STAY
  // in useState (losing them on refresh is acceptable).
  const [followCorr, setFollowCorr] = useState<string | null>(null);
  const [metaRow, setMetaRow] = useState<TraceEventView | null>(null);

  const setLimit = (v: LimitValue) =>
    void navigate({ search: (p) => ({ ...p, limit: v }) });
  const setKind = (v: string) =>
    void navigate({ search: (p) => ({ ...p, kind: v }) });
  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setStatusClassFilter = (v: string) =>
    void navigate({
      search: (p) => ({
        ...p,
        statusClass: v === ALL ? undefined : (v as "2xx" | "4xx" | "5xx"),
      }),
    });
  const setPrincipalType = (v: string) =>
    void navigate({
      search: (p) => ({
        ...p,
        principalType: v === ALL ? undefined : (v as "user" | "service" | "system"),
      }),
    });
  const setDirection = (v: string) =>
    void navigate({
      search: (p) => ({
        ...p,
        direction: v === ALL ? undefined : (v as "inbound" | "outbound" | "internal"),
      }),
    });
  const setRoleKey = (v: string) =>
    void navigate({ search: (p) => ({ ...p, roleKey: v === ALL ? undefined : v }) });
  const setRange = (r: TimeRange) =>
    void navigate({ search: (p) => ({ ...p, ...encodeRange(r) }) });
  // AdvancedFilter emits on EVERY keystroke → replace (no history/subscription
  // spam). It does not emit on mount, so a loaded URL `adv` is not clobbered.
  const setAdvanced = (preds: Predicate[]) =>
    void navigate({ search: (p) => ({ ...p, adv: encodeAdv(preds) }), replace: true });

  // Option list + correlation base: never kind- nor filter-narrowed (see note).
  const unfiltered = useQuery(api.observability.listEvents, { limit }) as
    | TraceEventView[]
    | undefined;
  // Table source in the normal case. Map the synthetic "all" to undefined so we
  // never ask the backend to filter for a literal "all" kind (→ empty result).
  // The new quick/time/advanced filters ride the `filter` arg here.
  const filtered = useQuery(api.observability.listEvents, {
    limit,
    kind: kind === ALL_KINDS ? undefined : kind,
    filter: {
      q: q || undefined,
      from,
      to,
      statusClass:
        statusClassFilter === ALL
          ? undefined
          : (statusClassFilter as "2xx" | "4xx" | "5xx"),
      principalType: principalType === ALL ? undefined : principalType,
      direction: direction === ALL ? undefined : direction,
      roleKey: roleKey === ALL ? undefined : roleKey,
      advanced: advanced.length > 0 ? advanced : undefined,
    },
  }) as TraceEventView[] | undefined;

  // Distinct kinds present in the unfiltered window (stable; does not collapse
  // when a kind is selected). Sorted for a predictable dropdown order.
  const kindOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of unfiltered ?? []) set.add(e.kind);
    return [...set].sort();
  }, [unfiltered]);

  // Distinct roleKeys present in the unfiltered window (dynamic; like kinds).
  const roleOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of unfiltered ?? []) if (e.roleKey) set.add(e.roleKey);
    return [...set].sort();
  }, [unfiltered]);

  const filtersActive =
    q !== "" ||
    statusClassFilter !== ALL ||
    principalType !== ALL ||
    direction !== ALL ||
    roleKey !== ALL ||
    advanced.length > 0 ||
    range.kind !== "relative" ||
    range.from !== DEFAULT_RANGE.from;
  function resetFilters() {
    // Reset to the schema defaults. `limit`/`kind` have non-optional output
    // types (zod defaults), so they must be set explicitly here; every other
    // field drops to undefined (its default).
    void navigate({ search: { limit: 100, kind: "all" }, replace: true });
  }

  // Following a correlationId wins over the kind filter: it reads from the
  // unfiltered window so the WHOLE turn (across kinds) is shown. Otherwise the
  // kind-filtered window is the table source.
  const rows: TraceEventView[] | undefined = followCorr
    ? unfiltered?.filter((e) => e.correlationId === followCorr)
    : filtered;

  return (
    <>
      <p className="oc-admin__hint">
        {m.traces_hint_before()}<strong>{m.traces_hint_redacted()}</strong>{m.traces_hint_after()}{" "}
        <span className="oc-filter__window">
          {m.traces_hint_window()}
        </span>
      </p>

      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder={m.traces_search_placeholder()}
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={resetFilters}
        canReset={filtersActive}
      >
        <Select value={statusClassFilter} onValueChange={setStatusClassFilter}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder={m.traces_filter_status()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.traces_filter_status_all()}</SelectItem>
            {STATUS_CLASSES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={principalType} onValueChange={setPrincipalType}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder={m.traces_filter_principal()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.traces_filter_principal_all()}</SelectItem>
            {PRINCIPAL_TYPES.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder={m.traces_filter_direction()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.traces_filter_direction_all()}</SelectItem>
            {DIRECTIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={roleKey} onValueChange={setRoleKey}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder={m.traces_filter_role()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.traces_filter_role_all()}</SelectItem>
            {roleOptions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder={m.traces_filter_kind_placeholder()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_KINDS}>{m.traces_filter_kind_all()}</SelectItem>
            {kindOptions.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(limit)}
          onValueChange={(v) => setLimit(Number(v) as LimitValue)}
        >
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIMIT_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {m.traces_rows_count({ count: n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      <AdvancedFilter
        fields={TRACES_ADV_FIELDS}
        seed={advanced}
        onChange={setAdvanced}
      />

      {followCorr ? (
        <div className="oc-traces__followline">
          <button
            type="button"
            className="oc-traces__chip"
            onClick={() => setFollowCorr(null)}
            title={m.traces_clear_correlation_filter()}
          >
            <span className="oc-traces__chip-label">
              {m.traces_chip_correlation_label()}
              <code>{shortId(followCorr)}</code>
            </span>
            <X className="oc-traces__chip-x" aria-hidden />
            <span className="sr-only">{m.traces_clear()}</span>
          </button>
        </div>
      ) : null}

      <DataTableShell
        title={m.traces_table_title()}
        rows={rows}
        emptyHint={
          followCorr
            ? m.traces_empty_correlation()
            : m.traces_empty_default()
        }
        columns={[
          {
            header: m.traces_col_when(),
            cell: (r) => (
              <span className="oc-traces__time">
                {new Date(r.at).toLocaleString("fr-FR")}
              </span>
            ),
          },
          {
            header: m.traces_col_kind(),
            cell: (r) => <Badge variant="secondary">{r.kind}</Badge>,
          },
          {
            // Failure marker — makes error rows (dispatch failed, stream
            // error/aborted, ingest denied, HTTP >=400) jump out across kinds,
            // with the curated cause code so the eye lands on what's wrong.
            header: m.traces_col_result(),
            cell: (r) => {
              const fail = traceFailureCode(r);
              return fail ? (
                <span className="oc-traces__fail" title={fail}>
                  ✕ {fail}
                </span>
              ) : (
                <span className="oc-traces__ok" aria-label={m.traces_ok_aria()}>
                  ✓
                </span>
              );
            },
          },
          {
            header: m.traces_col_direction(),
            cell: (r) =>
              r.direction ? (
                <Badge variant="outline">{r.direction}</Badge>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: m.traces_col_principal(),
            cell: (r) => (
              <span className="oc-traces__principal">
                <Badge variant="outline">{r.principalType}</Badge>
                {r.principalId ? (
                  <code className="oc-traces__mono">
                    {shortId(r.principalId)}
                  </code>
                ) : null}
              </span>
            ),
          },
          {
            header: m.traces_col_role(),
            cell: (r) =>
              r.roleKey ? (
                <Badge variant="secondary">{r.roleKey}</Badge>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: m.traces_col_route(),
            cell: (r) =>
              r.route ? (
                <span className="oc-traces__route">
                  {r.method ? (
                    <span className="oc-traces__method">{r.method}</span>
                  ) : null}
                  <code className="oc-traces__mono">{r.route}</code>
                </span>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: m.traces_col_status(),
            cell: (r) =>
              r.status === null ? (
                <span className="oc-traces__muted">—</span>
              ) : (
                <span
                  className={`oc-traces__status ${statusClass(r.status)}`}
                >
                  {r.status}
                </span>
              ),
          },
          {
            header: m.traces_col_latency(),
            cell: (r) =>
              r.latencyMs === null ? (
                <span className="oc-traces__muted">—</span>
              ) : (
                <span className="oc-traces__mono">{r.latencyMs} ms</span>
              ),
          },
          {
            header: m.traces_col_correlation(),
            cell: (r) =>
              r.correlationId ? (
                <button
                  type="button"
                  className="oc-traces__corr"
                  title={m.traces_follow_turn()}
                  onClick={() => setFollowCorr(r.correlationId)}
                >
                  {shortId(r.correlationId)}
                </button>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
          {
            header: m.traces_col_meta(),
            cell: (r) =>
              r.meta ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMetaRow(r)}
                >
                  {m.traces_view()}
                </Button>
              ) : (
                <span className="oc-traces__muted">—</span>
              ),
          },
        ]}
      />

      <MetaDialog row={metaRow} onClose={() => setMetaRow(null)} />
    </>
  );
}

// Color the status by HTTP class. Hex literals live in convexChat.css (the one
// constraint-allowed exception); here we only pick the class.
function statusClass(status: number): string {
  if (status >= 500) return "oc-traces__status--5xx";
  if (status >= 400) return "oc-traces__status--4xx";
  if (status >= 200 && status < 300) return "oc-traces__status--2xx";
  return "oc-traces__status--other";
}

// First 8 chars is enough to recognize an id/correlationId at a glance.
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// A trace row's failure code (curated, non-PHI) if it represents an error, else
// null. Cross-kind: HTTP >=400, a failed dispatch (with its errorCode), a stream
// error/aborted finalize, or an ingest denial. Drives the red "Résultat" marker.
function traceFailureCode(r: TraceEventView): string | null {
  if (typeof r.status === "number" && r.status >= 400) return String(r.status);
  if (!r.meta) return null;
  try {
    const m = JSON.parse(r.meta) as {
      dispatchStatus?: string;
      errorCode?: string;
      phase?: string;
      streamStatus?: string;
    };
    if (r.kind === "openclaw.dispatch" && m.dispatchStatus === "failed") {
      return m.errorCode ?? "failed";
    }
    if (
      r.kind === "assistant.stream" &&
      m.phase === "finalize" &&
      (m.streamStatus === "error" || m.streamStatus === "aborted")
    ) {
      return m.streamStatus;
    }
    if (r.kind === "openclaw.ingest.denied") return "denied";
  } catch {
    // meta isn't JSON — not a failure we can classify
  }
  return null;
}

// Shared meta viewer: pretty-prints the row's JSON `meta` (falling back to the
// raw string if it isn't valid JSON). Reassures that traces are redacted
// metadata — no message content is ever stored.
function MetaDialog({
  row,
  onClose,
}: {
  row: TraceEventView | null;
  onClose: () => void;
}) {
  const pretty = useMemo(() => {
    if (!row?.meta) return "";
    try {
      return JSON.stringify(JSON.parse(row.meta), null, 2);
    } catch {
      // Not valid JSON — show the raw stored string rather than nothing.
      return row.meta;
    }
  }, [row]);

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {row ? (
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="oc-traces__meta-title">
              {m.traces_meta_dialog_title()} <code>{row.kind}</code>
              <Badge variant="outline">{m.traces_meta_redacted_badge()}</Badge>
            </DialogTitle>
            <DialogDescription>
              {m.traces_meta_dialog_description()}
            </DialogDescription>
          </DialogHeader>
          <pre className="oc-traces__meta-json">{pretty}</pre>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
