// The retired top-level trash page (/trash). The user's own trash now lives in
// Settings › Deleted conversations; the old path stays a hard redirect so
// bookmarks and deep links land on that tab instead of a 404.

import { redirect } from "@tanstack/react-router";
import type { ParamlessTab } from "../AdminSettings";

/** Path segment of the retired page, mounted at the root of the route tree. */
export const LEGACY_TRASH_PATH = "trash";

/** The Settings tab that absorbed the page. */
export const TRASH_SETTINGS_TAB = "deletedChats" satisfies ParamlessTab;

/** `beforeLoad` of the legacy route: always redirects, replacing the history entry. */
export function redirectLegacyTrash(): never {
  throw redirect({
    to: "/settings/$tab",
    params: { tab: TRASH_SETTINGS_TAB },
    replace: true,
  });
}
