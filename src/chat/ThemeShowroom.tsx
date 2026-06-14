import { useState } from "react";
import { MoreVertical, Check, X, Upload } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterBar } from "./admin/filters/FilterBar";
import { TimeRangePicker } from "./admin/filters/TimeRangePicker";
import { AdvancedFilter, type AdvancedField } from "./admin/filters/AdvancedFilter";
import type { TimeRange } from "./admin/filters/types";
import { m } from "@/paraglide/messages.js";
import type { Locale } from "@/lib/useLocale";
import type { ThemeMode } from "@/lib/useTheme";
import { useResolvedMode } from "@/lib/useChart";
import { cn } from "@/lib/utils";
import { BUILTIN_CHARTS, type ChartTokens } from "../../convex/lib/charts";

// Living style guide + Apparence settings. The component showroom (collapsed
// <details> at the bottom) renders every component the app uses with the active
// design tokens, the way ui.shadcn.com does — use it to verify a charte in both
// light and dark (toggle from the top-bar theme switcher).

// "Select all" sentinel (radix has no empty value), mirrors the admin tabs.
const SHOW_ALL = "__all__";
const SHOW_RANGE: TimeRange = { kind: "relative", from: "now-24h", to: "now" };
// Demo fields for the advanced-filter builder (no backend; preview only).
const SHOW_ADV_FIELDS: AdvancedField[] = [
  { value: "status", label: "Statut" },
  { value: "latencyMs", label: "Latence (ms)" },
  { value: "route", label: "Route" },
  { value: "roleKey", label: "Rôle" },
  { value: "correlationId", label: "Corrélation" },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="oc-show__section">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">{title}</h2>
        {description ? (
          <p className="oc-show__desc">{description}</p>
        ) : null}
      </div>
      <div className="oc-show__demo">{children}</div>
    </section>
  );
}

function themeModeLabel(mode: ThemeMode): string {
  return mode === "light"
    ? m.usermenu_theme_light()
    : mode === "dark"
      ? m.usermenu_theme_dark()
      : m.usermenu_theme_system();
}

// ===========================================================================
// USER: "Ma charte graphique" picker (visible to ALL approved users)
// ===========================================================================

// A few representative tokens to preview as swatches for the CURRENT mode, so
// the card shows the real palette before it is applied.
const PREVIEW_TOKENS = [
  "primary",
  "secondary",
  "accent",
  "muted",
  "chart-1",
  "chart-2",
] as const;

function ChartSwatches({
  tokens,
  mode,
}: {
  tokens: ChartTokens;
  mode: "light" | "dark";
}) {
  const colors = tokens.colors[mode];
  return (
    <div className="oc-chart-swatches" aria-hidden>
      {PREVIEW_TOKENS.map((t) => {
        const value = colors[t];
        return (
          <span
            key={t}
            className="oc-chart-swatch"
            style={value ? { background: value } : undefined}
          />
        );
      })}
    </div>
  );
}

// One selectable card: the synthesized app-default (null) entry, or a builtin
// chart with its provenance (in the subtitle) + live swatches.
function ChartCard({
  selected,
  title,
  subtitle,
  tokens,
  mode,
  onSelect,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  tokens: ChartTokens | null;
  mode: "light" | "dark";
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn("oc-chart-card", selected && "oc-chart-card--selected")}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <div className="oc-chart-card__head">
        <span className="oc-chart-card__title">{title}</span>
        {selected ? (
          <Check className="size-4 text-primary" aria-hidden />
        ) : null}
      </div>
      {tokens ? (
        <ChartSwatches tokens={tokens} mode={mode} />
      ) : (
        <div className="oc-chart-swatches oc-chart-swatches--native" aria-hidden />
      )}
      <div className="oc-chart-card__meta">
        <span className="oc-chart-card__subtitle">{subtitle}</span>
      </div>
    </button>
  );
}

// One chart offered to the user. P4: the backend resolves `tokens` server-side
// (builtin from the registry OR custom from the DB) so the picker renders swatches
// without a client-side key->tokens map. `kind`/`chartId`/`restrictedToGroups`
// drive the owner-management list (the `via:"owner"` entries).
type MyChart = {
  key: string;
  name: string;
  via: "common" | "owner" | { group: string };
  kind: "builtin" | "custom";
  chartId?: Id<"charts">;
  tokens: ChartTokens;
  restrictedToGroups:
    | Array<{ groupId: Id<"groups">; key: string; name: string }>
    | null;
};

// The per-user palette picker. `selectedKey` is the user's RAW pick (me.chartKey,
// null = app-default) — NOT the resolved key — so picking the app-default entry
// highlights it rather than the admin default it falls back to.
function MyChartPicker({
  selectedKey,
  resolvedMode,
}: {
  selectedKey: string | null;
  resolvedMode: "light" | "dark";
}) {
  const charts = useQuery(api.charts.listMyCharts) as MyChart[] | undefined;
  const setMyChart = useMutation(api.charts.setMyChart);

  async function choose(name: string | null) {
    try {
      await setMyChart({ name });
    } catch {
      // The picker only offers available charts, so a reject is unexpected;
      // surface nothing intrusive (the selection simply won't move).
    }
  }

  return (
    <section className="oc-show__section">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">{m.charts_user_section_title()}</h2>
        <p className="oc-show__desc">{m.charts_user_section_desc()}</p>
      </div>
      <div className="oc-chart-grid">
        {/* Synthesized app-default entry (null) — the native look. */}
        <ChartCard
          selected={selectedKey === null}
          title={m.charts_app_default_name()}
          subtitle={m.charts_app_default_desc()}
          tokens={null}
          mode={resolvedMode}
          onSelect={() => void choose(null)}
        />
        {(charts ?? []).map((c) => {
          // P4: tokens come resolved from the server (builtin OR custom) — no
          // client-side builtinChart lookup, so custom charts are visible here.
          const badge =
            c.via === "common"
              ? m.charts_via_common()
              : c.via === "owner"
                ? m.charts_via_owner()
                : m.charts_via_group({ group: c.via.group });
          return (
            <ChartCard
              key={c.key}
              selected={selectedKey === c.key}
              title={c.name}
              subtitle={badge}
              tokens={c.tokens}
              mode={resolvedMode}
              onSelect={() => void choose(c.key)}
            />
          );
        })}
      </div>
      {charts !== undefined && charts.length === 0 ? (
        <p className="oc-show__desc">{m.charts_empty()}</p>
      ) : null}
    </section>
  );
}

// A user's own group (listMyGroups shape) — the associate UI offers only THESE.
type MyGroup = { groupId: Id<"groups">; key: string; name: string };

// ===========================================================================
// USER: "Importer une charte" — paste JSON or read a small .json file as TEXT
// (NO blob upload), validated SERVER-SIDE by importChart. Validation errors and
// JSON-parse failures are surfaced inline.
// ===========================================================================

function ChartImportSection() {
  const importChart = useMutation(api.charts.importChart);
  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read a chosen .json file as TEXT client-side (no storage.store, no blob) and
  // drop it into the textarea, so the user reviews it before importing.
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setError(null);
    setOk(false);
    try {
      const text = await file.text();
      setJson(text);
    } catch {
      setError(m.charts_import_invalid_json());
    }
  }

  async function submit() {
    setError(null);
    setOk(false);
    if (name.trim() === "") {
      setError(m.charts_import_name_required());
      return;
    }
    // Parse the pasted/loaded JSON to the tokens object client-side. importChart
    // takes { name, tokens } separately; the JSON carries ONLY the tokens (the
    // name comes from the field). A parse failure is a clean, local error.
    let tokens: unknown;
    try {
      tokens = JSON.parse(json);
    } catch {
      setError(m.charts_import_invalid_json());
      return;
    }
    setBusy(true);
    try {
      await importChart({ name: name.trim(), tokens });
      setOk(true);
      setName("");
      setJson("");
    } catch (err) {
      // The server validator throws "Invalid chart: <reason>"; show the reason.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="oc-show__section">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">{m.charts_import_section_title()}</h2>
        <p className="oc-show__desc">{m.charts_import_section_desc()}</p>
      </div>
      <div className="oc-chart-import">
        <label className="oc-chart-import__field">
          <span className="oc-chart-import__label">
            {m.charts_import_name_label()}
          </span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={m.charts_import_name_placeholder()}
            maxLength={60}
          />
        </label>
        <label className="oc-chart-import__field">
          <span className="oc-chart-import__label">
            {m.charts_import_json_label()}
          </span>
          <textarea
            className="oc-chart-import__textarea"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder={m.charts_import_json_placeholder()}
            rows={8}
            spellCheck={false}
          />
        </label>
        <div className="oc-show__row">
          <Button variant="outline" size="sm" asChild>
            <label className="oc-chart-import__file">
              <Upload className="size-4" />
              {m.charts_import_file_label()}
              <input
                type="file"
                accept="application/json,.json"
                className="oc-chart-import__file-input"
                onChange={(e) => void onFile(e)}
              />
            </label>
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {m.charts_import_submit()}
          </Button>
        </div>
        {error ? <p className="oc-chart-import__error">{error}</p> : null}
        {ok ? (
          <p className="oc-chart-import__ok">{m.charts_import_success()}</p>
        ) : null}
      </div>
    </section>
  );
}

// ===========================================================================
// USER: "Mes chartes" — edit name/tokens + delete + associate to THEIR groups.
// Only the entries the user OWNS (via:"owner") show management controls.
// ===========================================================================

// Group associate/remove for ONE owned personal chart, offering only the user's
// own groups (the server gate also enforces owner+member). Mirrors the admin
// ChartAvailabilityRow but scoped to listMyGroups.
function MyChartGroups({
  chartKey,
  myGroups,
  restricted,
}: {
  chartKey: string;
  myGroups: MyGroup[];
  restricted:
    | Array<{ groupId: Id<"groups">; key: string; name: string }>
    | null;
}) {
  const assign = useMutation(api.charts.assignChartToGroup);
  const remove = useMutation(api.charts.removeChartFromGroup);
  const assignedIds = new Set((restricted ?? []).map((g) => g.groupId));
  const assignable = myGroups.filter((g) => !assignedIds.has(g.groupId));

  async function add(groupId: Id<"groups">) {
    try {
      await assign({ groupId, chartKey });
    } catch {
      // best-effort; the query re-reads the source of truth on success
    }
  }
  async function drop(groupId: Id<"groups">) {
    try {
      await remove({ groupId, chartKey });
    } catch {
      // best-effort
    }
  }

  return (
    <div className="oc-chart-avail__groups">
      <span className="oc-chart-mine__groups-label">
        {m.charts_mine_groups_label()}
      </span>
      {(restricted ?? []).map((g) => (
        <Badge key={g.groupId} variant="secondary" className="oc-chart-avail__chip">
          {g.name}
          <button
            type="button"
            className="oc-chart-avail__chip-x"
            aria-label={m.charts_mine_remove_group({ group: g.name })}
            onClick={() => void drop(g.groupId)}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      {myGroups.length === 0 ? (
        <span className="oc-show__desc">{m.charts_mine_groups_none()}</span>
      ) : assignable.length > 0 ? (
        <Select value="" onValueChange={(v) => void add(v as Id<"groups">)}>
          <SelectTrigger size="sm" className="w-56">
            <SelectValue placeholder={m.charts_mine_assign_placeholder()} />
          </SelectTrigger>
          <SelectContent>
            {assignable.map((g) => (
              <SelectItem key={g.groupId} value={g.groupId}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

// One owned personal chart: name + a JSON tokens editor (re-validated server-side
// via updateChart) + delete + group associations. The token editor is a JSON
// textarea (NOT a 32-token grid) prefilled with the current tokens.
function MyChartRow({ chart, myGroups }: { chart: MyChart; myGroups: MyGroup[] }) {
  const updateChart = useMutation(api.charts.updateChart);
  const deleteChart = useMutation(api.charts.deleteChart);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(chart.name);
  const [json, setJson] = useState(() => JSON.stringify(chart.tokens, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startEdit() {
    setName(chart.name);
    setJson(JSON.stringify(chart.tokens, null, 2));
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (chart.chartId === undefined) return;
    setError(null);
    let tokens: unknown;
    try {
      tokens = JSON.parse(json);
    } catch {
      setError(m.charts_import_invalid_json());
      return;
    }
    setBusy(true);
    try {
      await updateChart({ chartId: chart.chartId, name: name.trim(), tokens });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (chart.chartId === undefined) return;
    if (!window.confirm(m.charts_mine_delete_confirm())) return;
    try {
      await deleteChart({ chartId: chart.chartId });
    } catch {
      // best-effort; the list re-reads on success
    }
  }

  return (
    <div className="oc-chart-mine__row">
      <div className="oc-chart-mine__head">
        <span className="oc-chart-mine__name">{chart.name}</span>
        <div className="oc-show__row">
          {editing ? null : (
            <>
              <Button variant="outline" size="sm" onClick={startEdit}>
                {m.charts_mine_edit()}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void onDelete()}>
                {m.charts_mine_delete()}
              </Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="oc-chart-mine__editor">
          <label className="oc-chart-import__field">
            <span className="oc-chart-import__label">
              {m.charts_mine_name_label()}
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
          </label>
          <label className="oc-chart-import__field">
            <span className="oc-chart-import__label">
              {m.charts_mine_tokens_label()}
            </span>
            <textarea
              className="oc-chart-import__textarea"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={10}
              spellCheck={false}
            />
          </label>
          {error ? <p className="oc-chart-import__error">{error}</p> : null}
          <div className="oc-show__row">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {m.charts_mine_save()}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
            >
              {m.charts_mine_cancel()}
            </Button>
          </div>
        </div>
      ) : null}
      <MyChartGroups
        chartKey={chart.key}
        myGroups={myGroups}
        restricted={chart.restrictedToGroups}
      />
    </div>
  );
}

function MyChartsManager() {
  const charts = useQuery(api.charts.listMyCharts) as MyChart[] | undefined;
  const myGroups = useQuery(api.groups.listMyGroups, {}) as
    | MyGroup[]
    | undefined;
  // Only the charts the user OWNS (personal custom) get management controls.
  const mine = (charts ?? []).filter((c) => c.via === "owner");

  return (
    <section className="oc-show__section">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">{m.charts_mine_section_title()}</h2>
        <p className="oc-show__desc">{m.charts_mine_section_desc()}</p>
      </div>
      {charts !== undefined && mine.length === 0 ? (
        <p className="oc-show__desc">{m.charts_mine_empty()}</p>
      ) : (
        <div className="oc-chart-mine-list">
          {mine.map((c) => (
            <MyChartRow key={c.key} chart={c} myGroups={myGroups ?? []} />
          ))}
        </div>
      )}
    </section>
  );
}

// ===========================================================================
// ADMIN: default theme-mode / language + chart default + chart availability
// (gated on me.role==="admin" here; the server also gates each mutation).
// ===========================================================================

// The flat admin row shape (P4): builtins AND customs in one list. `kind`,
// `chartId`, `scope`, `ownerLabel` are present on customs; builtins carry
// kind:"builtin" + scope:"common" + ownerLabel:null and no chartId.
type AdminChart = {
  kind: "builtin" | "custom";
  chartId?: Id<"charts">;
  key: string;
  name: string;
  scope: "common" | "personal";
  ownerLabel: string | null;
  restrictedToGroups:
    | Array<{ groupId: Id<"groups">; key: string; name: string }>
    | null;
  isGlobalDefault: boolean;
};
type GroupRow = { _id: Id<"groups">; key: string; name: string };

// Per-builtin availability row: common vs restricted-to-groups, with a group
// multi-select (assign) and removable chips (remove). Mirrors the agent-group
// assignment pattern in GroupsTab.
function ChartAvailabilityRow({
  chart,
  groups,
}: {
  chart: AdminChart;
  groups: GroupRow[];
}) {
  const assign = useMutation(api.charts.assignChartToGroup);
  const remove = useMutation(api.charts.removeChartFromGroup);
  const restricted = chart.restrictedToGroups;
  const assignedIds = new Set((restricted ?? []).map((g) => g.groupId));
  const assignable = groups.filter((g) => !assignedIds.has(g._id));

  async function add(groupId: Id<"groups">) {
    try {
      await assign({ groupId, chartKey: chart.key });
    } catch {
      // best-effort; the query re-reads the source of truth on success
    }
  }
  async function drop(groupId: Id<"groups">) {
    try {
      await remove({ groupId, chartKey: chart.key });
    } catch {
      // best-effort
    }
  }

  return (
    <div className="oc-chart-avail">
      <div className="oc-chart-avail__head">
        <span className="oc-chart-avail__name">{chart.name}</span>
        <Badge
          variant={restricted ? "secondary" : "outline"}
          className="oc-chart-avail__state"
        >
          {restricted
            ? m.charts_admin_restricted_badge()
            : chart.kind === "custom" && chart.scope === "personal"
              ? // A personal custom with NO group is OWNER-ONLY, not common —
                // labeling it "Commune" would falsely imply it's offered to all.
                m.charts_admin_custom_scope_personal()
              : m.charts_admin_common_badge()}
        </Badge>
        {chart.isGlobalDefault ? (
          <Badge variant="default">{m.charts_admin_default_badge()}</Badge>
        ) : null}
      </div>
      <div className="oc-chart-avail__groups">
        {(restricted ?? []).map((g) => (
          <Badge key={g.groupId} variant="secondary" className="oc-chart-avail__chip">
            {g.name}
            <button
              type="button"
              className="oc-chart-avail__chip-x"
              aria-label={m.charts_admin_remove_group({ group: g.name })}
              onClick={() => void drop(g.groupId)}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {assignable.length > 0 ? (
          <Select
            value=""
            onValueChange={(v) => void add(v as Id<"groups">)}
          >
            <SelectTrigger size="sm" className="w-56">
              <SelectValue placeholder={m.charts_admin_assign_placeholder()} />
            </SelectTrigger>
            <SelectContent>
              {assignable.map((g) => (
                <SelectItem key={g._id} value={g._id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : groups.length === 0 ? (
          <span className="oc-show__desc">{m.charts_admin_no_groups()}</span>
        ) : null}
      </div>
    </div>
  );
}

// Admin-only block: app defaults (theme-mode, language) + chart default + the
// per-builtin availability matrix. Gated by the caller on me.role==="admin".
// Admin row for ONE custom chart: promote a personal chart to common, or delete
// any custom chart. Keys on the chart's `chartId` (present on every custom row).
function CustomChartAdminRow({ chart }: { chart: AdminChart }) {
  const promote = useMutation(api.charts.promoteChartToCommon);
  const remove = useMutation(api.charts.deleteChart);

  async function onPromote() {
    if (chart.chartId === undefined) return;
    try {
      await promote({ chartId: chart.chartId });
    } catch {
      // best-effort; the list re-reads on success
    }
  }
  async function onDelete() {
    if (chart.chartId === undefined) return;
    if (!window.confirm(m.charts_mine_delete_confirm())) return;
    try {
      await remove({ chartId: chart.chartId });
    } catch {
      // best-effort
    }
  }

  return (
    <div className="oc-chart-avail">
      <div className="oc-chart-avail__head">
        <span className="oc-chart-avail__name">{chart.name}</span>
        <Badge variant={chart.scope === "common" ? "outline" : "secondary"}>
          {chart.scope === "common"
            ? m.charts_admin_custom_scope_common()
            : m.charts_admin_custom_scope_personal()}
        </Badge>
        {chart.ownerLabel ? (
          <span className="oc-show__desc">
            {m.charts_admin_custom_owner({ owner: chart.ownerLabel })}
          </span>
        ) : null}
      </div>
      <div className="oc-show__row">
        {chart.scope === "personal" ? (
          <Button variant="outline" size="sm" onClick={() => void onPromote()}>
            {m.charts_admin_custom_promote()}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => void onDelete()}>
          {m.charts_admin_custom_delete()}
        </Button>
      </div>
    </div>
  );
}

function AppearanceAdminSection({
  defaultThemeMode,
  defaultLocale,
  defaultChartKey,
}: {
  defaultThemeMode: ThemeMode | null;
  defaultLocale: Locale | null;
  defaultChartKey: string | null;
}) {
  const setDefaultTheme = useMutation(api.admin.setDefaultThemeMode);
  const setDefaultLocale = useMutation(api.admin.setDefaultLocale);
  const setDefaultChart = useMutation(api.charts.setDefaultChart);
  const adminCharts = useQuery(api.charts.listChartsAdmin) as
    | AdminChart[]
    | undefined;
  const groups = useQuery(api.groups.listGroups, {}) as GroupRow[] | undefined;

  const theme = defaultThemeMode ?? "system";
  // null (no admin default) resolves to the base locale "fr" -> highlight it.
  const localeDefault: Locale = defaultLocale ?? "fr";

  return (
    <div className="oc-appearance-admin">
      <div className="oc-show__heading">
        <h2 className="oc-show__title">{m.appearance_admin_section_title()}</h2>
        <p className="oc-show__desc">{m.appearance_admin_section_desc()}</p>
      </div>

      {/* Global default chart (appMeta.defaultThemeName). A valid default is a
          builtin OR a COMMON custom (the server REJECTS a personal one), so we
          offer builtins + the common-custom admin rows. */}
      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h3 className="oc-show__title">{m.charts_admin_default_title()}</h3>
          <p className="oc-show__desc">{m.charts_admin_default_desc()}</p>
        </div>
        <div className="oc-show__row">
          <Button
            variant={defaultChartKey === null ? "default" : "outline"}
            size="sm"
            onClick={() => void setDefaultChart({ name: null })}
          >
            {m.charts_app_default_name()}
          </Button>
          {BUILTIN_CHARTS.map((c) => (
            <Button
              key={c.key}
              variant={defaultChartKey === c.key ? "default" : "outline"}
              size="sm"
              onClick={() => void setDefaultChart({ name: c.key })}
            >
              {c.name}
            </Button>
          ))}
          {(adminCharts ?? [])
            .filter((c) => c.kind === "custom" && c.scope === "common")
            .map((c) => (
              <Button
                key={c.key}
                variant={defaultChartKey === c.key ? "default" : "outline"}
                size="sm"
                onClick={() => void setDefaultChart({ name: c.key })}
              >
                {c.name}
              </Button>
            ))}
        </div>
      </section>

      {/* Per-builtin availability (common vs restricted-to-groups). */}
      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h3 className="oc-show__title">
            {m.charts_admin_availability_title()}
          </h3>
          <p className="oc-show__desc">
            {m.charts_admin_availability_desc()}
          </p>
        </div>
        <div className="oc-chart-avail-list">
          {/* A COMMON custom is offered to ALL: its groupCharts rows are inert
              (availableChartsForUser ignores them), so a restriction editor here
              would be misleading. Such charts are managed (promote/delete) in the
              "Custom charts" section below. Builtins + personal customs (whose
              availability IS governed by groupCharts) keep the editor. */}
          {(adminCharts ?? [])
            .filter((c) => !(c.kind === "custom" && c.scope === "common"))
            .map((c) => (
              <ChartAvailabilityRow
                key={c.key}
                chart={c}
                groups={groups ?? []}
              />
            ))}
        </div>
      </section>

      {/* Custom charts (user-imported): promote-to-common + delete. */}
      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h3 className="oc-show__title">
            {m.charts_admin_custom_section_title()}
          </h3>
          <p className="oc-show__desc">
            {m.charts_admin_custom_section_desc()}
          </p>
        </div>
        {(() => {
          const customs = (adminCharts ?? []).filter(
            (c) => c.kind === "custom",
          );
          return customs.length === 0 ? (
            <p className="oc-show__desc">{m.charts_admin_custom_empty()}</p>
          ) : (
            <div className="oc-chart-avail-list">
              {customs.map((c) => (
                <CustomChartAdminRow key={c.key} chart={c} />
              ))}
            </div>
          );
        })()}
      </section>

      {/* Existing app defaults: theme mode + language (moved into this gated
          admin section; they were the whole panel before). */}
      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h3 className="oc-show__title">
            {m.appearance_default_theme_title()}
          </h3>
          <p className="oc-show__desc">{m.appearance_default_theme_desc()}</p>
        </div>
        <div className="oc-show__row">
          {(["light", "dark", "system"] as const).map((mode) => (
            <Button
              key={mode}
              variant={theme === mode ? "default" : "outline"}
              size="sm"
              onClick={() => void setDefaultTheme({ mode })}
            >
              {themeModeLabel(mode)}
            </Button>
          ))}
        </div>
      </section>

      <section className="oc-show__section">
        <div className="oc-show__heading">
          <h3 className="oc-show__title">
            {m.appearance_default_language_title()}
          </h3>
          <p className="oc-show__desc">
            {m.appearance_default_language_desc()}
          </p>
        </div>
        <div className="oc-show__row">
          {(["fr", "en"] as const).map((loc) => (
            <Button
              key={loc}
              variant={localeDefault === loc ? "default" : "outline"}
              size="sm"
              onClick={() => void setDefaultLocale({ locale: loc })}
            >
              {loc === "fr" ? m.language_fr() : m.language_en()}
            </Button>
          ))}
        </div>
        <p className="oc-show__desc">{m.appearance_default_language_note()}</p>
      </section>
    </div>
  );
}

// The Apparence panel: the per-user chart picker (ALL users) + the admin-gated
// administration block. Reads getMe once and feeds both.
function AppearancePanel() {
  const me = useQuery(api.me.getMe) as
    | {
        role: "pending" | "user" | "admin";
        defaultThemeMode: ThemeMode | null;
        defaultLocale: Locale | null;
        resolvedThemeMode: ThemeMode;
        chartKey: string | null;
        defaultChartKey: string | null;
      }
    | undefined;

  // Resolve the (possibly "system") mode to a concrete light/dark so the preview
  // swatches show the palette the user will actually see.
  const resolvedMode = useResolvedMode(me?.resolvedThemeMode);

  return (
    <div className="oc-appearance">
      <MyChartPicker selectedKey={me?.chartKey ?? null} resolvedMode={resolvedMode} />
      {/* Import + manage personal charts (ALL active users; the server gates each
          mutation on the effective identity / ownership). */}
      <ChartImportSection />
      <MyChartsManager />
      {me?.role === "admin" ? (
        <AppearanceAdminSection
          defaultThemeMode={me.defaultThemeMode}
          defaultLocale={me.defaultLocale}
          defaultChartKey={me.defaultChartKey}
        />
      ) : null}
    </div>
  );
}

export function ThemeShowroom() {
  const [checked, setChecked] = useState(true);
  const [sel, setSel] = useState("per-user");

  // Local state for the Filters showcase (no backend — preview of the tokens).
  const [fq, setFq] = useState("");
  const [fdir, setFdir] = useState(SHOW_ALL);
  const [fsev, setFsev] = useState(SHOW_ALL);
  const [frange, setFrange] = useState<TimeRange>(SHOW_RANGE);
  const filtersActive = fq !== "" || fdir !== SHOW_ALL || fsev !== SHOW_ALL;
  function resetShowFilters() {
    setFq("");
    setFdir(SHOW_ALL);
    setFsev(SHOW_ALL);
    setFrange(SHOW_RANGE);
  }

  return (
    <div className="oc-show">
      <AppearancePanel />
      {/* The component showroom (design reference) is collapsed below — it's dev
          tooling, intentionally NOT internationalized. #23 will relocate it to a
          /showroom route; remove this copy then. */}
      <details className="oc-show__ref">
        <summary className="oc-show__title">
          {m.appearance_design_reference()}
        </summary>
      <Section title="Buttons" description="Variants">
        <div className="oc-show__row">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="oc-show__row">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="more">
            <MoreVertical />
          </Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="oc-show__row">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
        </div>
      </Section>

      <Section title="Inputs & selection">
        <div className="oc-show__row oc-show__row--col">
          <Input placeholder="Text input…" />
          <div className="oc-show__row">
            <Select value={sel} onValueChange={setSel}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-user">per-user (chacun son agent)</SelectItem>
                <SelectItem value="shared">shared (agent commun)</SelectItem>
              </SelectContent>
            </Select>
            <label className="oc-show__check">
              <Checkbox
                checked={checked}
                onCheckedChange={(v) => setChecked(Boolean(v))}
              />
              Checkbox
            </label>
          </div>
        </div>
      </Section>

      <Section
        title="Filtres & plage temporelle"
        description="Barre réutilisable (recherche debouncée + selects rapides à largeur auto + plage façon Grafana) et constructeur de filtre avancé. Câblée dans Users, Groups, Comptes de service, Traces, Anomalies, Audit et KPI."
      >
        <div className="oc-show__row oc-show__row--col">
          <FilterBar
            q={fq}
            onQChange={setFq}
            searchPlaceholder="Rechercher (kind, principal, rôle, route…)"
            timeRange={frange}
            onTimeRangeChange={setFrange}
            onReset={resetShowFilters}
            canReset={filtersActive}
          >
            <Select value={fdir} onValueChange={setFdir}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SHOW_ALL}>Toutes directions</SelectItem>
                <SelectItem value="inbound">inbound</SelectItem>
                <SelectItem value="outbound">outbound</SelectItem>
                <SelectItem value="internal">internal</SelectItem>
              </SelectContent>
            </Select>
            <Select value={fsev} onValueChange={setFsev}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SHOW_ALL}>Toutes sévérités</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="warn">warn</SelectItem>
                <SelectItem value="critical">critical</SelectItem>
              </SelectContent>
            </Select>
          </FilterBar>

          <AdvancedFilter fields={SHOW_ADV_FIELDS} onChange={() => {}} />

          <div className="oc-show__row">
            <span className="oc-show__desc">Sélecteur de plage seul :</span>
            <TimeRangePicker value={frange} onChange={setFrange} />
          </div>
        </div>
      </Section>

      <Section title="Dropdown menu" description="Row actions / kebab">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Open menu">
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Edit</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section title="Card">
        <Card className="w-80">
          <CardHeader>
            <CardTitle>Instance</CardTitle>
            <CardDescription>Non-secret metadata only.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            ws://gateway.example.org:18789
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Save</Button>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </CardFooter>
        </Card>
      </Section>

      <Section title="Table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox aria-label="select all" />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Status</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[
              { n: "admins", m: "per-user", s: "active" },
              { n: "family", m: "shared", s: "active" },
            ].map((r) => (
              <TableRow key={r.n}>
                <TableCell>
                  <Checkbox aria-label={`select ${r.n}`} />
                </TableCell>
                <TableCell className="font-medium">{r.n}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{r.m}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Check className="size-3.5" /> {r.s}
                  </span>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" aria-label="row actions">
                    <MoreVertical />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="App fragments" description="Chat-specific components">
        <div className="oc-show__row oc-show__row--col">
          <div className="oc-msg oc-msg--assistant">
            <div className="oc-msg__body">Assistant message bubble.</div>
          </div>
          <div className="oc-tool oc-tool--completed">
            <div className="oc-tool__header">
              <span className="oc-tool__icon">✓</span>
              <span className="oc-tool__name">write-file</span>
              <span className="oc-tool__phase">completed</span>
            </div>
          </div>
          <div className="oc-run-status oc-run-status--streaming">
            <span className="oc-run-status__dot" />
            <span className="oc-run-status__label">Running</span>
          </div>
        </div>
      </Section>
      </details>
    </div>
  );
}
