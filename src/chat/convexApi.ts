// Single indirection point for the Convex generated API.
//
// `convex dev` / `convex codegen` writes the typed `api` object and `Id` helper
// into `convex/_generated/`. The relative path from this file depends on where
// the `convex/` folder lives in the repo. In the ROOT layout (mirroring
// claude-monitor) the chat code lives under the root `src/` next to a root-level
// `convex/`:
//
//   repo root
//   ├── convex/_generated/api        <-- generated here
//   └── src/chat/convexApi.ts
//
// From `src/chat/` that root-level folder is `../../convex/...` (two levels up:
// chat/ -> src/ -> root). NOTE: the LEGACY location was `frontend/src/chat/`,
// from which the path was `../../../convex/...` (three levels). Moving the chat
// code under the root `src/` is exactly why this import had to change.
//
// Until codegen has run at least once, the import below will not resolve; that
// is expected — it is a *generated* file. Run `npx convex dev` once.

export { api, internal } from "../../convex/_generated/api";
export type { Id, Doc } from "../../convex/_generated/dataModel";
