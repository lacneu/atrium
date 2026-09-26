// Which gateway an agent lives behind, as a glyph — the one fact a mixed room
// (OpenClaw and Hermes agents side by side) needs at a glance, and the one a
// text label would make every row longer to say.
//
// Drawn in the lucide idiom (24-unit box, 2px round strokes, currentColor) so it
// sits among the other icons without looking borrowed: a claw for OpenClaw, the
// messenger's feather for Hermes.

import { Feather } from "lucide-react";

export type GatewayKind = "openclaw" | "hermes";

export function GatewayMark({
  kind,
  size = 16,
  className,
}: {
  kind: GatewayKind;
  size?: number;
  className?: string;
}) {
  const label = kind === "hermes" ? "Hermes" : "OpenClaw";
  if (kind === "hermes") {
    return <Feather size={size} className={className} aria-label={label} role="img" />;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label={label}
    >
      {/* The arm, the palm, then the pincer's two fingers. */}
      <path d="M4 20l3-3" />
      <path d="M7 17a4 4 0 0 1 0-6l1-1" />
      <path d="M8 10c1-4 5-6.5 11-6-2.5 3-5 4.5-8 5.5" />
      <path d="M11 12.5c3 0 6 1 8.5 3.5-3 1-6 .5-8.5-1.5" />
      <path d="M7 17a4 4 0 0 0 5.5-1.5" />
    </svg>
  );
}
