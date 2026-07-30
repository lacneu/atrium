# 02 — Inventaire d'émission Hermes (source de vérité amont)

Zone : **Hermes = second provider, ZÉRO contrat de protocole côté Atrium.**

| | |
|---|---|
| Amont lu | `/tmp/hermes-upstream.okb8T2` — `git describe` = `v2026.7.20` = `hermes_cli.__version__ == "0.19.0"` |
| Version validée par Atrium | `0.18.2` = tag `v2026.7.7.2` (`bridge/src/compat.ts:192-195`) |
| Atrium lu | `<workspace>/atrium/bridge/src/providers/hermes/` (3129 lignes, 8 fichiers) |
| Artefacts de contrat côté Atrium | **AUCUN** — `bridge/protocol/` ne contient que `openclaw/` (vérifié : `ls bridge/protocol/` → `openclaw`) |
| Fixtures live existantes | `bridge/test/fixtures/hermes/` : `capabilities.json`, `chat-stream-{success,error}.sse`, `session-create.json`, `ws-capture.jsonl`, `ws-moa.jsonl`, `ws-subagent.jsonl`, `ws-tools.jsonl` |

Correspondance tag ↔ version (prouvée, `git show <tag>:hermes_cli/__init__.py`) :
`v2026.7.1`=0.18.0 · `v2026.7.7`=0.18.1 · **`v2026.7.7.2`=0.18.2** · **`v2026.7.20`=0.19.0**

---

## 0. Topologie des transports — ce qui est prouvé

Atrium parle à **deux serveurs Python DIFFÉRENTS**, dans deux processus différents, avec deux
protocoles différents. C'est la première chose à écrire dans le contrat.

| Transport Atrium | Fichier Atrium | Serveur amont | Fichier amont | Framing |
|---|---|---|---|---|
| REST + SSE (`transport: "rest"`) | `client.ts`, `sse.ts`, `turn.ts`, `normalizer.ts` | `ApiServerAdapter` (aiohttp) | `gateway/platforms/api_server.py` (5565 l.) | `event: <nom>\ndata: <json>\n\n` |
| WebSocket JSON-RPC (`transport: "ws"`, **défaut** — `dispatch.ts:794` `cfg.transport ?? "ws"`) | `ws-client.ts`, `ws-turn.ts` | `tui_gateway` monté sur `/api/ws` | `tui_gateway/server.py` (15930 l.) + `tui_gateway/ws.py` | 1 objet JSON-RPC par frame texte WS |

Points de montage prouvés :
- REST : `gateway/platforms/api_server.py:1497-1518` (table de routes).
- WS : `hermes_cli/web_server.py:17679` `@app.websocket("/api/ws")` → `tui_gateway/ws.py:handle_ws`.

**Framing WS — VÉRIFIÉ SAIN.** `tui_gateway/ws.py:233-242` `_safe_send_many()` fait
`await self._ws.send_text(line)` **par ligne** : le batching de coalescence des tokens
(`ws.py:53-60`, `_STREAMING_EVENT_TYPES = {message.delta, reasoning.delta, thinking.delta}`,
fenêtre 33 ms) n'agrège **pas** plusieurs JSON dans une même frame. Le `JSON.parse(String(raw))`
d'Atrium (`ws-client.ts:157`) est donc correct. L'ordre est préservé : toute frame non-streaming
draine le buffer devant elle (`ws.py:141-155`). **À inscrire comme invariant testé**, pas à corriger.

---

## 1. TRANSPORT REST/SSE — `POST /api/sessions/{id}/chat/stream`

C'est le seul endpoint SSE qu'Atrium consomme (`client.ts:openStream`).
Enveloppe commune injectée par `_event_payload` (`api_server.py:2537-2544`) :
`{session_id, run_id, seq, ts}` + le payload propre. **`seq` est un compteur monotone par tour** —
Atrium ne le lit nulle part (aucune occurrence de `seq` dans `normalizer.ts`).

| # | Frame (nom SSE) | Site d'émission | Payload | Atrium consomme ? |
|---|---|---|---|---|
| 1 | `run.started` | `api_server.py:2572` | `{user_message:{role,content}}` | ✔ `normalizer.ts:298` → `run.status=streaming` |
| 2 | `message.started` | `api_server.py:2573` | `{message:{id,role}}` | ⊘ ignoré volontairement (`normalizer.ts:68`) |
| 3 | `assistant.delta` | `api_server.py:2563` (`_delta`) | `{message_id, delta:"…"}` | ✔ `normalizer.ts:283` → `message.delta` |
| 4 | `tool.progress` | `api_server.py:2567` (`_tool_progress`, cas `reasoning.available`) | `{message_id, tool_name, delta}` | ✔ partiel `normalizer.ts:290` (`_thinking` filtré) |
| 5 | `tool.started` | `api_server.py:2569` | `{message_id, tool_name, preview, args}` | ✔ `normalizer.ts:307` |
| 6 | `tool.completed` | `api_server.py:2569` | `{message_id, tool_name, preview, args}` | ✔ `normalizer.ts:334` |
| 7 | **`tool.failed`** | `api_server.py:2567-2569` (`event_type in {tool.started, tool.completed, tool.failed}`) | idem | ✘ **NON GÉRÉ** — voir HZ-05 |
| 8 | `assistant.completed` | `api_server.py:2588` | `{session_id, message_id, content, completed, partial, interrupted}` | ✔ partiel `normalizer.ts:262` — **`partial` et `interrupted` jetés** |
| 9 | `run.completed` | `api_server.py:2596` | `{session_id, message_id, completed, messages:[…], usage:{input_tokens,output_tokens,total_tokens}}` | ✔ partiel `normalizer.ts:275` — **`usage` jeté** |
| 10 | `error` | `api_server.py:2605` | `{message}` (redacté par `_redact_api_error_text`) | ✔ `normalizer.ts:250` |
| 11 | `done` | `api_server.py:2607` | `{}` | ✔ `normalizer.ts:277` |
| — | keepalive | `api_server.py:2635` `b": keepalive\n\n"` | commentaire SSE | ✔ ignoré par `sse.ts:67` |

`usage` amont (SSE) est construit dans `_run_sync` : `api_server.py:5013-5017`
`{input_tokens, output_tokens, total_tokens}` — **pas de `context_used`/`context_max`**.
Donc même en le lisant, la jauge de pression contexte n'est PAS dérivable sur ce transport.

### `/v1/runs` — surface SSE **existante mais NON utilisée par Atrium**

`GET /v1/runs/{id}/events` (`api_server.py:5139`) émet un framing **DIFFÉRENT** :
`data: {json}` **sans** ligne `event:` — le nom est dans le champ JSON `"event"`
(`api_server.py:5177`). Le `SseParser` d'Atrium mettrait `event:"message"` pour toutes ces frames :
si quelqu'un branche ce endpoint sans adapter le normalizer, **tout est ignoré silencieusement**.

Événements : `tool.started`, `tool.completed` (avec `duration`, **`error: bool`**),
`reasoning.available`, `message.delta`, `run.cancelled`, `run.failed`, `run.completed`
(avec `output` + `usage`), `approval.request` (avec `choices`), `approval.responded`
(`api_server.py:4749, 4757, 4766, 4880, 4907, 4939, 5008, 5023, 5037, 5058, 5075, 5262`).
Atrium n'utilise de `/v1/runs` que `POST /v1/runs/{id}/stop` (`client.ts:stopRun`).

Note : `_make_run_event_callback` **ne relaie PAS** `_thinking` ni `subagent_progress`
(`api_server.py:4771`) — la délégation est invisible sur `/v1/runs`.

---

## 2. TRANSPORT WS JSON-RPC — surface d'événements COMPLÈTE

Enveloppe : `{"jsonrpc":"2.0","method":"event","params":{"type":<nom>,"session_id":<sid>,"payload":{…}}}`
(`tui_gateway/server.py:1207-1211`).

**Inventaire exhaustif** (extraction AST de tous les appels `_emit`/`_voice_emit` dans
`tui_gateway/server.py`, 36 noms littéraux + 4 dynamiques) :

| Événement | Occurrences (lignes) | Payload (champs prouvés) | Atrium |
|---|---|---|---|
| `gateway.ready` | `ws.py:324` | `{skin}` | ✔ handshake (`ws-client.ts:186`) |
| `message.start` | 4287, 9770, 9838, 9928, 10416, 10462 | — | ⊘ ignoré (`ws-turn.ts:703`) |
| `message.delta` | 4296, 4301, **10063** | `{text, rendered?}` | ✔ `ws-turn.ts:309` |
| `message.interim` | 4386, **10072** | `{text, already_streamed}` | ✘ **PERDU** — HZ-04 |
| `message.complete` | 1335, 4319, **10209** | `{text, usage{…}, status, reasoning?, warning?, rendered?, response_previewed?}` | ✔ partiel `ws-turn.ts:543` |
| `thinking.delta` | 4336 | `{text}` | ✔ `ws-turn.ts:316` |
| `reasoning.delta` | 4290, 4340 | `{text, verbose?}` | ✔ `ws-turn.ts:317` |
| `reasoning.available` | 4150 | `{text, verbose?}` | ⊘ ignoré |
| `status.update` | 1423, 9745, 9821, 10247 | `{kind, text}` — kinds : `status`, `lifecycle`→`compacting`, `process`, `goal` | ✔ **seulement `compacting`** (`ws-turn.ts:345`) |
| `tool.start` | 4068, 4314 | `{tool_id, name, context, args_text?}` | ✔ `ws-turn.ts:490` |
| `tool.generating` | 4335 | `{name}` | ✔ `ws-turn.ts:491` |
| `tool.complete` | 4115, 4304, 4317 | `{tool_id, name, args, result, duration_s, summary, result_text?, todos?, inline_diff?}` | ✔ partiel `ws-turn.ts:507` — **`result`/`summary`/`inline_diff`/`todos` jetés** |
| `tool.output_risk` | 4144 | `{tool_id, name, risk, findings[], redacted}` | ✘ **PERDU** — HZ-06 |
| `session.info` | **21 sites** (1342, 3916, 4450, …, 14592) | `{model, provider, reasoning_effort, service_tier, fast, yolo, approval_mode, tools, skills, cwd, branch, project, running, title, stored_session_id, **desktop_contract**, **version**, **release_date**, update_behind, usage, profile_name, install_warning?}` | ✔ **3 champs sur 22** (`ws-turn.ts:521-528`) — HZ-01 |
| `session.title` | 10324 | `{session_id, title}` | ⊘ ignoré |
| `error` | 1706, 3456, 5717, 9481, 9992, 10369 | `{message}` | ✔ `ws-turn.ts:666` |
| `approval.request` | 1407 (`_emit_approval_request`) | `{command(redacté), choices[], smart_denied?, allow_permanent?, request_id?, …}` | ✔ settle actionnable (`ws-turn.ts:356`) |
| `clarify.request` | 4366 via `_block(timeout=300)` | `{question, choices, request_id}` | ✘ **BLOQUE 300 s** — HZ-03 |
| `secret.request` | 4467 via `_block(timeout=300)` | `{prompt, env_var, metadata?, request_id}` | ✘ **BLOQUE 300 s** — HZ-03 |
| `sudo.request` | 4460 via `_block(timeout=120)` | `{request_id}` | ✘ **BLOQUE 120 s** — HZ-03 |
| `terminal.read.request` | 4371 via `_block(timeout=30)` | `{start?, count?, request_id}` | ✘ bloque 30 s |
| `secret.expire` / `sudo.expire` | 2367 (dynamique `f"{event}.expire"`) | `{request_id}` | ✘ ignoré |
| `subagent.start` | `tools/delegate_tool.py:919, 1942` → `server.py:4230` | `{goal, task_count, task_index, subagent_id, parent_id, child_session_id, depth, model, tool_count, toolsets[], text}` | ✔ `ws-turn.ts:372` |
| `subagent.thinking` | `delegate_tool.py:957` | `{…, text}` | ✔ |
| `subagent.tool` | `delegate_tool.py:1010` | `{…, tool_name, tool_preview, text}` | ✔ |
| `subagent.progress` | `delegate_tool.py:1014, 1021` | `{…, text}` | ✔ |
| `subagent.complete` | `delegate_tool.py:923, 2064, 2320, 2332` | `{…, status, summary, duration_seconds, input_tokens, output_tokens, reasoning_tokens, api_calls, files_read[], files_written[], output_tail[]}` | ✔ partiel — **tokens/fichiers/output_tail jetés** (`ws-turn.ts:405-420`) |
| `subagent.text` | `delegate_tool.py:932, 1999` | `{text}` | **JAMAIS émis sur le sid parent** (`server.py:4230` `if event_type != "subagent.text"`) — miroir enfant seul |
| `moa.reference` | 4165 | `{label, text, index, count}` | ✔ `ws-turn.ts:430` |
| `moa.aggregating` | 4168 | `{aggregator}` | ✔ `ws-turn.ts:457` |
| `notification.show` | 4351 | `{text, level, kind, ttl_ms, key, id}` | ✘ ignoré |
| `notification.clear` | 4363 | `{key}` | ✘ ignoré |
| `background.complete` | 11121, 11134 | `{…}` | ✘ ignoré |
| `review.summary` | 1673, 5244 | `{…}` | ✘ ignoré |
| `billing.step_up.verification` | 8659 | `{…}` | ✘ ignoré |
| `agent.terminal.output` | 9883 | `{process_id, chunk}` | ✘ ignoré |
| `terminal.close` | 9893 | `{process_id}` — **sid peut être `""`** | ✘ ignoré + non routable |
| `preview.restart.progress/.complete` | 4773, 11221, 11239, 11241 | `{…}` | ✘ ignoré |
| `browser.progress` | 15256 | `{…}` | ✘ ignoré |
| `pet.*`, `skin.changed`, `reaction`, `voice.status`, `voice.transcript` | 7988-8100, 11882, 4339, 14937-14939 | cosmétique | ✘ ignoré (OK) |

`message.complete.usage` (`server.py:3605-3662`, `_get_usage`) :
`{model, input, output, reasoning, prompt, completion, total, calls, context_used?, context_max?,
context_percent?, compressions?, active_subagents?, dev_credits_spent_micros?}`.
Atrium ne lit que `context_used` + `context_max` (`ws-turn.ts:609-611`). **`compressions`,
`active_subagents`, `calls`, `context_percent` sont perdus** — dont `compressions` qui est
exactement le compteur de compaction que la zone « erreurs de contexte dépassé » réclame.

`message.complete.status` ∈ **`{"complete", "interrupted", "error"}`** (`server.py:10169-10173`).
Atrium fait `status === "error" ? "error" : "complete"` (`ws-turn.ts:625`) → **`interrupted`
devient `complete`** : HZ-02.

---

## 3. RPC WS — ce qu'Atrium appelle, et ce qu'il ignore dans la réponse

Atrium appelle **9 RPC sur 122** (extraction : `grep -rn 'call("' bridge/src/providers/hermes/`) :

| RPC | Site Atrium | Résultat amont | Ce qu'Atrium ignore |
|---|---|---|---|
| `session.create` | `ws-turn.ts:149, 164` (params `{}`) | `{session_id, stored_session_id, info{…, desktop_contract, lazy, cwd, model}}` (`server.py:5895-5915`) | `desktop_contract`; peut renvoyer **erreur 4090** (quota de sessions actives, `server.py:5829-5830`) |
| `session.resume` | `ws-turn.ts:141` | `{info, message_count, messages, **running**, session_id, session_key, started_at, **status**, **inflight**, **queued**}` (`server.py:6660-6693`) | **`running`, `status`, `inflight`, `queued`** — HZ-07 |
| `session.status` | `ws-turn.ts:571` | **`{"output": "<texte rendu>"}` UNIQUEMENT** (`server.py:8736`) | Atrium y cherche `cwd` → **code mort** — HZ-08 |
| `prompt.submit` | `ws-turn.ts:749` | `{status}` ∈ **`{"streaming","queued","steered"}`** (+ `turn_isolation`) (`server.py:5677, 5691, 1332`) | **le champ `status`** — HZ-09 |
| `session.interrupt` | `dispatch.ts:474` | `{status:"interrupted"}` ; **efface `queued_prompt`** (`server.py:9101`) | — |
| `image.attach_bytes` | `ws-turn.ts:731` | `{…}` | — |
| `file.attach` | `ws-turn.ts:737` | `{attached, name, path, ref_path, ref_text, uploaded}` (`server.py:11017-11026`) | Atrium lit `ref_text` ✔ |
| `cron.manage` | `dispatch.ts:577, 653` | actions amont : `list`, **`add`**, `remove`, `pause`, `resume` (`server.py:15649-15671`) | Atrium n'expose pas `add` |
| `model.options` | `dispatch.ts:799` | `{providers[…]}` | — |

Codes d'erreur JSON-RPC rencontrables et non discriminés côté Atrium (tous repliés en
`RPC_ERROR`, `ws-client.ts:212`) : `4009` session/subagent occupé, `4018` ordinal hors bornes,
`4090` quota de sessions, `5019` compute-host, `5023` cron, `5028` file.attach, `-32601` méthode
inconnue (`tests/tui_gateway/test_protocol.py:58`).

---

## 4. Delta de surface **0.18.2 → 0.19.0** (méthode : `git diff v2026.7.7.2 v2026.7.20`)

| Surface | Ajouté en 0.19.0 | Retiré | Verdict |
|---|---|---|---|
| Événements SSE (`api_server.py`) | **aucun** | aucun | **STABLE** |
| Routes HTTP | `POST /api/platforms/{platform}/events` | aucune | additif |
| Événements WS (`tui_gateway/server.py`) | `message.interim`, `reaction`, `tool.output_risk` | aucun | additif |
| RPC WS | `subscription.state/preview/change/resume/upgrade`, `usage.bars` | **`credits.view`** | non utilisés par Atrium |
| **`DESKTOP_BACKEND_CONTRACT`** | **2 → 4** (`server.py:3726`) | — | **rupture déclarée** |

Sémantique du contrat (commentaire canonique `tui_gateway/server.py:3719-3726`, miroir client
`apps/desktop/src/store/updates.ts:90-95`) :
- v2 : ajoute le RPC `file.attach` ;
- v3 : ajoute les RPC `approvals.mode` + la réconciliation `session.info` ;
- v4 : `session.create fast=false` = override per-session « normal tier » explicite.

Le client officiel (desktop) **refuse de piloter** un backend dont `desktop_contract` est inférieur
au sien et affiche un toast de skew. **Atrium n'a aucun équivalent.**

Le seul de ces deltas qui mord aujourd'hui : les 2 événements WS `message.interim` et
`tool.output_risk` **existent depuis 0.19.0 et sont jetés** (HZ-04, HZ-06).

---

## 5. Contrat exploitable : existe-t-il un artefact ?

**Non, pas au sens OpenClaw.** Vérifications faites :
- pas de modèles pydantic pour les événements (`grep BaseModel tui_gateway/ gateway/platforms/` → 0) ;
- pas d'OpenAPI ni de JSON Schema pour la surface gateway ;
- pas de dataclasses d'événement.

**Mais trois artefacts machine EXISTENT et sont exploitables** — c'est la base d'un vendoring vérifiable :

1. **`DESKTOP_BACKEND_CONTRACT`** (`tui_gateway/server.py:3726`) — entier monotone, émis dans
   `session.info`, `session.create.info`, `session.resume.info` (`server.py:3828, 5910, 6060`).
   C'est **le numéro de contrat que l'amont maintient lui-même**. Testé amont :
   `tests/test_tui_gateway_server.py:4029, 7567`, `tests/tui_gateway/test_protocol.py:466, 660`.
2. **`GET /v1/capabilities`** (`api_server.py:2004-2070`) — `{features{…33 booléens}, endpoints{…28}}`,
   déjà capturé dans `bridge/test/fixtures/hermes/capabilities.json`. Couvre le REST uniquement.
3. **`session.info.version` + `release_date`** (`server.py:3849-3851`) et
   **`GET /api/status` → `{"version", "release_date", …}`** (`hermes_cli/web_server.py:2935-2936`,
   endpoint **public**, documenté `PUBLIC_API_PATHS`, sur le même host que `/api/ws`).

### Vendoring proposé (vérifiable, sans schéma amont)

Répliquer la mécanique OpenClaw (`bridge/protocol/openclaw/<version>/` + `coverage.json`) en
**dérivant** le contrat par extraction déterministe :

```
bridge/protocol/hermes/0.19.0/
  ws-events.json      # généré par AST: tous les _emit(name, …) de tui_gateway/server.py
                      #   + tous les *_progress_callback(event_type=…) de agent/ + tools/
  ws-rpc.json         # généré par regex/AST: tous les @method("…") + codes _err(rid, N, …)
  sse-events.json     # généré: _event_payload("…") + _enqueue("…") de api_server.py
  http-routes.json    # généré: la table de routes api_server.py:1490-1520
  contract.json       # { desktop_backend_contract: 4, hermes_version: "0.19.0" }
  coverage.json       # décision Atrium par nom: consumed | ignored-intentional | GAP
```

Le générateur est ~80 lignes de Python et tourne sur un clone de tag : c'est reproductible et
**diffable entre deux versions** — exactement ce que fait déjà `add-gateway-version` pour OpenClaw.
Le détecteur de drift devient : régénérer sur le nouveau tag, diffe contre le vendored précédent,
échouer si un nom apparaît sans décision dans `coverage.json`.

---

## 6. Défauts — inventaire ordonné

### HZ-01 — Aucune conscience de version Hermes sur le transport par défaut (CRITIQUE)

`dispatch.ts:824` : `discoverHermesAgents` retourne **`gatewayVersion: null` en dur** sur le
transport WS, avec le commentaire « `hermes serve` has no /health ».
Conséquence : `resolveCapabilities("hermes", null)` (`compat.ts:284-300`) tombe dans la politique
CONSERVATIVE plancher, `versionBeyondValidated` **ne se déclenche jamais**, et
`supportedRange.maxValidated: "0.18.2"` / `validatedVersions` (`compat.ts:192-195`) sont **du code mort**.
Un gateway 0.19.0, 0.25.0 ou 1.0.0 est indiscernable d'un 0.18.0.

C'est le blocage n°1 pour « support de version SANS régression possible » : il n'y a aujourd'hui
aucun signal, ni banner, ni garde.

**La version EST sur le fil, à deux endroits, et Atrium la jette :**
- `session.info.version` = `hermes_cli.__version__` (`server.py:3849-3851`) — Atrium lit uniquement
  `model`/`provider`/`reasoning_effort` (`ws-turn.ts:521-528`) ;
- `GET /api/status` → `{"version","release_date"}` public sur le même host (`web_server.py:2935`).

### HZ-02 — `desktop_contract` (2→4) totalement ignoré (CRITIQUE)

L'amont **publie son propre numéro de contrat protocolaire** et son client officiel refuse de
piloter un backend en skew. Il est passé de **2 (0.18.2) à 4 (0.19.0)** — donc entre la version
qu'Atrium a validée et l'amont courant. Atrium ne le lit dans aucune des trois réponses où il
arrive (`session.info`, `session.create.info`, `session.resume.info`).

### HZ-03 — `prompt.submit` : le champ `status` de l'ACK est ignoré → tour fantôme (CRITIQUE)

`ws-turn.ts:749-752` : `await opts.client.call("prompt.submit", {...})`, la réponse est **jetée**.
Amont, `_handle_busy_submit` (`server.py:5648-5691`) applique `display.busy_input_mode` :
- `interrupt` (défaut) / `queue` → `_ok(rid, {"status":"queued"})` : le message tourne **plus tard** ;
- `steer` → `_ok(rid, {"status":"steered"})` : **aucun tour séparé ne sera jamais exécuté**, le texte
  est injecté dans le tour vivant.

Atrium ouvre pourtant sa ligne streaming avant l'ACK (`ws-turn.ts:715`) et attend un terminal qui
ne viendra pas → bulle figée jusqu'au watchdog 12 min. La session gateway peut être occupée par un
**autre client** (dashboard, TUI, cron, continuation `/goal`) : l'outbox d'Atrium ne protège pas de ça.
Aggravant : `session.interrupt` **efface `queued_prompt`** (`server.py:9101`) → un Stop pendant
l'attente **détruit silencieusement** le message accepté.

### HZ-04 — Prompts bloquants non gérés : 30 à 300 s de gel muet (HAUTE)

Atrium ne traite que `approval.request` (`ws-turn.ts:356`). Les quatre autres portes de `_block`
(`server.py:2346-2371`) ne sont pas traitées :

| Événement | Timeout amont | Site |
|---|---|---|
| `clarify.request` | **300 s** | `server.py:4366` |
| `secret.request` | **300 s** | `server.py:4467` |
| `sudo.request` | **120 s** | `server.py:4460` |
| `terminal.read.request` | 30 s | `server.py:4371` |

Pendant ce temps aucun delta n'arrive : l'utilisateur voit une bulle vivante gelée, puis le tour
repart avec une réponse vide/dégradée. Le même verrou existe côté REST **en pire** : le handler
`_handle_session_chat_stream` **n'enregistre aucun `register_gateway_notify`** — la seule occurrence
est dans `/v1/runs` (`api_server.py:4978`). Donc sur le transport REST, une approbation d'outil
ne produit **aucune frame du tout** ; elle expire au bout de 60 s par défaut
(`tools/approval.py:2493-2496`, fail-closed) et se répète par outil.

### HZ-05 — `message.complete{status:"interrupted"}` présenté comme réussite (HAUTE)

`server.py:10169-10173` produit trois statuts ; `ws-turn.ts:625` en reconnaît deux.
Un tour interrompu **côté gateway** (autre client, `/goal`, drain de file, préemption compute-host)
livre une réponse tronquée affichée comme complète et définitive. Aucun marqueur, aucune trace.

### HZ-06 — Texte assistant perdu : `message.interim` (HAUTE)

Nouveau en 0.19.0 (`server.py:4386, 10072`). Le commentaire amont est explicite
(`server.py:10112-10116`) : ce sont les commentaires assistants émis **à côté** des appels d'outils,
ou la réponse tentée avant un nudge verify-on-stop, « pour que le desktop puisse les sceller comme
segment propre **au lieu de les perdre** quand `message.complete` remplace le buffer streaming ».
Atrium tombe dans le `default:` (`ws-turn.ts:703`). Sur un tour agentique multi-outils, une partie du
discours de l'agent n'atteint jamais l'utilisateur.

### HZ-07 — Échec d'outil invisible sur les deux transports (MOYENNE)

- SSE : `_tool_progress` (`api_server.py:2567-2569`) mappe `tool.completed` en
  `{message_id, tool_name, preview, args}` et **abandonne `is_error`**, que
  `agent/tool_executor.py:917-921` et `:1625-1629` fournissent pourtant.
  `tool.failed` est prévu dans le `set` mais aucun émetteur amont ne le produit
  (`grep '"tool.failed"' agent/ tools/` → 0) : la lacune Atrium est **latente**, pas active.
- WS : `tool.complete` porte `result`/`summary`/`duration_s`/`inline_diff` (`server.py:4069-4113`) ;
  `ws-turn.ts:507-518` ne garde que `name` + `tool_id`. Une carte d'outil en échec s'affiche « fait ».
- Bonus SSE : `openTools` FIFO (`normalizer.ts:200-224`) ne serait jamais fermée par un `tool.failed`
  → appariement décalé des appels suivants du même nom si l'amont se met à l'émettre.

### HZ-08 — `tool.output_risk` jeté : signal de sécurité perdu (MOYENNE)

Nouveau en 0.19.0. `server.py:4136-4149` émet `{tool_id, name, risk, findings[], redacted}` —
c'est le verdict Tirith sur la sortie d'un outil (risque, motifs détectés, redaction appliquée).
Atrium l'ignore. Sur un produit multi-tenant sous contrainte SOC2, c'est le seul canal où le gateway
dit « j'ai vu quelque chose de risqué dans une sortie d'outil ». **Le payload est déjà sans contenu
conversationnel** (`risk` = niveau, `findings` = libellés de règles, `redacted` = booléen) : il est
directement traçable sans violer la règle « pas de contenu dans les traces ».

### HZ-09 — Récupération mi-tour non exploitée : `inflight` / `queued` / `running` (MOYENNE)

`session.resume` renvoie déjà (`server.py:6676-6693`) :
`running: bool`, `status ∈ {waiting, starting, working, idle}` (`server.py:6564-6574`),
`inflight: {user, assistant, streaming}` (le **texte partiel déjà accumulé**, `server.py:5731-5745`)
et `queued: {user}` (`server.py:5747-5759`).
`ws-turn.ts:141-147` ne lit que `session_id` / `stored_session_id` / `info.cwd`.
Conséquence : une coupure WS pendant un tour (`dispatch.ts:132-140` → `sub("error", …)` → bulle
d'erreur) **détruit une réponse que le gateway a conservée intégralement**. Une reprise « reprendre
le tour en cours » est à portée d'un champ.

### HZ-10 — Fallback `cwd` via `session.status` = code mort → livraisons perdues (MOYENNE)

`ws-turn.ts:567-579` : quand `sessionCwd` est absent, Atrium appelle `session.status` et cherche
`st.info.cwd` puis `st.cwd`. Or `session.status` retourne **`{"output": "<texte rendu>"}` et rien
d'autre** — prouvé en 0.19.0 (`server.py:8736`) **et** en 0.18.2 (même forme). Le fallback n'a
jamais pu fonctionner : le scan du répertoire de livraison est sauté et les fichiers produits par
l'agent sont perdus silencieusement. Le bon appel est `session.resume` (`info.cwd`) ou
`session.active_list`.

### HZ-11 — Signaux de contexte/compaction sous-exploités (MOYENNE)

Le sujet client « erreurs de contexte dépassé » a des données amont non lues :
- `usage.compressions` = nombre de compactions de la session (`server.py:3644`) — jeté ;
- `usage.context_percent` (`server.py:3643`) — jeté (Atrium recalcule) ;
- `usage.active_subagents` (`server.py:3650`) — jeté ;
- `usage.calls` (`server.py:3615`) — jeté ;
- `status.update{kind:"lifecycle"}` non retagué (le retag `compacting` n'a lieu que si le marqueur
  `COMPACTION_STATUS_MARKER` est dans le texte, `server.py:1418-1422`) — les autres lifecycle sont ignorés ;
- côté SSE, `run.completed.usage` **entier** est jeté (`normalizer.ts:275`), donc **aucune** jauge
  de contexte n'existe sur le transport REST.

### HZ-12 — Événements à `session_id` vide non routables (BASSE, à documenter)

`ws-client.ts:207` + `dispatch.ts:125-128` : routage strict par `session_id`. Les émissions à sid
vide (`_voice_emit` `server.py:14748`, `_emit_agent_terminal_close` `server.py:9891`) sont jetées.
Le client officiel gère explicitement le cas « unscoped »
(`apps/desktop/src/lib/gateway-events.ts:20-37`, `resolveGatewayEventSessionId`).
Aujourd'hui aucun événement de tour n'est concerné → **pas de bug actif**, mais c'est une hypothèse
non écrite qu'un futur émetteur amont peut casser silencieusement. À inscrire au contrat.

### HZ-13 — Chemin de sortie silencieux amont (BASSE côté Atrium, à couvrir par watchdog)

`server.py:9494-9498` : si `_turn_cancel_requested` ou `running` est retombé entre l'ACK et le
démarrage, `run_after_agent_ready` **retourne sans émettre aucun événement** — ni `message.complete`,
ni `error`. Le tour n'a pas de terminal sur le fil. Atrium n'a que le watchdog 12 min. C'est un cas
amont, pas un défaut Atrium, mais il doit être **nommé** dans le contrat comme « terminal manquant
possible » et couvert par un délai borné + finalize honnête.

---

## 7. Ce qui est SAIN (à figer par test, pas à corriger)

| Point | Preuve |
|---|---|
| Framing WS : 1 JSON par frame texte, ordre garanti malgré la coalescence 33 ms | `tui_gateway/ws.py:141-155, 233-242` |
| Parser SSE Atrium conforme (CRLF split, `\r` en fin de chunk, commentaires) | `sse.ts:33-45, 66` |
| Surface SSE **inchangée** 0.18.2 → 0.19.0 | diff AST/regex, section 4 |
| Aucun événement WS retiré 0.19.0 (additif seulement) | diff AST, section 4 |
| `subagent.text` volontairement non relayé au parent | `server.py:4224-4231` |
| `approval.request` : commande redactée avant toute sortie | `server.py:1403-1406` + `api_server.py:4946-4952` |
| Erreurs API redactées avant émission | `_redact_api_error_text`, `api_server.py:2605` |

---

## 8. Ordre d'attaque proposé pour la 1.0.0

1. **HZ-01 + HZ-02** — brancher `session.info.version` et `desktop_contract` : sans ça il n'y a
   littéralement aucun garde-fou de version sur Hermes. Débloque le manifeste compat existant.
2. **HZ-03** — lire `status` de l'ACK `prompt.submit` (`queued` → phase honnête + attente bornée ;
   `steered` → refuser le mode ou fusionner la ligne). C'est la cause structurelle des « bulles
   figées » sur Hermes.
3. **HZ-04 + HZ-05** — traiter les 4 prompts bloquants (settle actionnable comme `approval.request`)
   et distinguer `interrupted`.
4. **HZ-06 + HZ-08 + HZ-07** — récupérer le texte interim, le verdict de risque, l'échec d'outil.
5. **HZ-09 + HZ-10** — reprise mi-tour via `session.resume.inflight`, corriger le fallback cwd.
6. **Vendoring §5** — geler la surface 0.19.0 en artefacts générés + `coverage.json`, et brancher le
   détecteur de drift dans la skill `add-gateway-version`.

---

## 9. Questions ouvertes / NON PROUVÉ

- **NON PROUVÉ** : la valeur réelle de `display.busy_input_mode` sur les gateways clients. Le défaut
  amont est `interrupt` (`server.py:5661-5663`) mais je n'ai pas lu `_load_busy_input_mode` ni les
  configs déployées. Lire `hermes_cli/config.py` + `cli-config.yaml.example` pour trancher si
  `steered` est atteignable en production.
- **NON PROUVÉ** : le comportement exact d'Atrium quand `session.create` renvoie l'erreur 4090
  (quota de sessions actives). Le chemin va au `catch` → `rejectAccepted` → 502, mais le message
  utilisateur n'a pas été vérifié.
- **NON PROUVÉ** : si une session créée sans `source` (Atrium envoie `session.create {}`) est
  soumise aux mêmes quotas/réaping qu'une session `desktop`. Lire
  `_resolve_session_source` (`server.py:556`) et `_claim_active_session_slot`.
- **NON PROUVÉ** : `/api/status` est-il joignable sans auth depuis le bridge dans les déploiements
  réels (docstring dit « always-public », `web_server.py:2930-2933`) — à confirmer sur banc live
  avant d'en faire la source de version primaire ; `session.info.version` reste la source sûre.
- **NON PROUVÉ** : comportement du gateway quand DEUX clients Atrium (deux bridges) résument la
  MÊME `stored_session_id`. `_find_live_session_by_key` suggère un sid vivant unique par clé ;
  non testé.
