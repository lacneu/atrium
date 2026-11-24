import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ChevronDown, CircleUserRound, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_HOST } from "@/lib/appHost";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { ThemeMode } from "@/lib/useTheme";
import { autheliaBrowserLogin } from "@/lib/autheliaLogin";

// Single top-right account menu: identity header + theme mode (radio) + sign out.
// Deliberately minimal — the most usual shortcuts only. Language and the detailed
// UI preferences moved to Settings → Preferences (gated on chats.read, visible to
// all). `mode` is the user's OWN theme preference (null = following the admin
// default); writing it is an optimistic Convex mutation, the reactive getMe then
// re-applies the theme everywhere.
export function UserMenu({
  label,
  mode,
  minimal = false,
  compact = false,
}: {
  label: string;
  mode: ThemeMode | null;
  // Minimal surface for an UNAPPROVED (pending) account: ONLY sign out — no theme
  // controls. A pending user has zero app permissions, so no app config either.
  minimal?: boolean;
  /** The top bar is a vertical rail (a phone in landscape): an icon, named by the
   *  label, and a menu that opens beside it. */
  compact?: boolean;
}) {
  const { signOut } = useAuthActions();
  async function leaveAtrium() {
    // Pause automatic SSO before invalidating the Atrium session. Other apps stay signed in.
    autheliaBrowserLogin().signedOut();
    await signOut();
  }
  // OPTIMISTIC: apply the chosen mode to the local getMe cache IMMEDIATELY (the app
  // reads resolvedThemeMode from there), then persist in the background. Without it
  // the theme only flips AFTER the server round-trip + the getMe-invalidation
  // cascade — on a constrained backend that's the "have to click several times" lag.
  const setThemeMode = useMutation(api.me.setThemeMode).withOptimisticUpdate(
    (store, { mode }) => {
      const cur = store.getQuery(api.me.getMe, { host: APP_HOST });
      if (!cur) return;
      const resolved =
        mode !== null ? mode : (cur.defaultThemeMode ?? "system");
      store.setQuery(
        api.me.getMe,
        { host: APP_HOST },
        { ...cur, themeMode: mode, resolvedThemeMode: resolved },
      );
    },
  );
  // Radio value: a concrete mode, or "default" when the user follows the admin
  // default (so there's always a path back to inheriting it).
  const value = mode ?? "default";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="icon" aria-label={label} title={label}>
            <CircleUserRound />
          </Button>
        ) : (
          // Every presentation the top bar's fit chooses from (topBarFit.ts): the
          // label — shortened where the bar is tight, its whole text in the title —
          // or the icon alone, named by the label. The bar's `data-fit` shows one.
          <Button
            variant="ghost"
            size="sm"
            className="oc-usermenu__trigger min-w-0 shrink gap-1.5"
            aria-label={label}
            title={label}
          >
            <CircleUserRound className="oc-usermenu__icon" aria-hidden />
            <span className="oc-usermenu__label">{label}</span>
            <ChevronDown className="oc-usermenu__chev opacity-60" aria-hidden />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? "right" : "bottom"} align="end" className="w-52">
        {minimal ? (
          <DropdownMenuItem onClick={() => void leaveAtrium()}>
            <LogOut /> {m.usermenu_sign_out()}
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuLabel>{m.usermenu_theme_label()}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={value}
              onValueChange={(v) =>
                void setThemeMode({
                  mode: v === "default" ? null : (v as ThemeMode),
                })
              }
            >
              <DropdownMenuRadioItem value="light">
                <Sun /> {m.usermenu_theme_light()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon /> {m.usermenu_theme_dark()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor /> {m.usermenu_theme_system()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="default">
                {m.usermenu_theme_default()}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void leaveAtrium()}>
              <LogOut /> {m.usermenu_sign_out()}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
