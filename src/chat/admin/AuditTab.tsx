// Audit log tab. Extracted from AdminSettings.tsx (the eager barrel) into its own
// module so the router can lazy-load it — its data-table/filter deps are part of the
// ~217 KB admin code chat users never need before first paint. See router.tsx.
import { useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DEFAULT_FROM,
  DEFAULT_TO,
} from "@/lib/routing/searchSchemas";

// Default relative window (wide 30d) so older/seeded rows surface on load — audit had
// no time filter before, so a narrow default would hide rows older than it within the
// bounded window. Re-resolves to NOW via useResolvedRange so the subscription stays current.
const DEFAULT_RANGE: TimeRange = {
  kind: "relative",
  from: DEFAULT_FROM,
  to: DEFAULT_TO,
};

// "Select all" sentinel for the quick <Select>s (radix Select has no empty value),
// mapped back to `undefined` (no filter) when building the query arg.
const ALL = "__all__";

const AUDIT_ADV_FIELDS = [
  { value: "action", label: "action" },
  { value: "realLabel", label: "acteur réel" },
  { value: "targetLabel", label: "au nom de" },
  { value: "impersonated", label: "usurpation" },
  { value: "resource", label: "ressource" },
  { value: "resourceId", label: "id ressource" },
];

export function AuditTab() {
  const search = useSearch({ from: "/settings/audit" });
  const navigate = useNavigate({ from: "/settings/audit" });

  const q = search.q ?? "";
  const action = search.action ?? ALL;
  const impersonated = search.impersonated ?? ALL; // "yes" | "no" | ALL
  const resource = search.resource ?? ALL;
  // URL stores time-range TOKENS; resolve to live epoch ms at component level.
  const range = decodeRange(search.from, search.to);
  const advanced = useMemo(() => parseAdv(search.adv), [search.adv]);
  const { from, to } = useResolvedRange(range);

  const setQ = (v: string) =>
    void navigate({ search: (p) => ({ ...p, q: v || undefined }), replace: true });
  const setAction = (v: string) =>
    void navigate({ search: (p) => ({ ...p, action: v === ALL ? undefined : v }) });
  const setImpersonated = (v: string) =>
    void navigate({
      search: (p) => ({ ...p, impersonated: v === ALL ? undefined : (v as "yes" | "no") }),
    });
  const setResource = (v: string) =>
    void navigate({ search: (p) => ({ ...p, resource: v === ALL ? undefined : v }) });
  const setRange = (r: TimeRange) =>
    void navigate({ search: (p) => ({ ...p, ...encodeRange(r) }) });
  // AdvancedFilter emits on EVERY keystroke → replace (no per-keystroke history
  // / subscription spam). It does not emit on mount, so a loaded URL `adv` is
  // not clobbered.
  const setAdvanced = (preds: Predicate[]) =>
    void navigate({ search: (p) => ({ ...p, adv: encodeAdv(preds) }), replace: true });

  const rows = useQuery(api.admin.listAudit, {
    filter: {
      q: q || undefined,
      from,
      to,
      action: action === ALL ? undefined : action,
      resource: resource === ALL ? undefined : resource,
      impersonated: impersonated === ALL ? undefined : impersonated === "yes",
      advanced: advanced.length > 0 ? advanced : undefined,
    },
  });

  // Dynamic option lists derived from the loaded window.
  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) set.add(r.action);
    return [...set].sort();
  }, [rows]);
  const resourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) if (r.resource) set.add(r.resource);
    return [...set].sort();
  }, [rows]);

  const active =
    q !== "" ||
    action !== ALL ||
    impersonated !== ALL ||
    resource !== ALL ||
    advanced.length > 0 ||
    range.kind !== "relative" ||
    range.from !== DEFAULT_RANGE.from;
  function reset() {
    void navigate({ search: {}, replace: true });
  }

  return (
    <>
      <p className="oc-admin__hint">
        {m.settings_audit_hint()}{" "}
        <span className="oc-filter__window">
          {m.settings_audit_window_hint()}
        </span>
      </p>
      <FilterBar
        q={q}
        onQChange={setQ}
        searchPlaceholder={m.settings_audit_search_placeholder()}
        timeRange={range}
        onTimeRangeChange={setRange}
        onReset={reset}
        canReset={active}
      >
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={m.settings_action()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.settings_all_actions()}</SelectItem>
            {actionOptions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={impersonated} onValueChange={setImpersonated}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.settings_impersonation_all()}</SelectItem>
            <SelectItem value="yes">{m.settings_impersonation_yes()}</SelectItem>
            <SelectItem value="no">{m.settings_impersonation_no()}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={resource} onValueChange={setResource}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder={m.settings_resource()} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{m.settings_all_resources()}</SelectItem>
            {resourceOptions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>
      <AdvancedFilter
        fields={AUDIT_ADV_FIELDS}
        seed={advanced}
        onChange={setAdvanced}
      />
      <DataTableShell
        title={m.settings_audit_title()}
        rows={rows}
        emptyHint={m.settings_audit_empty()}
        columns={[
          {
            header: m.settings_col_when(),
            cell: (r) => new Date(r.at).toLocaleString("fr-FR"),
            sort: (r) => r.at,
          },
          { header: m.settings_action(), cell: (r) => r.action, sort: (r) => r.action },
          {
            header: m.settings_col_real_actor(),
            cell: (r) => r.realLabel,
            sort: (r) => r.realLabel,
          },
          {
            header: m.settings_col_on_behalf_of(),
            cell: (r) => r.targetLabel ?? "—",
            sort: (r) => r.targetLabel ?? null,
          },
          {
            header: m.settings_resource(),
            cell: (r) =>
              r.resource
                ? r.resource +
                  (r.resourceId ? ` · ${r.resourceId.slice(0, 8)}` : "")
                : "—",
            sort: (r) => r.resource ?? null,
          },
        ]}
      />
    </>
  );
}
