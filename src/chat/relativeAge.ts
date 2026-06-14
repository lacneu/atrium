// Compact relative-age label for the chat sidebar (OpenWebUI-style "3j", "2sem"),
// gated behind the `showChatAge` UI preference. Pure → unit-tested (the frontend
// has no DOM test runner); the live capture cannot reliably prove every bucket.
//
// French, ultra-compact (the sidebar is narrow): no space, single unit, floored.
//   < 1 min     -> "maintenant"
//   < 1 h       -> "<n>min"
//   < 1 day     -> "<n>h"
//   < 7 days    -> "<n>j"
//   < ~4.3 weeks-> "<n>sem"
//   < 12 months -> "<n>mois"
//   else        -> "<n>an" / "<n>ans"

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY; // approximate, display-only
const YEAR = 365 * DAY;

export function relativeAge(timestamp: number, now: number): string {
  const delta = now - timestamp;
  // Clock skew / a just-stamped row can read slightly in the future — treat any
  // non-positive or sub-minute delta as "now" rather than showing a negative age.
  if (delta < MIN) return "maintenant";
  if (delta < HOUR) return `${Math.floor(delta / MIN)}min`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}j`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}sem`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mois`;
  const years = Math.floor(delta / YEAR);
  return `${years}an${years > 1 ? "s" : ""}`;
}
