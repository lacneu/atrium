// Persist the LAST opened chat (per browser) so returning to the chat root --
// exiting Settings, the brand/home link, a reload to "/" -- reopens it instead of
// the empty "select a conversation" pane. Client-only (localStorage), mirroring the
// theme + sidebar prefs. ChatHome validates the stored id against the user's chat
// list before redirecting, so a deleted / foreign (impersonation) chat is ignored.

const KEY = "atrium:lastChatId";

/** Record the currently open chat as the one to restore on the next return to "/". */
export function rememberChat(chatId: string): void {
  try {
    localStorage.setItem(KEY, chatId);
  } catch {
    // Private mode / storage disabled -- non-fatal; the feature simply no-ops.
  }
}

/** The last opened chat id, or null if none stored / storage unavailable. */
export function getLastChat(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
