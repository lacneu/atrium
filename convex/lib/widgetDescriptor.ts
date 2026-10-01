// The widget part's bounds, shared by every Convex reader and writer of it. Mirrors
// the bridge's (bridge/src/providers/openclaw/widgets.ts) — the Convex side re-checks
// rather than trusts the bridge body (compat is a trust boundary).

/** The gateway's managed-document grammar (`canvas.document.view` docId pattern,
 *  narrowed to the `cv_` documents `show_widget` mints). */
export const WIDGET_VIEW_ID_RE = /^cv_[A-Za-z0-9._-]{1,253}$/;
export const WIDGET_TITLE_MAX_CHARS = 200;
