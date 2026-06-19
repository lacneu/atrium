// The bundled Atrium mark (favicon glyph: brackets + heartbeat), the DEFAULT
// brand logo shown when no custom chart logo applies. `currentColor` → inherits
// the surrounding text color in light/dark. Shared by the top bar, the login
// brand, and the assistant message header so they never diverge.
export function AtriumMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path
        d="M25 15H15V49H25"
        stroke="currentColor"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M39 15H49V49H39"
        stroke="currentColor"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="20 33 26 33 29 25 33 41 37 29 41 33 44 33"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
