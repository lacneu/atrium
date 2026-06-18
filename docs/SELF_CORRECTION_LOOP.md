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

## What it does NOT do

`reconcile_chat` is the only corrective primitive today. It does not restart the
bridge, change config, or mutate conversation content. A `bridge_unavailable` /
`attachment_problem` / `dispatch_error` assessment is surfaced for a human/operator
to act on (with a concrete `suggestedAction`); it is never auto-applied.
