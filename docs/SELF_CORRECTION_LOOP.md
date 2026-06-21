# AI self-correction loop

When a user reports a problem with a chat, a specialized OpenClaw/Hermes agent
linked to that report can drive a closed loop entirely through the Atrium MCP tools
(or the equivalent `/api/v1` routes) — to **understand** the anomaly and, where a
safe corrective exists, **self-correct** the Atrium bridge. Everything below is
**SOC2-safe**: the tools expose only structure, lifecycle, codes and buckets —
never message text, filenames, URLs, keys, or any regulated data.

## The loop

```
user report (chatId)
   │
   ├─ 1. get_integrations            → is Opik/Langfuse wired + shipping healthy?
   │
   ├─ 2. diagnose_chat(chatId)       → ONE assessment:
   │        { class, severity, errorCode?, reason?, summary,
   │          suggestedAction, suggestedTool }
   │      classes: stuck_stream | dispatch_error | attachment_problem
   │               | bridge_unavailable | bridge_degraded | healthy | unknown_chat
   │
   ├─ 3. (optional) get_chat_state(chatId)            → per-message lifecycle
   │     (optional) list_traces / list_anomalies      → the correlationId chain
   │     (optional) get_trace_enrichment(correlationId,chatId?) → the REAL OpenClaw
   │                            message STRUCTURE from Opik/Langfuse (chatId adds the
   │                            content-free Langfuse session augmentation)
   │
   └─ 4. ACT on `suggestedAction` / `suggestedTool`:
          • class=stuck_stream → reconcile_chat(chatId)   ← the bounded self-heal
          • class=attachment_problem / dispatch_error → surface the fix to the
            user/operator (e.g. "send a smaller file", "fix OPENCLAW_AGENT_ID")
          • class=bridge_unavailable → escalate (it blocks ALL chats; ops action)
```

## The tools

| Tool | Route | Permission | Effect |
|---|---|---|---|
| `get_integrations` | `GET /api/v1/integrations` | `traces.read` | Per-vendor configured/enabled + shipping cursors. No keys. |
| `diagnose_chat` | `GET /api/v1/diagnose` | `traces.read` | Aggregated assessment + suggested action/tool. Read-only. |
| `get_trace_enrichment` | `GET /api/v1/trace-enrichment` | `traces.read` | SOC2-safe span/observation STRUCTURE from Opik/Langfuse, keyed by `correlationId`. Optional `chatId` adds the Langfuse session augmentation (`fields=core` list = no io on the wire), surfacing other/OpenClaw traces on the same session. |
| `get_chat_state` | `GET /api/v1/chat-state` | `traces.read` | Per-message lifecycle (metadata only). |
| `reconcile_chat` | `POST /api/v1/reconcile-chat` | **`selfheal`** | Flip a chat's stuck `streaming` message → error (text preserved), releasing the hung UI. Audited. |

## Why this is safe

- **The only write** is `reconcile_chat`, and it is bounded: it touches only
  messages **already** stuck in `streaming` past a short cutoff (60s), in **one**
  chat, and it preserves all text/parts — it just flips the lifecycle so the UI
  releases. It is the deliberate, chat-scoped twin of the 12-min passive watchdog.
- It is gated on a dedicated **`selfheal`** permission — admin / service-account
  only, never grantable to ordinary users — and every call writes an `api.call`
  trace plus an `assistant.reconcile` audit event with the caller's principal id.
- Diagnosis is **read-only** and SOC2-safe by construction (the enrichment fetch
  requests Langfuse `fields=core,basic,time` / drops Opik input/output, and the
  projection is an explicit structural allowlist — see `convex/integrations/enrich.ts`).

## Document-fetch observability ("Joindre les documents")

"Joindre les documents" fetches the real source files behind a reply's documentary
sources and surfaces them as downloadable links. The fetch runs in a hidden per-user
documentary chat (its own gateway session). The whole fetch is diagnosable end-to-end
and SOC2-safe — the diagnostic surface carries counts/ids only, **never** a
`reference`, `file_name`, `entryKey`, or URL (`entryKey` embeds the file_name, so it
is excluded from every trace).

**Trace kinds** (`list_traces`, filter by `kind`). All three traces of one fetch share
the same `correlationId` (`docfetch:<sourceMessageId>:<createdAt>`), so a fetch is
queryable as a single span; each meta also carries `hiddenChatId` to pivot into the
hidden chat's `openclaw.dispatch` / `assistant.stream` traces:

| kind | when | meta (counts only) |
|---|---|---|
| `documentary.attach` | fetch dispatched | `submitted`, `queued`, `distinctFiles`, `droppedNotSource` (>0 = a client submitted a reference NOT shown as a source — a tamper signal) |
| `documentary.correlate` | fetch settled | `total`, `ready`, `notFound`, `mediaReturned` + `latencyMs` (full round-trip) |
| `documentary.fail` | dispatch error or watchdog release | `failed`, `reason` (`dispatch_error` \| `stuck_stream`) |

Example — follow one fetch end-to-end: `list_traces?correlationId=docfetch:<id>:<ts>`
returns its `documentary.attach` then either `documentary.correlate` (counts of files
resolved vs not found) or `documentary.fail` (with the reason).

**chat-state** (`get_chat_state`): each message carries `attachedDocCount` (the count
of ready downloadable files); the chat carries `kind` (`"documentary"` marks the hidden
fetch chat) and `pendingDocFetch: { sourceMessageId, ageSeconds }`. A large `ageSeconds`
means a STUCK fetch — the owner is locked out of further fetches by the
`fetch_in_flight` guard.

**diagnose_chat**: a `pendingDocFetch` older than 12 minutes is classified
`attachment_problem` with `suggestedTool=reconcile_chat`. The failure mode here is the
*absence* of a settle, so the signal is the pending age, not a `documentary.fail` trace.

**Self-heal**: the stuck-stream watchdog (and the deliberate `reconcile_chat`) also
release a stuck documentary `pendingFetch` — clearing the lock, marking its rows
`failed`, and emitting `documentary.fail` (`reason:"stuck_stream"`). This makes the
otherwise silent "pendingFetch never cleared" case observable and self-healing. Running
`reconcile_chat` on the hidden documentary chat (its id is in each document-fetch
trace's `hiddenChatId`) releases even a completed-but-stuck fetch.

**User report**: the server-frozen feedback snapshot (`feedback.submitFeedback`)
bundles the document-fetch state for the reported message — per-card `status`,
`entryKey`, `reference` (the reporter's own data, like the provenance file_names already
in `partsJson`) plus `docFetchPendingAgeSeconds` — but never the storageId or signed URL.

## What it does NOT do

`reconcile_chat` is the only corrective primitive today. It does not restart the
bridge, change config, or mutate conversation content. A `bridge_unavailable` /
`attachment_problem` / `dispatch_error` assessment is surfaced for a human/operator
to act on (with a concrete `suggestedAction`); it is never auto-applied.
