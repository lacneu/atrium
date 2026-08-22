# Atrium documentation

Everything in this directory is written for someone **using, deploying or
contributing to** Atrium. Start from the path that matches what you are trying
to do — each one is ordered, and the first entry is the one to read first.

## I want to run Atrium

| Read | For |
|---|---|
| **[installation/](installation/README.md)** — start here | Which installation profile fits you — evaluating Atrium, or running it for a team — what each gives you, what it does not, and what production adds around the same procedure. |
| [installation/COMPOSE.md](installation/COMPOSE.md) | **Docker Compose** — nine ordered steps, each stating its precondition, its exact command and how you know it worked. Plus the CI path, the lifecycle rules, and running the same containers without Compose. |
| [installation/HELM.md](installation/HELM.md) | **Kubernetes** — what the chart creates, where secrets come from, the three public origins, and the post-install step the chart deliberately does not perform. |
| [CONFIGURATION.md](CONFIGURATION.md) | The complete environment-variable reference: every variable, **which of the two scopes reads it**, whether it is required, its default and an anonymised example. Checked against the code by a test, so it cannot silently drift. |
| [`deploy/README.md`](../deploy/README.md) | What applies to every method: pre-flight, the three gotchas, how gateway credentials reach the bridge, hardening, media, image versioning. |
| [`deploy/TROUBLESHOOTING.md`](../deploy/TROUBLESHOOTING.md) | First-deploy problems with diagnosis and fix: private images, sign-in/JWT, agent discovery. |
| [`deploy/SHARED_FS_MEDIA.md`](../deploy/SHARED_FS_MEDIA.md) | Wiring the shared-filesystem media exchange. **Read it before mounting anything** — each instance has its own host path. |
| [INSTANCE_PROVISIONING.md](INSTANCE_PROVISIONING.md) | Registering a gateway with Atrium from an installer, with no administrator in a browser — the unattended counterpart of the admin form. |
| [OPENCLAW_VERSION_COMPAT.md](OPENCLAW_VERSION_COMPAT.md) | What to replay when a new OpenClaw version comes out, and why the harness needs no per-version branch. |

## I want to work on Atrium

| Read | For |
|---|---|
| **[DEVELOPMENT.md](DEVELOPMENT.md)** — start here | The local workflow: the app (React + Convex) and the bridge, tests, what you need running for each. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data flow and auth — and the central problem the design exists to solve: keeping **one user turn** coherent when a gateway fans it into many runs, tool output, media, compaction restarts and post-reconnect arrivals. |
| [BRIDGE_PROTOCOL.md](BRIDGE_PROTOCOL.md) | The bridge's two seams: Convex → bridge (outbound operations) and bridge → Convex (ingest). Read this before changing anything that crosses them. |
| [`AGENTS.md`](../AGENTS.md) | Contributor and AI-agent guide: repo map, commands, invariants, the live-vs-unit testing philosophy, git and security rules. |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How to propose a change. |

## I need the protocol specifications

These three are **load-bearing**: the code cites them by name, and one of them is
read by a CI gate. They are specifications of implemented behaviour — change them
with the code they describe.

| Read | For | Cited by |
|---|---|---|
| [PROTOCOL_CONTRACT.md](PROTOCOL_CONTRACT.md) | How per-version compatibility is *enforced*: vendored schemas, the coverage manifest, the CI ratchet, the runtime drift detector, and how all three surface on `/capabilities`. | the three coverage manifests, `protocol-drift.ts`, `protocol-coverage.test.ts` |
| [UPSTREAM_INTERPRETATION.md](UPSTREAM_INTERPRETATION.md) | How the official OpenClaw Control UI and the gateway source interpret the wire protocol, versus the Atrium normalizer and turn-sink. **Names the upstream tag the comparison was written against** — `bridge/test/upstream-reference.test.ts` reads this file and fails if the tag drifts from `maxValidated` and the replayed fixtures. | `run-manager.ts`, `normalizer.ts`, `bridge.ts`, `preemptRepark.ts`, `upstream-frames.test.ts` |
| [HYBRID_REHYDRATION.md](HYBRID_REHYDRATION.md) | Why a fresh gateway session gets a rolling summary plus a verbatim tail instead of a raw history dump, and how the two are budgeted. | `schema.ts`, `chatSummaries.ts`, `stream.ts`, `lib/rehydration.ts` |

## Operating and observing a live deployment

| Read | For |
|---|---|
| [SELF_CORRECTION_LOOP.md](SELF_CORRECTION_LOOP.md) | The closed loop an agent can drive over the MCP tools or `/api/v1` to diagnose a reported chat and, where a safe corrective exists, repair it. Metadata only — never message text, filenames, URLs or keys. |
| [provenance/PROVENANCE_CONTRACT.md](provenance/PROVENANCE_CONTRACT.md) | The `provenance/v1` contract — how a plugin makes its sources appear in the chat. Its JSON Schema sits beside it. |
| [`compliance/`](../compliance/) | Trust Center: SOC 2 control mapping, the metadata-only `/api/v1` surface, and the software-vs-operator shared-responsibility boundary. |
| [`mcp/README.md`](../mcp/README.md) | The MCP server exposing the metadata-only observability API to agents and CLIs. |

## Assets

`assets/` holds the marks, avatar and diagrams used by the README and the app.
`charts/` holds the chart definitions.

## What is deliberately not here

- **Deployment artifacts** live in [`deploy/`](../deploy/) — the compose files and
  the Helm chart — together with what applies to every method (pre-flight,
  gotchas, hardening, media). The ordered *procedures* are here, in
  [`installation/`](installation/README.md), one page per method.
- **Bridge-internal notes** live with the bridge: [`bridge/README.md`](../bridge/README.md)
  and [`bridge/local-openclaw/README.md`](../bridge/local-openclaw/README.md)
  (the local bench).
- **Work tracking** — plans, decision logs, gap registries, per-lot notes, dated
  bench records, retrospectives — is not in this repository at all. It lives in
  the maintainer's private notes. See the rule in
  [`AGENTS.md`](../AGENTS.md) ("No work-tracking docs in this repo"). If you are
  about to add a document that only makes sense to someone tracking the work,
  it does not belong here.
