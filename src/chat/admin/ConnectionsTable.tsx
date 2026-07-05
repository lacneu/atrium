import { Fragment, useMemo, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { api } from "../convexApi";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { dispatchErrorInfo } from "@/lib/dispatchErrorInfo";
import { formatTime } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { FilterBar } from "./filters/FilterBar";
import { showsBridgeErrorDetail, showsDownstreamReject } from "./bridgeHealthView";
import {
  ALL,
  EMPTY_CONN_FILTERS,
  distinctInstances,
  distinctStates,
  distinctVersions,
  filterConnections,
  hasActiveConnFilters,
  sortConnections,
  type ConnFilters,
  type ConnSort,
  type ConnSortKey,
} from "./connectionsTableView";

// The Bridge tab's "Connexions" list, as a real data table: sortable columns
// (click a header to cycle asc → desc → off), per-column filters via the shared
// FilterBar (search + state/instance/version <Select>s + Reset), and the
// existing error detail preserved as a full-width sub-row under any errored
// connection. Sort/filter LOGIC is the pure, unit-tested connectionsTableView;
// this component is just the wiring + cells.

type Target = NonNullable<
  FunctionReturnType<typeof api.bridgeHealth.getBridgeHealth>
>["targets"][number];

// One table row: the flattened fields the pure sort/filter helpers read (it
// structurally satisfies ConnFields) PLUS the error fields the detail sub-row
// needs. Optional target fields are normalized undefined → null at map time, so
// the row cleanly satisfies ConnFields (which forbids undefined).
type RowView = {
  _id: string;
  targetLabel: string;
  state: string;
  instanceName: string | null;
  instanceLabel: string | null;
  gatewayHost: string;
  gatewayVersion: string | null;
  okCount: number;
  errorCount: number;
  attempts: number;
  lastOkAt: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  lastDownstreamRejectCode: string | null;
  lastDownstreamRejectAt: number | null;
};

export function ConnectionsTable({
  connections,
  displayByInstance,
}: {
  connections: Target[];
  displayByInstance: Map<string, string>;
}) {
  const [filters, setFilters] = useState<ConnFilters>(EMPTY_CONN_FILTERS);
  const [sort, setSort] = useState<ConnSort | null>(null);

  const rows = useMemo<RowView[]>(
    () =>
      // `t.key` is per-CANONICAL (the bridge groups targets by user), so two
      // agents of one user — or a duplicate target in the health data — collide.
      // Compose a row id from key + target + the ORIGINAL index: unique, and stable
      // across sort/filter (the id rides the row object, not its position).
      connections.map((t, i) => ({
        _id: `${t.key}:${t.canonical}/${t.agentId}:${i}`,
        targetLabel: `${t.canonical}/${t.agentId}`,
        state: t.state,
        instanceName: t.instanceName ?? null,
        instanceLabel: t.instanceName
          ? (displayByInstance.get(t.instanceName) ?? t.instanceName)
          : null,
        gatewayHost: t.gatewayHost,
        gatewayVersion: t.gatewayVersion ?? null,
        okCount: t.okCount,
        errorCount: t.errorCount,
        attempts: t.attempts,
        lastOkAt: t.lastOkAt ?? null,
        lastErrorCode: t.lastErrorCode ?? null,
        lastErrorAt: t.lastErrorAt ?? null,
        lastDownstreamRejectCode: t.lastDownstreamRejectCode ?? null,
        lastDownstreamRejectAt: t.lastDownstreamRejectAt ?? null,
      })),
    [connections, displayByInstance],
  );

  // Option lists come from ALL rows (not the filtered set), so picking one value
  // never collapses the other dropdowns.
  const stateOptions = useMemo(() => distinctStates(rows), [rows]);
  const instanceOptions = useMemo(() => distinctInstances(rows), [rows]);
  const versionOptions = useMemo(() => distinctVersions(rows), [rows]);

  const visible = useMemo(
    () => sortConnections(filterConnections(rows, filters), sort),
    [rows, filters, sort],
  );

  // Cycle a column: not-sorted → asc → desc → off (sort is NOT part of reset).
  function toggleSort(key: ConnSortKey) {
    setSort((s) => {
      if (s?.key !== key) return { key, dir: "asc" };
      if (s.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  if (connections.length === 0) {
    return <p className="oc-admin__hint">{m.bridge_no_connection_tested()}</p>;
  }

  return (
    <div className="oc-conn">
      <FilterBar
        q={filters.q}
        onQChange={(q) => setFilters((f) => ({ ...f, q }))}
        searchPlaceholder={m.bridge_conn_search_placeholder()}
        onReset={() => setFilters(EMPTY_CONN_FILTERS)}
        canReset={hasActiveConnFilters(filters)}
      >
        <Select
          value={filters.state}
          onValueChange={(v) => setFilters((f) => ({ ...f, state: v }))}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder={m.bridge_conn_filter_state()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.bridge_conn_filter_all()}</SelectItem>
            {stateOptions.map((s) => (
              <SelectItem key={s} value={s}>
                {stateLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.instance}
          onValueChange={(v) => setFilters((f) => ({ ...f, instance: v }))}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={m.bridge_conn_filter_instance()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.bridge_conn_filter_all()}</SelectItem>
            {instanceOptions.map((i) => (
              <SelectItem key={i.name} value={i.name}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.version}
          onValueChange={(v) => setFilters((f) => ({ ...f, version: v }))}
        >
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder={m.bridge_conn_filter_version()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.bridge_conn_filter_all()}</SelectItem>
            {versionOptions.map((v) => (
              <SelectItem key={v} value={v}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      {visible.length === 0 ? (
        <p className="oc-admin__hint">{m.bridge_conn_no_match()}</p>
      ) : (
        <Table className="oc-conn__table">
          <TableHeader>
            <TableRow>
              <SortHeader
                label={m.bridge_conn_col_target()}
                sortKey="target"
                sort={sort}
                onSort={toggleSort}
              />
              <SortHeader
                label={m.bridge_conn_col_state()}
                sortKey="state"
                sort={sort}
                onSort={toggleSort}
              />
              <SortHeader
                label={m.bridge_conn_col_instance()}
                sortKey="instance"
                sort={sort}
                onSort={toggleSort}
              />
              <SortHeader
                label={m.bridge_conn_col_host()}
                sortKey="host"
                sort={sort}
                onSort={toggleSort}
              />
              <SortHeader
                label={m.bridge_conn_col_version()}
                sortKey="version"
                sort={sort}
                onSort={toggleSort}
              />
              <TableHead>{m.bridge_conn_col_stats()}</TableHead>
              <SortHeader
                label={m.bridge_conn_col_last_ok()}
                sortKey="lastOk"
                sort={sort}
                onSort={toggleSort}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <ConnectionRows key={r._id} r={r} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// A sortable column header: clicking cycles the sort; aria-sort reflects state.
function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: ConnSortKey;
  sort: ConnSort | null;
  onSort: (key: ConnSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <TableHead
      aria-sort={
        active ? (dir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className="oc-conn__sort"
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ChevronUp size={13} aria-hidden />
          ) : (
            <ChevronDown size={13} aria-hidden />
          )
        ) : (
          <ChevronsUpDown
            size={13}
            aria-hidden
            className="oc-conn__sort-idle"
          />
        )}
      </button>
    </TableHead>
  );
}

// The data row + (when the connection is in error / downstream-rejected) a
// full-width detail sub-row immediately beneath it — preserving the diagnostic
// information the card list used to show.
function ConnectionRows({ r }: { r: RowView }) {
  const info = showsBridgeErrorDetail(r) ? dispatchErrorInfo(r.lastErrorCode) : null;
  const downstream = showsDownstreamReject(r)
    ? dispatchErrorInfo(r.lastDownstreamRejectCode)
    : null;
  return (
    <Fragment>
      <TableRow className={`oc-conn__row oc-conn__row--${r.state}`}>
        <TableCell>
          <code className="oc-traces__mono">{r.targetLabel}</code>
        </TableCell>
        <TableCell>
          <TargetStateBadge state={r.state} />
        </TableCell>
        <TableCell>
          {r.instanceLabel ? (
            <span className="oc-bridge-target__instance">{r.instanceLabel}</span>
          ) : (
            <span className="oc-traces__muted">—</span>
          )}
        </TableCell>
        <TableCell>
          <span className="oc-bridge-target__host">{r.gatewayHost}</span>
        </TableCell>
        <TableCell>
          {r.gatewayVersion ? (
            <span className="oc-bridge-target__version">{r.gatewayVersion}</span>
          ) : (
            <span className="oc-traces__muted">—</span>
          )}
        </TableCell>
        <TableCell>
          <span className="oc-conn__stats">
            {m.bridge_target_stats({
              ok: r.okCount,
              errors: r.errorCount,
              attempts: r.attempts,
            })}
          </span>
        </TableCell>
        <TableCell>
          {r.lastOkAt ? (
            <span className="oc-traces__mono">
              {formatTime(r.lastOkAt)}
            </span>
          ) : (
            <span className="oc-traces__muted">—</span>
          )}
        </TableCell>
      </TableRow>
      {info || downstream ? (
        <TableRow className="oc-conn__detail-row">
          <TableCell colSpan={7} className="oc-conn__detail-cell">
            {info ? (
              <div className="oc-bridge-target__error">
                <strong>{info.label}</strong>{" "}
                <code className="oc-traces__mono">{r.lastErrorCode}</code>
                {r.lastErrorAt ? ` · ${formatTime(r.lastErrorAt)}` : ""}
                <p className="oc-bridge-card__hint">{info.hint}</p>
              </div>
            ) : null}
            {downstream ? (
              <div className="oc-bridge-target__downstream">
                {m.bridge_target_downstream_reject({ label: downstream.label })}{" "}
                <code className="oc-traces__mono">
                  {r.lastDownstreamRejectCode}
                </code>
                {r.lastDownstreamRejectAt
                  ? ` · ${formatTime(r.lastDownstreamRejectAt)}`
                  : ""}
              </div>
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

function stateLabel(state: string): string {
  if (state === "connected") return m.bridge_state_connected();
  if (state === "error") return m.bridge_state_error();
  return m.bridge_state_inactive();
}

function TargetStateBadge({ state }: { state: string }) {
  if (state === "connected")
    return <Badge variant="secondary">{m.bridge_state_connected()}</Badge>;
  if (state === "error")
    return <Badge variant="destructive">{m.bridge_state_error()}</Badge>;
  return <Badge variant="outline">{m.bridge_state_inactive()}</Badge>;
}
