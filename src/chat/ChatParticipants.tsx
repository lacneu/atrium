// The avatar helpers shared by every place that shows a person of a conversation
// (the conversation panel, the mention picker). The roster itself is managed in
// ConversationPanel.tsx.

import "./chatParticipants.css";

/** Two letters at most, from a display name — never an image request. */
export function initialsOf(name: string): string {
  const parts = name
    .split(/[\s._-]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/**
 * A stable colour per person, so the same face keeps the same badge across
 * conversations. Derived from the id, not from the name: renaming somebody must
 * not repaint them.
 */
export function avatarToneOf(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i += 1) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return h % 8;
}

export function Avatar({ userId, name }: { userId: string; name: string }) {
  return (
    <span
      className="oc-avatar"
      data-tone={avatarToneOf(userId)}
      title={name}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}
