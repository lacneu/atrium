// Code-based TanStack Router route tree (the single reviewable source of truth
// AND the artifact agents read for the URL contract). See
// docs/ROUTING_RESEARCH.md §3 for the full decision.
//
// Structure:
//   __root  = the AUTH BOUNDARY + persistent chrome (RootShell). <Outlet/> only
//             renders for Authenticated + active-role users (§3.2 — the #1 risk:
//             an Outlet that mounts before auth resolves fires unauthenticated
//             useQuery and requireUserId() throws).
//   /                       chat home (empty pane)
//   /chat/$chatId           a specific chat (deep-linkable)
//   /settings               RBAC-guarded layout (per-tab permissions + Toast):
//                           a user with no allowed tab → "/"; a tab they can't
//                           see → in-app access-denied panel
//     /settings (index)     → redirect to the user's FIRST allowed tab
//     /settings/<filtered>  one STATIC route per filtered tab, each with its own
//                           typed validateSearch (the only way to give a tab its
//                           own search schema — validateSearch sees only search,
//                           never the path param)
//     /settings/$tab        shared route for the 4 PARAMLESS tabs
//                           (roles/integrations/instances/theme)

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  Outlet,
  useNavigate,
  useParams,
  useSearch,
  useLocation,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { z } from "zod";
import {
  Eye,
  PanelLeftClose,
  PanelLeftOpen,
  AlertTriangle,
  Compass,
} from "lucide-react";
import { api } from "./chat/convexApi";
import type { Id } from "./chat/convexApi";
import { getLastChat, rememberChat } from "./lib/lastChat";
import {
  isStaleChunkError,
  shouldAutoReloadForStaleChunk,
} from "./lib/staleChunk";
import type { ConvexId } from "./chat/convexTypes";
import { ConvexChat } from "./chat/ConvexChat";
import { ChatSidebar, ChatListSkeleton } from "./chat/ChatSidebar";
import { useStartNewChat } from "./chat/useStartNewChat";
import { DevUserSwitcher } from "./chat/DevUserSwitcher";
import { UserMenu } from "./chat/UserMenu";
import { NotificationBell } from "./chat/NotificationBell";
import { GlobalSearch } from "./chat/GlobalSearch";
import {
  PARAMLESS_TABS,
  SETTINGS_TAB_REDIRECTS,
  visibleTabs,
  tabFromPathname,
  pathForTab,
  type Tab,
  type ParamlessTab,
} from "./chat/AdminSettings";
import { SettingsNav, SettingsTabBar } from "./chat/admin/SettingsNav";
import {
  voiceSearchSchema,
  bridgeSearchSchema,
  tracesSearchSchema,
  auditSearchSchema,
  anomaliesSearchSchema,
  kpiSearchSchema,
  serviceAccountsSearchSchema,
  usersSearchSchema,
} from "./lib/routing/searchSchemas";
import { Button } from "@/components/ui/button";
import { ToastProvider } from "@/components/ui/toast";
import { AtriumMark } from "@/components/AtriumMark";
import { m } from "@/paraglide/messages.js";
import { useApplyTheme, type ThemeMode } from "@/lib/useTheme";
import { useApplyChart, useResolvedMode } from "@/lib/useChart";
import {
  isMac,
  shortcutLabel,
  matchesShortcut,
  SHORTCUT_NEW_CHAT,
} from "@/lib/shortcuts";
import { pickLogoUrl } from "@/lib/brandLogo";
import {
  APP_HOST,
  readCachedBrand,
  writeCachedBrand,
  type CachedBrand,
} from "@/lib/appHost";
import { useApplyLocale, type Locale } from "@/lib/useLocale";
import type { ChartTokens } from "../convex/lib/charts";
import { useSidebarLayout } from "@/lib/useSidebarLayout";
import { Link, useMatchRoute } from "@tanstack/react-router";

// Admin/settings tab COMPONENTS are lazy-loaded: they + their data-table/filter deps
// are ~217 KB gzip (~40% of the bundle) chat users never need before first paint.
// Route-level tabs use lazyRouteComponent (in the route tree below); these paramless
// tabs (rendered in SettingsParamlessScreen) use React.lazy under a Suspense boundary.
// (UsersTab/InstancesTab/AuditTab were extracted from the AdminSettings barrel into
// their own modules so they could join this set — see those files.)
const RolesTab = lazy(() =>
  import("./chat/admin/RolesTab").then((m) => ({ default: m.RolesTab })),
);
const InstancesTab = lazy(() =>
  import("./chat/admin/InstancesTab").then((m) => ({ default: m.InstancesTab })),
);
const PromptInjectionsTab = lazy(() =>
  import("./chat/admin/PromptInjectionsTab").then((m) => ({
    default: m.PromptInjectionsTab,
  })),
);
const GroupsTab = lazy(() =>
  import("./chat/admin/GroupsTab").then((m) => ({ default: m.GroupsTab })),
);
const IntegrationsTab = lazy(() =>
  import("./chat/admin/IntegrationsTab").then((m) => ({
    default: m.IntegrationsTab,
  })),
);
const FeedbacksTab = lazy(() =>
  import("./chat/admin/FeedbacksTab").then((m) => ({ default: m.FeedbacksTab })),
);
const SubAgentReportsTab = lazy(() =>
  import("./chat/admin/SubAgentReportsTab").then((m) => ({
    default: m.SubAgentReportsTab,
  })),
);
const FilesTab = lazy(() =>
  import("./chat/admin/FilesTab").then((m) => ({ default: m.FilesTab })),
);
const AgentFilesTab = lazy(() =>
  import("./chat/admin/AgentFilesTab").then((m) => ({ default: m.AgentFilesTab })),
);
const PreferencesTab = lazy(() =>
  import("./chat/admin/PreferencesTab").then((m) => ({
    default: m.PreferencesTab,
  })),
);
const ChatDefaultsTab = lazy(() =>
  import("./chat/admin/ChatDefaultsTab").then((m) => ({
    default: m.ChatDefaultsTab,
  })),
);
const AccessTab = lazy(() =>
  import("./chat/admin/AccessTab").then((m) => ({ default: m.AccessTab })),
);
const ThemeShowroom = lazy(() =>
  import("./chat/ThemeShowroom").then((m) => ({ default: m.ThemeShowroom })),
);

// Top-bar brand from the active chart, with a logo per theme mode. `isDefault` =
// the app's own identity (native / builtin) → show the bundled Atrium mark. A
// custom chart has isDefault:false → show the active mode's uploaded logo (falling
// back to the other mode's), else the LABEL ALONE (no Atrium mark beside a custom
// name).
type ChartBrand = {
  label: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  isDefault: boolean;
};

// What getMe returns (the bits the shell needs). `userId` is the EFFECTIVE id
// (impersonation-aware) — used as a remount key so switching identity resets
// transient UI (e.g. the selected chat) cleanly.
type Me = {
  userId: string;
  role: "pending" | "user" | "admin";
  email: string | null;
  name: string | null;
  hasProfile: boolean;
  themeMode: ThemeMode | null;
  resolvedThemeMode: ThemeMode;
  defaultThemeMode: ThemeMode | null;
  // Charte graphique (P3): the user's raw pick + the server-resolved effective
  // key (user pick if still available, else admin default, else null = native).
  chartKey: string | null;
  resolvedChartKey: string | null;
  // P4: the resolved chart's TOKENS (builtin from the registry OR custom from the
  // DB, resolved server-side). null = native look. Fed straight to useApplyChart.
  resolvedChartTokens: ChartTokens | null;
  // The active chart's brand for the top bar (see ChartBrand).
  resolvedChartBrand: ChartBrand;
  locale: Locale | null;
  resolvedLocale: Locale;
  defaultLocale: Locale | null;
  // EFFECTIVE permissions (role ∪ extraPermissions; admins = full superset).
  // Drives which Settings tabs the user may open (per-tab RBAC); server queries
  // enforce the same permissions independently.
  permissions: string[];
};

// ===========================================================================
// ROOT SHELL — the auth boundary (§3.2). <Outlet/> renders ONLY inside
// <Authenticated> AND when role !== "pending".
// ===========================================================================

function RootShell() {
  return (
    <>
      <AuthLoading>
        <div className="oc-boot">{m.app_loading()}</div>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        {/* App-wide toast surface: chat actions (message delete, …) report
            failures through the same toasts Settings always had. ONE provider
            for the whole authenticated tree — the settings layout no longer
            mounts its own (a nested provider would shadow this one). */}
        <ToastProvider>
          <RoleGate />
        </ToastProvider>
      </Authenticated>
    </>
  );
}

// Official Google "G" mark (4-color), inlined so the provider button is faithful
// to Google's sign-in branding without a network/icon-font dependency.
function GoogleIcon() {
  return (
    <svg className="oc-provider__logo" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function SignIn() {
  const { signIn } = useAuthActions();
  // Pre-auth there is no Convex theme, so resolve from the cache ("oc.theme",
  // default "system"). Passing undefined makes useApplyTheme fall back to that
  // cache AND, when it resolves to "system", live-track the OS light/dark
  // preference (matchMedia) — so the sign-in screen follows the system theme,
  // not just at first paint. The listener is cleaned up when SignIn unmounts on
  // auth, so it can never override an authenticated user's explicit theme.
  useApplyTheme(undefined);
  // Charte par domaine: brand the LOGIN (colors + logo + label) for this host. A
  // PUBLIC pre-auth query (no identity); the localStorage cache lets us apply
  // tenant tokens on the first render instead of waiting the round-trip.
  const hostBrandQ = useQuery(api.charts.brandForHost, { host: APP_HOST });
  const cached = readCachedBrand(APP_HOST);
  const view = (hostBrandQ ?? cached ?? null) as {
    tokens: ChartTokens | null;
    brand: ChartBrand;
  } | null;
  const mode = useResolvedMode(undefined);
  useApplyChart(view?.tokens ?? null, mode);
  useEffect(() => {
    if (hostBrandQ) writeCachedBrand(APP_HOST, hostBrandQ as CachedBrand);
  }, [hostBrandQ]);
  const brand = view?.brand;
  // Show the domain logo for the active mode (custom chart only); else the label.
  const brandLogoUrl = brand && !brand.isDefault ? pickLogoUrl(brand, mode) : null;
  const brandLabel = brand?.label ?? "Atrium";
  // Which providers the deployment enabled (env-driven, server-resolved). Pre-auth
  // query → no identity required.
  const providers = useQuery(api.me.authProviders);
  const [error, setError] = useState<string | null>(null);
  // OAuth sign-in, restricted server-side to the allowed email domains
  // (convex/lib/authDomains). On a disallowed account the OAuth flow is rejected
  // server-side; surface a clear message instead of a silent failure.
  async function oauth(provider: string) {
    setError(null);
    try {
      await signIn(provider);
    } catch {
      setError(m.app_signin_refused());
    }
  }
  const noneEnabled =
    providers !== undefined &&
    !providers.google &&
    !providers.microsoft &&
    !providers.anonymous;
  return (
    <div className="oc-signin">
      {/* Crisp line motif: the Atrium logo's CENTER pulse (heartbeat) scaled to
          span the screen, like the social-preview background. SVG strokes give the
          sharp edges a gradient can't; non-scaling-stroke keeps the line thin at
          any viewport size; color is a faint --foreground (B&W, set in CSS). */}
      {/* The heartbeat lives in the free space BELOW the card (baseline ~86% of
          height, compact spike) so it is NEVER occluded and survives the card
          growing taller. preserveAspectRatio="none" maps the viewBox 1:1 to the
          viewport, so the spike stays horizontally centred under the (centred)
          card on any screen. */}
      <svg
        className="oc-signin__motif"
        viewBox="0 0 1200 1000"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline
          className="oc-signin__line"
          points="0,860 470,860 522,790 574,940 626,810 678,860 1200,860"
          vectorEffect="non-scaling-stroke"
        />
        {/* A bright spark that travels the heartbeat (Atrium = heart/atrium +
            continuity). pathLength=100 normalizes the dash; CSS animates the
            dashoffset so a short segment sweeps the line like a cardiac monitor.
            Disabled under prefers-reduced-motion (see CSS). */}
        <polyline
          className="oc-signin__pulse"
          points="0,860 470,860 522,790 574,940 626,810 678,860 1200,860"
          pathLength="100"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="oc-signin__brand">
        {brandLogoUrl ? (
          <img className="oc-signin__brandlogo" src={brandLogoUrl} alt="" />
        ) : null}
        <span className="oc-signin__wordmark">{brandLabel}</span>
      </div>
      <div className="oc-signin__card">
        <h1 className="oc-signin__title">{m.app_signin_title()}</h1>
        <p className="oc-signin__subtitle">{m.app_signin_subtitle()}</p>
        <div className="oc-signin__providers">
          {providers?.google ? (
            <button
              type="button"
              className="oc-provider oc-provider--google"
              onClick={() => void oauth("google")}
            >
              <GoogleIcon />
              <span>{m.app_signin_google()}</span>
            </button>
          ) : null}
        </div>
        {error ? <p className="oc-signin__error">{error}</p> : null}
        {noneEnabled ? (
          <p className="oc-signin__error">{m.app_signin_none_enabled()}</p>
        ) : null}
        {providers?.anonymous ? (
          <button
            type="button"
            className="oc-signin__dev"
            onClick={() => void signIn("anonymous")}
          >
            {m.app_signin_anonymous()}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Immediate app shell shown while the profile (getMe) loads, so the page takes
// shape AT ONCE instead of a blank loading bar. Reuses the REAL chrome layout
// classes + the persisted sidebar width/collapsed (useSidebarLayout); the theme is
// already on <html> from the index.html inline script. When the real chrome mounts
// the frame does not jump -- only the content (brand, list, chat) fills in.
function AppShellSkeleton() {
  const { width, collapsed, isMobile } = useSidebarLayout();
  return (
    <div className="oc-shell">
      <header className="oc-topbar">
        <div className="oc-topbar__left">
          <div
            className="oc-skel"
            style={{ width: "1.75rem", height: "1.75rem" }}
          />
          <div className="oc-skel" style={{ width: "5.5rem", height: "1.1rem" }} />
        </div>
        <div className="oc-topbar__search">
          <div className="oc-skel" style={{ width: "100%", height: "2.25rem" }} />
        </div>
        <div className="oc-topbar__actions">
          <div
            className="oc-skel"
            style={{ width: "1.75rem", height: "1.75rem", borderRadius: "999px" }}
          />
        </div>
      </header>
      <div
        className={isMobile ? "oc-workspace oc-workspace--mobile" : "oc-workspace"}
      >
        {!collapsed && !isMobile ? (
          <div
            className="oc-sidebar-col"
            style={{ width, flex: `0 0 ${width}px` }}
          >
            <aside className="oc-sidebar">
              <div
                className="oc-skel"
                style={{ height: "2.25rem", margin: "0.25rem 0.25rem 0" }}
              />
              <ChatListSkeleton />
            </aside>
          </div>
        ) : null}
        <main className="oc-main" />
      </div>
    </div>
  );
}

// After authentication, provision the profile once (me.bootstrap — the only
// mutation a pending user may call) and route by role. RoleGate does NOT remount
// on navigation (only the inner chrome wrapper is keyed), so the impersonation
// effect below lives here.
function RoleGate() {
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as Me | undefined;
  const bootstrap = useMutation(api.me.bootstrap);
  const navigate = useNavigate();

  // Create the profile on first sight (idempotent). me.getMe then reflects the
  // assigned role reactively.
  useEffect(() => {
    if (me && !me.hasProfile) {
      void bootstrap();
    }
  }, [me, bootstrap]);

  // Apply the Convex-resolved theme (source of truth). undefined until getMe
  // loads -> the hook falls back to the localStorage cache (no flash).
  useApplyTheme(me?.resolvedThemeMode);

  // Apply the Convex-resolved charte graphique on top of the theme mode. The
  // chart's COLOR tokens are mode-scoped, so we first resolve the (possibly
  // "system") mode down to a concrete light/dark — state-backed so an OS flip
  // re-applies — then feed the SERVER-RESOLVED tokens (P4 moved key->tokens
  // resolution server-side; builtin or custom). Coordinated with useApplyTheme,
  // which owns the `.dark` class for the SAME resolved mode.
  const effectiveMode = useResolvedMode(me?.resolvedThemeMode);
  useApplyChart(me?.resolvedChartTokens, effectiveMode);

  // Apply the Convex-resolved UI language (source of truth). undefined until
  // getMe loads -> Paraglide's localStorage strategy already owns first-paint.
  // On a real cross-device mismatch the hook reloads ONCE (loop-safe).
  useApplyLocale(me?.resolvedLocale);

  // Impersonation safety (§3.2 option 1): on a REAL change of effective identity
  // (start/stop impersonation), send the URL back to "/" so it can't point at a
  // chat the new effective identity can't read. Detect a genuine CHANGE, not the
  // first authenticated mount — otherwise a deep-linked /chat/x is clobbered on
  // initial load (breaking "deep-link survives login"). Declared ABOVE the early
  // returns so the hook order is stable.
  const prevUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!me) return;
    if (prevUserId.current !== null && prevUserId.current !== me.userId) {
      void navigate({ to: "/" });
    }
    prevUserId.current = me.userId;
  }, [me, navigate]);

  // Profile still loading: show the app shell immediately (structure now, data
  // fills in) instead of a blank loading bar.
  if (me === undefined) return <AppShellSkeleton />;

  const userLabel = me.name || me.email || m.app_account_fallback();

  if (me.role === "pending") {
    return (
      <div className="oc-shell">
        <ImpersonationBanner />
        <DevUserSwitcher />
        <header className="oc-topbar">
          <span className="oc-topbar__brand">
            <BrandMark
              brand={me.resolvedChartBrand}
              resolvedThemeMode={me.resolvedThemeMode}
            />
          </span>
          <div className="oc-topbar__actions">
            <UserMenu label={userLabel} mode={me.themeMode} minimal />
          </div>
        </header>
        <div className="oc-pending">
          <h1 className="oc-pending__title">{m.app_pending_title()}</h1>
          <p className="oc-pending__body">{m.app_pending_body()}</p>
        </div>
      </div>
    );
  }

  return (
    <AuthenticatedChrome
      // Remount on identity change (start/stop impersonation) so transient UI
      // (sidebar local state etc.) hard-resets cleanly, mirroring the previous
      // key on ChatWorkspace. The navigate("/") effect above closes the
      // URL-points-at-foreign-chat hole that routing would otherwise open.
      key={me.userId}
      canOpenSettings={visibleTabs(me.permissions ?? []).length > 0}
      userLabel={userLabel}
      themeMode={me.themeMode}
      resolvedThemeMode={me.resolvedThemeMode}
      brand={me.resolvedChartBrand}
    />
  );
}

// Persistent warning strip shown whenever the admin is impersonating a user.
// Driven by me.getImpersonation (REAL-identity query, so it survives the
// effective-identity flip it reports on). Rendered on EVERY authenticated
// surface (incl. the pending screen) so "Quitter" is always reachable.
function ImpersonationBanner() {
  const imp = useQuery(api.me.getImpersonation) as
    | { impersonating: false }
    | {
        impersonating: true;
        targetLabel: string;
        targetRole: string;
        realLabel: string;
      }
    | undefined;
  const stop = useMutation(api.admin.stopImpersonation);
  if (!imp || !imp.impersonating) return null;
  return (
    <div className="oc-imp" role="alert">
      <Eye className="size-4 shrink-0" />
      <span className="oc-imp__text">
        {m.app_imp_prefix()}{" "}
        <strong>{imp.targetLabel}</strong>
        {m.app_imp_middle()}
        <strong>{imp.realLabel}</strong>
        {m.app_imp_suffix()}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="oc-imp__exit"
        onClick={() => void stop()}
      >
        {m.app_imp_exit()}
      </Button>
    </div>
  );
}

// Brand shown in the top bar = the ACTIVE chart's brand (label + optional logo),
// from getMe.resolvedChartBrand. An uploaded logo is rendered as <img> (never
// inlined → no script execution); a missing/broken URL falls back to the bundled
// Atrium mark, so the brand is never blank. Default = Atrium mark + "Atrium".
function BrandMark({
  brand,
  resolvedThemeMode,
}: {
  brand: ChartBrand | undefined;
  resolvedThemeMode: ThemeMode;
}) {
  // Pick the logo for the SERVER-RESOLVED mode, so the logo can never desync from
  // the applied CSS theme: useApplyTheme(me.resolvedThemeMode) drives the DOM, and
  // resolving the SAME value here keeps the chosen light/dark logo in lockstep
  // (the raw user `themeMode` may be null while an admin default resolves the
  // theme). "system" is still resolved to light/dark, consistently with the app.
  const mode = useResolvedMode(resolvedThemeMode);
  const label = brand?.label ?? "Atrium";
  const isDefault = brand?.isDefault ?? true;
  const logoUrl = pickLogoUrl(brand, mode);
  const [imgFailed, setImgFailed] = useState(false);
  // Reset the broken-image flag when the chosen logo URL changes (mode flip /
  // chart change) so a different logo gets a fresh chance to load.
  useEffect(() => setImgFailed(false), [logoUrl]);
  // Uploaded logo wins; else the app default shows the bundled Atrium mark; a
  // custom chart with no (or broken) logo shows the LABEL ALONE -- never the
  // Atrium mark next to a custom name.
  const showImg = logoUrl !== null && !imgFailed;
  return (
    <>
      {showImg ? (
        <img
          className="oc-brand__logo"
          src={logoUrl}
          alt=""
          aria-hidden="true"
          onError={() => setImgFailed(true)}
        />
      ) : isDefault ? (
        <AtriumMark className="oc-brand__logo" />
      ) : null}
      <span className="oc-brand__label">{label}</span>
    </>
  );
}

// Global top bar: sidebar toggle (left) + brand + single user menu (right).
function AppTopBar({
  userLabel,
  themeMode,
  resolvedThemeMode,
  brand,
  collapsed,
  onToggleSidebar,
}: {
  userLabel: string;
  themeMode: ThemeMode | null;
  resolvedThemeMode: ThemeMode;
  brand: ChartBrand | undefined;
  collapsed: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="oc-topbar">
      <div className="oc-topbar__left">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? m.app_sidebar_show() : m.app_sidebar_hide()}
          onClick={onToggleSidebar}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
        {/* Brand (active chart's logo + label) returns to the chat surface. */}
        <Link to="/" className="oc-topbar__brand">
          <BrandMark brand={brand} resolvedThemeMode={resolvedThemeMode} />
        </Link>
      </div>
      {/* Center zone: global conversation search (⌘K palette). */}
      <div className="oc-topbar__search">
        <GlobalSearch />
      </div>
      <div className="oc-topbar__actions">
        <NotificationBell />
        <UserMenu label={userLabel} mode={themeMode} />
      </div>
    </header>
  );
}

// The authenticated, active-role chrome: impersonation banner + top bar +
// persistent sidebar, with the matched route rendered via <Outlet/>. This is
// the PERSISTENT CHROME — it does not unmount on navigation, so the sidebar
// layout + scroll position survive route changes (§3.5).
function AuthenticatedChrome({
  canOpenSettings,
  userLabel,
  themeMode,
  resolvedThemeMode,
  brand,
}: {
  canOpenSettings: boolean;
  userLabel: string;
  themeMode: ThemeMode | null;
  resolvedThemeMode: ThemeMode;
  brand: ChartBrand | undefined;
}) {
  const { width, collapsed, toggleCollapsed, collapse, startResize, isMobile } =
    useSidebarLayout();
  const matchRoute = useMatchRoute();
  // Active-chat highlight: read the chatId param without requiring a match on a
  // specific route (strict:false → undefined off the chat route).
  const params = useParams({ strict: false }) as { chatId?: string };
  const navigate = useNavigate();
  // Settings is active when any /settings/* route matches (fuzzy).
  const settingsActive = Boolean(matchRoute({ to: "/settings", fuzzy: true }));

  // Mobile: the sidebar is an overlay drawer. Close it on ANY navigation (chat
  // select, new chat, settings tab) so the user lands on full-width content; the
  // backdrop tap closes it otherwise. No-op on desktop (in-flow column).
  const pathname = useLocation({ select: (l) => l.pathname });
  useEffect(() => {
    if (isMobile) collapse();
  }, [pathname, isMobile, collapse]);

  // New-chat orchestration lives HERE (persistent chrome, always mounted) so the
  // ⌘⇧O / Ctrl+Shift+O global shortcut works on every surface — including when
  // the sidebar is collapsed or while in Settings, where ChatSidebar unmounts.
  // This mirrors the ⌘K search palette, which lives in the always-mounted topbar.
  const goToChat = useCallback(
    (id: Id<"chats">) => {
      void navigate({ to: "/chat/$chatId", params: { chatId: id } });
    },
    [navigate],
  );
  const { startNewChat, picker } = useStartNewChat(goToChat);
  const newChatShortcut = useMemo(
    () => shortcutLabel(SHORTCUT_NEW_CHAT, isMac()),
    [],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, SHORTCUT_NEW_CHAT)) {
        // Ctrl+Shift+O is Chrome's bookmark manager on Win/Linux but is NOT in
        // the hard-reserved set (Ctrl+N/T/W…), so preventDefault reclaims it.
        e.preventDefault();
        void startNewChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startNewChat]);

  return (
    <div className="oc-shell">
      {picker}
      <ImpersonationBanner />
      <DevUserSwitcher />
      <AppTopBar
        userLabel={userLabel}
        themeMode={themeMode}
        resolvedThemeMode={resolvedThemeMode}
        brand={brand}
        collapsed={collapsed}
        onToggleSidebar={toggleCollapsed}
      />
      <div className={isMobile ? "oc-workspace oc-workspace--mobile" : "oc-workspace"}>
        {/* Mobile: dim + tap-to-close backdrop behind the overlay drawer. */}
        {isMobile && !collapsed ? (
          <div
            className="oc-sidebar-backdrop"
            onClick={collapse}
            aria-hidden
          />
        ) : null}
        {!collapsed ? (
          <div
            className="oc-sidebar-col"
            // On mobile the drawer width is fixed by CSS (overlay); the inline
            // resizable width applies to the desktop in-flow column only.
            style={isMobile ? undefined : { width, flex: `0 0 ${width}px` }}
          >
            {/* In Settings, the chat list is replaced by a VERTICAL settings nav
                (the chat "disappears"); a top-bar / back link returns to chat. */}
            {settingsActive ? (
              <SettingsNav />
            ) : (
              <>
                <ChatSidebar
                  activeChatId={(params.chatId ?? null) as Id<"chats"> | null}
                  onSelect={goToChat}
                  onNewChat={() => void startNewChat()}
                  newChatShortcut={newChatShortcut}
                />
                {canOpenSettings ? (
                  <Button variant="ghost" className="m-2 justify-start" asChild>
                    {/* Land on the settings index, which redirects to the user's
                        FIRST allowed tab (not a hardcoded admin-only tab). */}
                    <Link to="/settings">{m.app_settings()}</Link>
                  </Button>
                ) : null}
              </>
            )}
            {/* Resize handle on the right edge. */}
            <div
              className="oc-sidebar-resizer"
              onPointerDown={startResize}
              role="separator"
              aria-orientation="vertical"
              aria-label={m.app_sidebar_resize()}
            />
          </div>
        ) : null}
        <main className="oc-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// ===========================================================================
// SETTINGS LAYOUT — admin guard + tab nav, with the matched tab route rendered
// via <Outlet/>. useToast() resolves through the APP-WIDE ToastProvider in
// RootShell (one provider, one toast surface — chat actions use it too).
// ===========================================================================

// TabLink, the FilteredTabPath union, and the (now drag-and-drop, per-user
// persisted) vertical SettingsNav moved to ./chat/admin/SettingsNav.tsx.

function SettingsLayout() {
  // Per-tab RBAC guard (the server enforces requirePermission/requireAdmin on
  // every tab query independently — this is the UX layer). A user with NO
  // visible tab is bounced to "/"; a user landing on a tab they can't see gets a
  // clean "access denied" panel instead of an empty/broken view. The active tab
  // is read from the pathname (URL is always /settings/<tab>), which works for
  // both the static (filtered) and the shared $tab routes.
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as Me | undefined;
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const visible = useMemo(
    () => (me ? visibleTabs(me.permissions ?? []) : []),
    [me],
  );
  const noAccess = me !== undefined && visible.length === 0;
  useEffect(() => {
    if (noAccess) void navigate({ to: "/" });
  }, [noAccess, navigate]);

  if (me === undefined) {
    return <div className="oc-admin__hint" style={{ padding: 16 }}>{m.app_loading()}</div>;
  }
  if (noAccess) return null; // redirecting (no settings access at all)

  const activeTab = tabFromPathname(pathname);
  const denied = activeTab !== undefined && !visible.includes(activeTab);

  // The GROUP nav lives in the VERTICAL SettingsNav (left column, rendered by
  // AuthenticatedChrome). This layout adds the active group's horizontal tab
  // bar above the content: either the active tab (via <Outlet/>) or the
  // access-denied panel when the tab isn't allowed.
  return (
    <div className="oc-admin">
      <SettingsTabBar />
      <div className="oc-admin__body">
        {denied ? <SettingsAccessDenied /> : <Outlet />}
      </div>
    </div>
  );
}

// Clean in-app "you can't see this tab" panel (a non-admin reached a tab their
// permissions don't grant — e.g. by typing the URL). No raw error; the server
// query would also refuse to return data.
function SettingsAccessDenied() {
  return (
    <div className="oc-route-error" role="alert">
      <div className="oc-route-error__icon" aria-hidden>
        <AlertTriangle size={28} />
      </div>
      <h2 className="oc-route-error__title">{m.app_access_denied_title()}</h2>
      <p className="oc-route-error__body">{m.app_access_denied_body()}</p>
    </div>
  );
}

// Settings index: redirect to the user's FIRST allowed tab (admins → users; a
// traces-only user → traces). No allowed tab → back to chat. This replaces the
// old hardcoded /settings/users redirect, which would have dropped a non-admin
// straight onto an access-denied panel.
function SettingsIndexRedirect() {
  const me = useQuery(api.me.getMe, { host: APP_HOST }) as Me | undefined;
  const navigate = useNavigate();
  useEffect(() => {
    if (me === undefined) return;
    const visible = visibleTabs(me.permissions ?? []);
    // Default landing = Personnel > Fichiers (the personal, always-visible tab)
    // rather than whatever tab happens to be first in the user's order — the
    // Settings entry point from a chat should start on the user's own space.
    const dest = visible.includes("files")
      ? pathForTab("files")
      : visible.length > 0
        ? pathForTab(visible[0])
        : "/";
    // pathForTab returns a valid /settings/<tab> path; cast to satisfy the typed
    // navigate `to` (runtime resolves the string against the route tree).
    void navigate({ to: dest as "/settings/users", replace: true });
  }, [me, navigate]);
  return <div className="oc-admin__hint" style={{ padding: 16 }}>{m.app_loading()}</div>;
}

// Paramless tab dispatcher: the four tabs that carry no search params share one
// `$tab` route. The param is validated to the closed set (catch → "roles").
function paramlessTab(tab: string) {
  switch (tab) {
    case "groups":
      return <GroupsTab />;
    case "integrations":
      return <IntegrationsTab />;
    case "instances":
      return <InstancesTab />;
    case "injections":
      return <PromptInjectionsTab />;
    case "theme":
      return <ThemeShowroom />;
    case "feedbacks":
      return <FeedbacksTab />;
    case "subagentReports":
      return <SubAgentReportsTab />;
    case "files":
      return <FilesTab />;
    case "agentFiles":
      return <AgentFilesTab />;
    case "preferences":
      return <PreferencesTab />;
    case "chatDefaults":
      return <ChatDefaultsTab />;
    case "access":
      return <AccessTab />;
    case "roles":
    default:
      return <RolesTab />;
  }
}

function SettingsParamlessScreen() {
  const { tab } = useParams({ from: "/settings/$tab" });
  // Suspense boundary for the lazy-loaded paramless tabs (the eager InstancesTab,
  // still in the AdminSettings barrel, simply renders without suspending).
  return (
    <Suspense fallback={<div className="oc-settings__tab-loading" aria-busy="true" />}>
      {paramlessTab(tab)}
    </Suspense>
  );
}

// Chat route screen: reads the chatId path param + optional `?m` message anchor
// and feeds the chat surface.
function ChatScreen() {
  const { chatId } = useParams({ from: "/chat/$chatId" });
  const { m: focusMessageId } = useSearch({ from: "/chat/$chatId" });
  // Remember this as the last opened chat so returning to "/" (e.g. exiting
  // Settings) reopens it instead of the empty pane. See ChatHome.
  useEffect(() => {
    rememberChat(chatId);
  }, [chatId]);
  return (
    <ConvexChat
      chatId={chatId as ConvexId<"chats">}
      focusMessageId={focusMessageId ?? null}
    />
  );
}

// Chat home: restore the LAST opened chat if it still exists / is accessible,
// otherwise the empty pane. Validating the stored id against the user's chat list
// ignores a deleted chat AND preserves the impersonation "/" safety (a prior
// identity's chat is not in the new effective identity's list).
function ChatHome() {
  const navigate = useNavigate();
  const lastChatId = getLastChat();
  const chats = useQuery(api.messages.listChats, {}) as
    | Array<{ _id: string }>
    | undefined;
  const willRestore =
    lastChatId !== null &&
    chats !== undefined &&
    chats.some((c) => c._id === lastChatId);
  useEffect(() => {
    if (willRestore && lastChatId) {
      void navigate({
        to: "/chat/$chatId",
        params: { chatId: lastChatId },
        replace: true,
      });
    }
  }, [willRestore, lastChatId, navigate]);
  // Avoid flashing the empty pane while we still might restore (list loading, or
  // a redirect is imminent).
  if (lastChatId !== null && (chats === undefined || willRestore)) {
    return <div className="oc-boot">{m.app_loading()}</div>;
  }
  return <ConvexChat chatId={null} />;
}

// ===========================================================================
// ROUTE TREE
// ===========================================================================

const rootRoute = createRootRoute({ component: RootShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatHome,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "chat/$chatId",
  component: ChatScreen,
  // `?m=<messageId>` deep-links to a specific message (e.g. from a feedback
  // report's "Voir la conversation") — the thread scrolls to + highlights it.
  validateSearch: (search: Record<string, unknown>): { m?: string } => ({
    m: typeof search.m === "string" ? search.m : undefined,
  }),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  // Dynamic landing: the component reads getMe and redirects to the user's first
  // allowed tab (was a hardcoded beforeLoad redirect to /settings/users, which
  // would dead-end a non-admin on access-denied).
  component: SettingsIndexRedirect,
});

// One STATIC route per FILTERED tab → one typed validateSearch each.
const tracesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "traces",
  validateSearch: tracesSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/TracesTab"),
    "TracesTab",
  ),
});
const bridgeRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "bridge",
  validateSearch: bridgeSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/BridgeTab"),
    "BridgeTab",
  ),
});
const voiceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "voice",
  validateSearch: voiceSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/VoiceTab"),
    "VoiceTab",
  ),
});
const auditRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "audit",
  validateSearch: auditSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/AuditTab"),
    "AuditTab",
  ),
});
const anomaliesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "anomalies",
  validateSearch: anomaliesSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/AnomaliesTab"),
    "AnomaliesTab",
  ),
});
const kpiRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "kpi",
  validateSearch: kpiSearchSchema,
  component: lazyRouteComponent(() => import("./chat/admin/KpiTab"), "KpiTab"),
});
const serviceAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "serviceAccounts",
  validateSearch: serviceAccountsSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/ServiceAccountsTab"),
    "ServiceAccountsTab",
  ),
});
const usersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "users",
  validateSearch: usersSearchSchema,
  component: lazyRouteComponent(
    () => import("./chat/admin/UsersTab"),
    "UsersTab",
  ),
});
// Legacy tab URL: the retired `uiprefs` admin tab merged into Preferences.
// A STATIC route (static beats the $tab param route) that hard-redirects, so
// old bookmarks land on the absorbing tab instead of a 404 / wrong tab. The
// source→target table lives in AdminSettings (SETTINGS_TAB_REDIRECTS, pinned
// by tabAccess.test.ts).
const uiprefsRedirectRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "uiprefs",
  beforeLoad: () => {
    throw redirect({
      to: "/settings/$tab",
      params: { tab: SETTINGS_TAB_REDIRECTS.uiprefs },
      replace: true,
    });
  },
});
// Paramless tabs (roles | integrations | instances | theme): one shared route.
const settingsTabRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "$tab",
  parseParams: (p) => ({
    tab: z.enum([...PARAMLESS_TABS]).catch("roles").parse(p.tab),
  }),
  component: SettingsParamlessScreen,
});

// Router-wide error fallback (the safety net). TanStack renders this IN the
// nearest parent route boundary — i.e. inside RootShell's <Outlet> — so the app
// shell (sidebar + top bar) survives and the user never sees the raw
// "Something went wrong" screen with a thrown stack. We deliberately do NOT
// render `error.message` (it can carry "Forbidden: chat not owned by user" or
// other internal detail) — the message stays generic; details live in logs.
function RouteError({ error, reset }: ErrorComponentProps) {
  const navigate = useNavigate();
  // STALE-CHUNK self-heal: after a deploy, a lazy route's hashed chunk no longer
  // exists — reset() would re-run the SAME dead import (the prod "Une erreur est
  // survenue" on Settings ▸ Traces). Auto-reload ONCE (sessionStorage-guarded so a
  // genuinely broken deploy still shows this screen, never a reload loop); the
  // manual retry button also full-reloads in that case instead of reset().
  const staleChunk = isStaleChunkError(error);
  const [autoReloading] = useState(
    () => staleChunk && shouldAutoReloadForStaleChunk(Date.now()),
  );
  useEffect(() => {
    if (autoReloading) window.location.reload();
  }, [autoReloading]);
  if (autoReloading) {
    return (
      <div className="oc-route-error" role="status">
        <p className="oc-route-error__body">{m.app_updating()}</p>
      </div>
    );
  }
  return (
    <div className="oc-route-error" role="alert">
      <div className="oc-route-error__icon" aria-hidden>
        <AlertTriangle size={28} />
      </div>
      <h2 className="oc-route-error__title">{m.app_route_error_title()}</h2>
      <p className="oc-route-error__body">{m.app_route_error_body()}</p>
      <div className="oc-route-error__actions">
        <button
          type="button"
          className="oc-route-error__cta"
          onClick={() => {
            if (staleChunk) window.location.reload();
            else reset();
          }}
        >
          {m.app_retry()}
        </button>
        <button
          type="button"
          className="oc-route-error__cta oc-route-error__cta--ghost"
          onClick={() => void navigate({ to: "/" })}
        >
          {m.app_home()}
        </button>
      </div>
    </div>
  );
}

// Unknown URL fallback (also rendered inside the shell). Same friendly, in-app
// treatment as a not-found chat rather than a bare router default.
function RouteNotFound() {
  const navigate = useNavigate();
  return (
    <div className="oc-route-error" role="status">
      <div className="oc-route-error__icon" aria-hidden>
        <Compass size={28} />
      </div>
      <h2 className="oc-route-error__title">{m.app_not_found_title()}</h2>
      <p className="oc-route-error__body">{m.app_not_found_body()}</p>
      <div className="oc-route-error__actions">
        <button
          type="button"
          className="oc-route-error__cta"
          onClick={() => void navigate({ to: "/" })}
        >
          {m.app_home()}
        </button>
      </div>
    </div>
  );
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    tracesRoute,
    voiceRoute,
    bridgeRoute,
    auditRoute,
    anomaliesRoute,
    kpiRoute,
    serviceAccountsRoute,
    usersRoute,
    uiprefsRedirectRoute,
    settingsTabRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // App-shell-preserving fallbacks (see RouteError / RouteNotFound). Without
  // these, an unexpected throw in any route surfaces TanStack's raw default
  // error screen outside the application chrome.
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: RouteNotFound,
});

// Global type registration — makes the whole app type-safe against the tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
