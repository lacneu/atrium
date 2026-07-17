// The sidebar tint palette + hue resolution, extracted so every surface
// (sidebar, folder page, folder picker) shares ONE vocabulary without import
// cycles. Values match the backend `chatColorValidator` / PROJECT_COLORS.

// Preset chat colors (token-driven, list display only). Each preset reads its
// charte variable (declared in convexChat.css, per mode) with the historical
// oklch as fallback — a charte can re-theme the whole sidebar palette without
// touching code.
export const CHAT_COLORS: { value: string; hue: string }[] = [
  { value: "red", hue: "var(--oc-accent-red, oklch(0.63 0.21 25))" },
  { value: "orange", hue: "var(--oc-accent-orange, oklch(0.7 0.17 50))" },
  { value: "amber", hue: "var(--oc-accent-amber, oklch(0.8 0.15 85))" },
  { value: "green", hue: "var(--oc-accent-green, oklch(0.7 0.16 150))" },
  { value: "teal", hue: "var(--oc-accent-teal, oklch(0.7 0.12 190))" },
  { value: "blue", hue: "var(--oc-accent-blue, oklch(0.62 0.19 250))" },
  { value: "violet", hue: "var(--oc-accent-violet, oklch(0.6 0.2 300))" },
  { value: "pink", hue: "var(--oc-accent-pink, oklch(0.7 0.2 350))" },
];

export const colorHue = (c: string | null | undefined) =>
  CHAT_COLORS.find((x) => x.value === c)?.hue ?? null;

// Stable AUTO hue for a project without a chosen color: hash its id into the
// preset palette so every folder is distinguishable at a glance without any
// setup, and keeps ITS hue across sessions. Exported for tests.
export function autoProjectHue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length]!.hue;
}

export const projectHue = (p: { _id: string; color?: string | null }): string =>
  colorHue(p.color) ?? autoProjectHue(p._id);
