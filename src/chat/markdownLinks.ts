// Whether a markdown link href is a real, browser-navigable URL. Agent-authored
// markdown often contains links whose href is NOT navigable — a server-side FILE
// PATH (`/home/node/...`), a bare filename (`rapport.pdf`), or a scheme the browser
// won't open (`media://`, `file:`). Rendering those as a real <a> makes a click
// resolve RELATIVE to the app origin, so the SPA router shows the home/404 screen
// instead of "opening the file". Only http(s) and mailto are treated as navigable
// (a hosted file is an absolute storage URL → http, so it stays clickable).
export function isNavigableHref(href: unknown): boolean {
  return typeof href === "string" && /^(https?:|mailto:)/i.test(href.trim());
}
