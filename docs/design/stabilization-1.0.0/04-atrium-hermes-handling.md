# Zone 4 — Ce qu'Atrium fait des trames Hermes (map de traitement)

Audit en LECTURE SEULE. Aucun fichier du repo Atrium modifié.

## 0. Périmètre et sources réellement lues

| Source | Chemin | Version constatée |
|---|---|---|
| Atrium bridge (Hermes) | `<workspace>/atrium/bridge/src/providers/hermes/` | 3 129 lignes (8 fichiers) |
| Tests Hermes | `<workspace>/atrium/bridge/test/hermes-*.test.ts` | 5 fichiers, 47 cas |
| Manifeste capacités | `<workspace>/atrium/bridge/src/compat.ts:112-198` | Hermes maxValidated `0.18.2` |
| Hermes amont | `/tmp/hermes-upstream.okb8T2` | tag `v2026.7.20`, `pyproject.toml:10` → **0.19.0** |

Tags disponibles en amont : `git -C /tmp/hermes-upstream.okb8T2 tag --list` ne retourne **qu'un seul tag**, `v2026.7.20` (= 0.19.0). Il n'y a **pas** de tag 0.18.2 dans ce clone : la comparaison ligne-à-ligne 0.18.2 → 0.19.0 est donc **NON PROUVÉE** ici. Tout ce qui suit décrit le contrat amont **tel qu'il est à 0.19.0**, comparé à ce qu'Atrium consomme. Pour trancher un delta exact il faut `git fetch --tags --depth=... origin` puis `git diff v0.18.2 v2026.7.20 -- tui_gateway/ gateway/platforms/api_server.py`.

Fichiers amont porteurs du contrat :
- WS JSON-RPC (`hermes serve` / `/api/ws`) : `tui_gateway/server.py` (~14 500 l.), `tui_gateway/ws.py`, `hermes_cli/web_server.py:17679`.
- REST + SSE (`API_SERVER_KEY`) : `gateway/platforms/api_server.py`.
- Sous-agents : `tools/delegate_tool.py`.

---

## 1. Les deux chemins, de bout en bout

### 1.1 Chemin REST / SSE (transport `rest`, opt-in — `dispatch.ts:297` défaut `ws`)

```
performHermesSend (dispatch.ts:287)
 └─ transport !== "ws"
 └─ priorSession = isHermesSessionId(openclawChatId) | nonce fresh | registry.knownSession   (dispatch.ts:312-316)
 └─ promptWithFreshSessionHistory (dispatch.ts:53)                       ← rehydratation
 └─ garde reset mid-fetch (dispatch.ts:332)
 └─ runHermesTurn (turn.ts:75)
     ├─ client.ensureSession → POST /api/sessions            (client.ts:161-167)
     ├─ client.openStream → POST /api/sessions/{id}/chat/stream (client.ts:181-235)
     │    └─ 404 + providerChatId ⇒ mint fresh + freshText + retry UNE fois (turn.ts:100-113)
     ├─ onBoundSession fire-and-forget (turn.ts:121-128)
     ├─ sink.beginTurn AVANT resolveAccepted (turn.ts:140-154)
     └─ client.readStream → SseParser (sse.ts:21) → HermesNormalizer.feed (normalizer.ts:231)
          └─ chain sérialisée → TurnSink.apply
```

Contrat amont émis par `_handle_session_chat_stream` (`api_server.py:2512-2648`), enveloppe `{session_id, run_id, seq, ts}` (`api_server.py:2537-2544`) :

| Trame amont | Site d'émission | Atrium |
|---|---|---|
| `run.started` | `api_server.py:2573` | consommée → `run.status:streaming` (`normalizer.ts:349-351`) |
| `message.started` | `api_server.py:2574` | ignorée volontairement (`normalizer.ts:70`) |
| `assistant.delta` `{delta}` | `api_server.py:2562` | consommée (`normalizer.ts:279-284`) |
| `tool.progress` `{tool_name, delta}` | `api_server.py:2566` | consommée, 1 seul `start` par nom, `_thinking` filtré (`normalizer.ts:285-306`) |
| `tool.started` | `api_server.py:2568-2569` | consommée (`normalizer.ts:307-333`) |
| `tool.completed` | `api_server.py:2568-2569` | consommée (`normalizer.ts:334-348`) |
| **`tool.failed`** | `api_server.py:2568` (jeu `{tool.started, tool.completed, tool.failed}`) | **IGNORÉE** — non listée dans `HERMES_EVENT_NAMES` (`normalizer.ts:66-87`) |
| `assistant.completed` `{content, completed, partial, interrupted, session_id}` | `api_server.py:2588-2595` | **partiellement** : seul `content` lu (`normalizer.ts:257-268`). `session_id`, `partial`, `interrupted` **perdus** |
| `run.completed` `{messages, usage, session_id}` | `api_server.py:2596-2602` | **partiellement** : seul `messages[].content` lu (`normalizer.ts:269-273`). `usage` et `session_id` **perdus** |
| `error` `{message}` | `api_server.py:2604` | consommée (`normalizer.ts:248-256`) |
| `done` | `api_server.py:2606` | consommée → finalize complete (`normalizer.ts:274-278`) |
| commentaire keepalive `: keepalive` (30 s) | `api_server.py:2632`, constante `api_server.py:125` | ignorée correctement (`sse.ts:69`) |

### 1.2 Chemin WS JSON-RPC (transport `ws`, défaut)

```
performHermesWsSend (dispatch.ts:381)
 └─ prior = isHermesWsStoredSessionId(...) | nonce fresh | registry (dispatch.ts:393-400)
 └─ promptWithFreshSessionHistory + garde reset (dispatch.ts:405-414)
 └─ runHermesWsTurn (ws-turn.ts:104)
     ├─ session.resume (stored) sinon session.create      (ws-turn.ts:140-158)
     │    └─ échec ⇒ session.create + recoverText UNE fois (ws-turn.ts:159-178)
     ├─ registerSession(runtimeSid, onEvent)               (ws-turn.ts:709 → dispatch.ts:157-169)
     ├─ sink.beginTurn(runtimeSid)                          (ws-turn.ts:715)
     ├─ image.attach_bytes / file.attach                    (ws-turn.ts:729-745)
     ├─ prompt.submit  ← POINT D'ACCEPTATION                (ws-turn.ts:749-752)
     ├─ pendingBind → bindProviderChat                      (ws-turn.ts:783-790)
     └─ await turnDone (aucune borne temporelle)            (ws-turn.ts:795)
```

Enveloppe amont : `{"jsonrpc":"2.0","method":"event","params":{"type":…,"session_id":…,"payload":…}}` (`tui_gateway/server.py:1207-1211`). Coalescence des tokens (`message.delta`/`reasoning.delta`/`thinking.delta`) à ~33 ms, **ordre préservé**, frames envoyées individuellement (`tui_gateway/ws.py:53-57`, `:233-243`) — pas de forme « batch » à gérer côté Atrium. **Aucun ping/pong applicatif** ni côté serveur (`hermes_cli/web_server.py:17679-17696`, `tui_gateway/ws.py`) ni côté Atrium (`ws-client.ts:141-186`).

---

## 2. Classement exhaustif des trames WS

Légende : **C** consommée · **IV** ignorée volontairement · **P** perdue (signal utile jeté) · **MI** mal interprétée.

| Type amont | Émission amont | Statut | Traitement Atrium / conséquence |
|---|---|---|---|
| `gateway.ready` | `ws.py:318-327` | C | déblocage `connect()` (`ws-client.ts:188-192`). Émis **sans** `session_id` → routé vers un abonné `""` inexistant, sans effet. |
| `message.start` | `server.py:9770, 9838, 9928, 10416, 10462` | IV | `default:` (`ws-turn.ts:703-707`) |
| `message.delta` `{text, rendered?}` | `server.py:10063` | C | `EVENT_MESSAGE_DELTA` (`ws-turn.ts:309-315`) |
| `thinking.delta` / `reasoning.delta` | `server.py:4337, 4340` | C | heartbeat + pilule 1×/60 s (`ws-turn.ts:316-338`) |
| **`message.interim`** `{text, already_streamed}` | `server.py:4386-4392`, `server.py:10072-10075` | **P** | `default:` → jeté. Voir §4 H-02. |
| `status.update` `{kind}` | `server.py` (3 sites `_emit("status.update")`) | C **partiel** | seul `kind=="compacting"` mappé (`ws-turn.ts:339-355`); autres `kind` jetés (IV assumé) |
| `session.info` `{model, provider, reasoning_effort, cwd, **stored_session_id**, running, title…}` | 17 sites, payload `server.py:3776-3830` | **P** | seuls model/provider/reasoning_effort lus (`ws-turn.ts:521-542`). **`stored_session_id` ignoré** → voir H-03 |
| `approval.request` | `server.py:1388-1395` (`_emit_approval_request`) | **MI** | Atrium *tue* le tour avec une erreur (`ws-turn.ts:356-371`) sans envoyer `approval.respond` ni `session.interrupt` → voir H-04 |
| **`clarify.request`** (bloquant 300 s) | `server.py:4366-4368` via `_block` (`server.py:2346`) | **P** | non géré → tour figé 5 min puis réponse vide côté agent |
| **`secret.request`** (bloquant 300 s) | `server.py:4467` | **P** | idem |
| **`sudo.request`** (bloquant 120 s) | `server.py:4460` | **P** | idem |
| **`terminal.read.request`** (bloquant 30 s) | `server.py:4371-4376` | **P** | idem |
| `subagent.start/thinking/tool/progress/complete` | relais `server.py:4170-4231`, émetteurs `tools/delegate_tool.py:919, 923, 957, 1010, 1014` | C **partiel** | `upsertSubAgent` (`ws-turn.ts:372-429`). Rollups `input_tokens/output_tokens/reasoning_tokens/api_calls/files_read/files_written/duration_seconds/cost_usd` (`delegate_tool.py:2291-2316`) **jetés** |
| `subagent.text` | **non émis sur le parent** (`server.py:4230`) | — | branche absente : correct |
| `moa.reference` / `moa.aggregating` | `server.py:4165, 4168` | C | cartes sous-agent (`ws-turn.ts:430-489`) |
| `tool.start` / `tool.generating` / `tool.complete` | `server.py:4128`, `_agent_cbs` | C | ids natifs `tool_id` (`ws-turn.ts:490-520`) |
| **`tool.output_risk`** | `server.py:4133-4144` | **P** | `default:` → un signal de risque de sortie d'outil n'est jamais remonté |
| `reasoning.available` | `server.py:4146-4150` | IV | `default:` |
| `session.title` | `server.py:10324-10326` | IV | `default:` — Atrium titre lui-même |
| `notification.*`, `reaction`, `skin.changed`, `voice.*`, `browser.progress`, `preview.*`, `pet.*`, `terminal.close` | divers | IV | `default:` — hors périmètre Atrium |
| `message.complete` `{text, usage, status, reasoning?, **warning?**, response_previewed?}` | `server.py:10197-10209`; erreur compute-host `server.py:1335` | C **partiel + MI** | `ws-turn.ts:543-665`. `status:"interrupted"` → mappé **complete** (`ws-turn.ts:625`). `warning` **jeté** (H-05). `usage.context_used/context_max` correctement mappés (`ws-turn.ts:608-624` vs `server.py:3641-3642`) |
| `error` `{message}` | `server.py:1706, 5717, 10369, 9481-9489` | C | `ws-turn.ts:666-702` |

### Contrat de retour RPC (réponses, pas événements)

| RPC | Retour amont | Atrium |
|---|---|---|
| `prompt.submit` (normal) | `{"status":"streaming"}` `server.py:9506` | **jamais lu** (`ws-turn.ts:749-752`) |
| `prompt.submit` (session occupée, mode `interrupt` par défaut) | **`{"status":"queued"}`** `server.py:5691` | **jamais lu** → H-01 |
| `prompt.submit` (mode `steer`) | **`{"status":"steered"}`** `server.py:5677` | **jamais lu** → H-01 |
| `session.resume` | `{session_id, stored_session_id (= tip résolu), info{cwd,…}}`, résolution de continuation `server.py:6213-6217` | `stored_session_id` lu mais **jamais re-lié** (`ws-turn.ts:146` vs `pendingBind` seulement branche create `ws-turn.ts:156`) |
| `session.interrupt` | `{"status":"interrupted"}` `server.py:9085, 9125` | ignoré (`dispatch.ts:472-479`, best-effort) |
| `cron.manage` | liste/objet libre | mapping défensif `dispatch.ts:598-635` |

---

## 3. Robustesse comparée OpenClaw ↔ Hermes

| Garde OpenClaw | Preuve | Équivalent Hermes | Symptôme utilisateur si absent |
|---|---|---|---|
| Deadlines absolues, `BASE_RECV_TIMEOUT = 240 s` | `openclaw/normalizer.ts:80` | **AUCUN** : SSE = corps non borné (`client.ts:218-223` « the BODY stream is deliberately unbounded ») ; WS = `await turnDone` sans timer (`ws-turn.ts:795`) | Bulle qui tourne jusqu'au watchdog Convex 12 min (`convex/stuckStreams.ts:120`), ou **indéfiniment** si des `thinking.delta` entretiennent le heartbeat (`ws-turn.ts:327-334`) |
| Budget élargi pendant compaction `COMPACTION_RECV_TIMEOUT = 900 s` + code `compaction_timeout` | `openclaw/normalizer.ts:81-88` | aucun | une compaction Hermes qui coince n'a aucun code d'erreur dédié |
| `empty_final` / `lifecycle_end` / `private_ack` deadlines | `openclaw/normalizer.ts:670-678` | aucun | tour accepté sans aucune trame = attente muette |
| Sentinelle NO_REPLY / `sentinelOnly` | `core/turn-sink.ts:1340-1352` | aucun | — (Hermes n'a pas la sentinelle) |
| Classification transitoire + auto-retry `provider_internal` | `hermes/normalizer.ts:39-64` | **présent** (partagé) | OK, **mais** alimenté avec la mauvaise chaîne (voir H-06) |
| Détecteur de dérive protocole (champs inconnus comptés, observe-only) | `openclaw/protocol-drift.ts` (221 l.) + `bridge/protocol/openclaw/2026.6.11/` + `coverage.json` | **AUCUN** — `ls bridge/protocol/` ne contient que `openclaw` ; `grep -rn hermes protocol-drift.ts` = 0 résultat | une montée de version Hermes ajoute/renomme des trames sans aucun signal ; le manifeste reste figé à `0.18.2` alors que l'amont est à `0.19.0` |
| Flush des outils restés ouverts au terminal | `ws-turn.ts:227-242` (**WS seulement**) | **absent côté SSE** : `HermesNormalizer.finalize` (`normalizer.ts:375-411`) n'émet que `message.final`+`run.status` | carte d'outil en spinner éternel après la fin du tour (REST) |
| Récupération d'historique / `history-recovery.ts` | `openclaw/history-recovery.ts` | aucun | — |
| Keepalive / détection de socket morte | multiplex OpenClaw | **aucun ping applicatif** (`ws-client.ts`) et aucun côté serveur | TCP half-open ⇒ le tour n'a **jamais** de terminal, `done` ne résout jamais, l'abonné et l'entrée `wsTurns` fuient (voir H-07) |
| Réponse aux prompts bloquants du gateway | n/a OpenClaw | **aucune** (`grep approval.respond bridge/src/` = 0) | tours figés 30 s → 5 min sans explication |

---

## 4. Défauts identifiés (numérotés, avec preuve)

### H-01 · L'ACK `prompt.submit` n'est jamais lu → réponse livrée au mauvais message
- Amont : `tui_gateway/server.py:9506` (`streaming`), `:5691` (`queued`), `:5677` (`steered`), politique par défaut `interrupt` (`server.py:5661-5663`).
- Atrium : `ws-turn.ts:749-752` — `await client.call("prompt.submit", …)` sans inspecter `r.status`.
- Aggravé par : `dispatch.ts:157-169` — `subscribeWsSession` fait `this.wsSubscribers.set(k, onEvent)` **sans vérifier** qu'une entrée existe déjà. Deux tours sur le même `runtimeSessionId` ⇒ le second **écrase silencieusement** la voie du premier.
- Chaîne réelle : Stop → renvoi immédiat (outil non interruptible encore actif) → `prompt.submit` retourne `queued` → Atrium ouvre une ligne streaming et attend → le `message.complete` du **tour précédent** arrive sur la voie volée → `finalized = true` (`ws-turn.ts:544`) → le vrai `message.complete` du nouveau prompt est **jeté** par la garde `ws-turn.ts:307`.
- Symptôme : « le bot répond à côté », « trames dans le désordre », « conflit de trames ». Le premier tour reste en streaming jusqu'au watchdog.

### H-02 · `message.interim` jeté : le texte streamé disparaît au finalize
- Amont : `server.py:10063-10075` — commentaire explicite du gateway : les segments intermédiaires sont émis « so the desktop can seal it as its own segment **instead of losing it when message.complete replaces the streaming buffer** ».
- Amont : `message.complete.text = result["final_response"]` (`server.py:10169-10197`) = **uniquement** la dernière réponse, pas la commentaire inter-outils.
- Atrium : `message.interim` tombe dans `default:` (`ws-turn.ts:703-707`) ; `message.complete` fait `finalEv.text = str(payload.text) || replyText` (`ws-turn.ts:601, 626`) et `TurnSink` écrit ce texte tel quel (`core/turn-sink.ts:899-901`, `:1331-1335`).
- Symptôme : l'utilisateur voit du texte s'écrire pendant le tour puis **disparaître** à la fin. Symptôme historiquement rapporté comme « la réponse a été tronquée / réécrite ».

### H-03 · Rotation de session après compaction : contexte perdu (REST) / non re-lié (WS)
- **REST** : le gateway rotationne `session_id` quand l'auto-compression se déclenche et **expose** l'id effectif dans `assistant.completed.session_id` et `run.completed.session_id` (`api_server.py:2588, 2592, 2597`). Atrium n'apprend **que** `run_id` (`normalizer.ts:243-244`) — `session_id` n'est lu nulle part.
  Et surtout : le chargement d'historique du tour suivant **ne résout PAS** la chaîne de continuation (`api_server.py:2223-2231` : `db.get_messages_as_conversation(session_id)` brut), alors que `/api/sessions/{id}/messages`, lui, la résout (`api_server.py:2414`).
  ⇒ après la première compaction, **tous** les tours suivants repartent du transcript pré-compaction. Symptôme exact : « erreur de contexte dépassé », « il a oublié ce qu'on vient de dire ».
- **WS** : `session.resume` résout le tip (`server.py:6213-6217`), donc la continuité tient — mais Atrium ne re-lie **jamais** l'id retourné (`pendingBind` n'est posé que sur la branche `session.create`, `ws-turn.ts:156`) et ignore `stored_session_id` porté par `session.info` (`server.py:3827` vs `ws-turn.ts:521-542`). La continuité dépend donc d'une chaîne DB non contractualisée, non testée, et qui casse dès qu'un maillon est purgé.

### H-04 · `approval.request` : Atrium ment au client et perd la vraie réponse
- Atrium (`ws-turn.ts:356-371`) : `finalized = true`, écrit une carte d'erreur, `settle()`. **Aucun** `approval.respond`, **aucun** `session.interrupt`.
- Amont : l'approbation expire fail-closed à **60 s** par défaut (`tools/approval.py:2493-2496`), l'outil reçoit un refus, le tour **continue** et produit un vrai `message.complete`.
- Ce `message.complete` est jeté par la garde `ws-turn.ts:307`. Le transcript côté Hermes contient donc une réponse assistant que le fil Atrium n'a jamais montrée ⇒ divergence du contexte au tour suivant.
- De plus la session reste `running` ~60 s : le message suivant de l'utilisateur tombe dans H-01.

### H-05 · `message.complete.warning` jeté : perte de persistance silencieuse
- Amont : `server.py:10197-10201` — `payload["warning"] = status_note` où `status_note` = « History changed during this turn — the response above is visible **but was not saved to session history** » (`server.py:10145-10148`).
- Atrium : `ws-turn.ts:543-665` ne lit jamais `payload.warning`.
- Symptôme : la réponse s'affiche, mais l'agent ne la reverra jamais. Au tour suivant il se contredit, sans que rien ne l'ait annoncé.

### H-06 · Classifieur transitoire alimenté avec la mauvaise chaîne
- Amont, deux chemins mettent le détail d'erreur **dans le TEXTE**, pas dans un champ d'erreur :
  - `server.py:10169-10175` : `raw = f"Error: {result['error']}"` quand la réponse est vide + erreur réelle, `status="error"`, aucun champ `error`.
  - `server.py:1335` : `{"text": f"Error: {message}", "status": "error"}` (échec compute-host).
- Atrium : `ws-turn.ts:636-641` cherche `payload.error|message|detail|summary` → tombe sur le fallback `"Hermes run failed."` ; la promotion de prose (`isHermesRuntimeFailureText`, `normalizer.ts:51-57`) n'accepte QUE `^api call failed after N retries:` ou `^streaming failed before delivery:` → **`Error: …` n'est pas promu**.
- Conséquence : `classifyProviderInternal("Hermes run failed.")` = `null` ⇒ **pas d'`errorKind`** ⇒ l'auto-retry borné zéro-contenu de Convex ne se déclenche jamais sur une panne amont pourtant transitoire (503/overloaded). Et l'utilisateur lit « Hermes run failed. » avec le vrai détail rendu comme *contenu* de la réponse.

### H-07 · Ni deadline ni keepalive : tour zombie + fuite d'abonné
- Aucune borne : `client.ts:218-223` (SSE corps illimité), `ws-turn.ts:795` (`await turnDone` nu), `ws-client.ts:141-186` (aucun ping).
- Amont : `run_after_agent_ready` peut sortir **sans aucun événement** si un interrupt atterrit entre l'ACK et la construction de l'agent (`server.py:9504-9508` : `return` sec, ni `message.complete` ni `error`).
- Conséquence Atrium : `turnDone` ne résout jamais ⇒ le `finally` de `ws-turn.ts:796-806` ne s'exécute jamais ⇒ l'abonné `wsSubscribers` et l'entrée `wsTurns` **fuient définitivement** ; `run.done` ne résout pas ⇒ `deleteWsTurnIf` (`dispatch.ts:449`) ne tourne jamais.
- Même effet sur un TCP half-open (pas de `close` ⇒ pas d'`onClose` ⇒ pas d'erreur synthétique).
- Symptôme : bulle figée 12 min minimum, puis watchdog ; process bridge qui accumule des abonnés morts.

### H-08 · `abort` déclaré mais **inopérant** sur le transport REST (manifeste menteur)
- Manifeste : `compat.ts:121-124` — `HERMES_CAPABILITIES = { abort: "0.18.0" // run_stop: POST /v1/runs/{id}/stop }`.
- Atrium appelle bien `POST /v1/runs/{runId}/stop` (`client.ts:170-172`, `dispatch.ts:524-529`).
- Amont : `_handle_stop_run` cherche `self._active_run_agents[run_id]` et renvoie **404 `run_not_found`** sinon (`api_server.py:5285-5289`). Or `_active_run_agents[run_id]` n'est écrit **qu'en un seul endroit** : `api_server.py:4926`, dans `_handle_runs` (`POST /v1/runs`). Le `run_id` du flux SSE est minté localement (`api_server.py:2534`) et **jamais enregistré**.
- Et l'annulation par déconnexion ne fonctionne pas non plus : `run_conversation` tourne dans un **thread executor** (`api_server.py:4637`, `loop.run_in_executor`), et le seul moyen documenté de l'arrêter est `agent_ref[0].interrupt()` (`api_server.py:4646-4649`) — or `_handle_session_chat_stream` appelle `_run_agent` **sans** `agent_ref` (`api_server.py:2578-2586`).
- ⇒ Sur REST, le bouton Stop coupe la vue locale et **rien d'autre** : le gateway finit le tour, facture, et **persiste une réponse assistant que l'utilisateur n'a jamais vue** dans la session serveur. Divergence de contexte garantie.
- `dispatch.ts:526-529` avale le 404 en silence (« best-effort »).

### H-09 · SSE : aucun usage, aucun modèle, aucune pression contexte
- Amont : `run.completed.usage = {input_tokens, output_tokens, total_tokens}` (`api_server.py:4685-4689`, poussé `api_server.py:2601`).
- Atrium : `normalizer.ts:269-273` jette `usage` ; `grep -n "reportSessionMeta" turn.ts normalizer.ts client.ts sse.ts` ⇒ **0 résultat**.
- Symptôme : sur un chat Hermes REST, jauge d'usage et « % restant » vides, aucun `model`/`provider` affiché. Le WS, lui, alimente les deux (`ws-turn.ts:521-542`, `:608-624`).

### H-10 · SSE : outils ouverts jamais refermés au terminal
- `HermesNormalizer.finalize` (`normalizer.ts:375-411`) n'émet que la paire finale ; la FIFO `openTools` (`normalizer.ts:197-216`) n'est jamais vidée.
- Le chemin WS a explicitement corrigé ce défaut (`ws-turn.ts:227-242`, `closeOpenTools()` appelé sur **tous** les terminaux : `:274`, `:357`, `:558`, `:668`).
- Déclencheurs : trame `error` en plein outil, `tool.failed` (non mappée, `normalizer.ts:66-87` vs `api_server.py:2568`), EOF propre après `tool.started`.
- Symptôme : carte d'outil en spinner permanent sous un message terminé.

### H-11 · `status:"interrupted"` lu comme `complete`
- Amont : `server.py:10171-10175` — `status = "interrupted" if result.get("interrupted") else "error" if … else "complete"`.
- Atrium : `ws-turn.ts:625` — `const status = str(payload.status) === "error" ? "error" : "complete";`
- Sur un Stop **initié par Atrium**, la garde `finalized` masque le problème. Mais un interrupt venu d'ailleurs (dashboard Hermes, TUI, `/stop`, un `prompt.submit` concurrent en mode `interrupt` — cf. H-01) produit une réponse **tronquée présentée comme complète**, sans le moindre marqueur.

### H-12 · Réponses volumineuses : `MEDIA:` inliné en data-URL sur REST
- Amont : `_resolve_media_to_data_urls` (`api_server.py:619-659`) remplace chaque `MEDIA:<chemin>` par `![image](data:…;base64,…)` **jusqu'à 5 Mo par image** (`api_server.py:616`), appliqué au texte de `assistant.completed` et `run.completed` (`api_server.py:2587`).
- Atrium REST n'a aucun plafond sur ce texte : il part tel quel en `EVENT_MESSAGE_SNAPSHOT` (`normalizer.ts:257-268`) puis en `message.final`.
- Symptôme attendu : écriture Convex rejetée (limite de document) ⇒ tour perdu, ou UI qui s'écroule. **NON PROUVÉ en live** : à vérifier par un tour REST demandant une image (voir §6).

### H-13 · Prompts bloquants non gérés (`clarify` / `secret` / `sudo` / `terminal.read`)
- Amont : `_block(event, sid, payload, timeout=300)` (`server.py:2346-2358`), utilisé par `clarify.request` (`:4366`), `terminal.read.request` (`:4371`, timeout 30 s), `sudo.request` (`:4460`, 120 s), `secret.request` (`:4467`).
- Atrium : aucun `case` — tout tombe dans `default:` (`ws-turn.ts:703-707`). `grep -rn "clarify.respond\|secret.respond\|sudo.respond" bridge/src/` ⇒ 0.
- Symptôme : le tour se fige 30 s à 5 min sans le moindre indice, puis l'agent reçoit une réponse vide et produit un résultat incohérent. C'est exactement la classe de défaut qu'`approval.request` avait révélée en live — les quatre autres n'ont jamais été traitées.

### H-14 · Manifeste incohérent avec l'implémentation (sous-déclaration + doc périmée)
- `agentFiles` déclaré **WS seulement** (`compat.ts:144`) alors que `performHermesAgentFilesOp` passe par `HermesFilesFetcher` HTTP (`dispatch.ts:698-701`, `files-fetcher.ts:111-169`) — donc fonctionnel aussi en REST.
- Livraison de fichiers sortants implémentée sur WS (`ws-turn.ts:563-600`, dossier `atrium-out`) mais **`mediaOutbound` n'est déclaré nulle part** pour Hermes (`compat.ts:130-145`).
- `COMPAT_MANIFEST.providers.hermes.capabilities = HERMES_CAPABILITIES` (`compat.ts:195`) = le jeu **REST** : le manifeste statique publié sous-déclare le WS (la surcharge n'existe qu'au runtime, `server.ts:1710-1723`).
- `maxValidated: "0.18.2"` (`compat.ts:193`) contre un amont à **0.19.0** ⇒ toute instance à jour est `versionBeyondValidated`.
- `docs/design/protocol-schema-coverage.md:299-311` décrit encore Hermes comme « structural placeholder with zero capabilities », et `docs/design/protocol-contract.md:108-110` promet `"schema": "none-published"`. Aucun schéma Hermes vendored : `ls bridge/protocol/` ⇒ `openclaw` seul.

### H-15 · Rollups de sous-agent jetés
- Amont : `subagent.complete` porte `input_tokens/output_tokens/reasoning_tokens/api_calls/files_read/files_written/output_tail/duration_seconds/cost_usd` (`server.py:4192-4218`, `delegate_tool.py:2291-2316`).
- Atrium : `ws-turn.ts:405-413` ne lit que `status`, `summary`/`text`.
- Statuts amont réels : `completed` / `failed` / `interrupted` / `timeout` / `error` (`delegate_tool.py:2134-2141`, `:2070`, `:2334`). Atrium écrase tout en `done`/`error` (`ws-turn.ts:406-407`) — `interrupted` et `timeout` deviennent indistinguables d'un échec.

---

## 5. Ce que les tests couvrent réellement (et ce qu'ils ne couvrent pas)

### Couvert (47 cas)

| Fichier | Ce qui est vraiment vérifié |
|---|---|
| `hermes-normalizer.test.ts` (24) | parsing SSE (frontières de chunk, `\r\n` scindé, multi-`data:`), rejeu de 2 captures live (erreur no-model, PONG), bruit `_thinking`, ids d'outils FIFO + concurrents, forward-compat d'une trame inconnue, idempotence post-terminal, classification transitoire (marqueurs + exclusions), promotion de prose d'échec |
| `hermes-ws-turn.test.ts` (13) | rejeu de captures live (PONG, TOOLS, DELEGATION, MoA), `status.update kind=compacting`, resume échoué → fresh + historique, pas de bind si `prompt.submit` échoue, heartbeat de reasoning, terminal d'enfant tardif, **flush d'un outil resté ouvert**, prose d'échec via deltas + `error` nu |
| `hermes-turn.test.ts` (6) | 404 → recovery + historique, bind post-acceptation, rejet pré-stream sans message orphelin, échec `beginTurn` → 502 |
| `hermes-dispatch.test.ts` (8) | formes d'ids de session, garde d'identité du registre, nonces de rotation, CAS des fichiers d'agent |
| `hermes-rehydration.test.ts` (7) | matrice fresh/warm/knob/attachments/échec/vide/sans `messageId` |

Qualité : bonne — chaque test échouerait si la cible régressait, et 4 des 5 fichiers rejouent des **captures live** (`test/fixtures/hermes/`).

### NON couvert — scénarios de défaillance sans un seul test

1. **ACK `queued` / `steered`** de `prompt.submit` (H-01). Aucun test n'injecte autre chose que le chemin nominal.
2. **Deux tours sur le même `runtimeSessionId`** → vol d'abonné (`dispatch.ts:157-169`). Aucun test de collision.
3. **`message.interim`** (H-02) : le mot n'apparaît nulle part dans le repo.
4. **Rotation de session post-compaction** (H-03), ni REST ni WS.
5. **`message.complete.warning`** (H-05).
6. **`status:"interrupted"`** (H-11).
7. **Prompts bloquants** `clarify`/`secret`/`sudo`/`terminal.read` (H-13). Seul `approval.request` est… lui-même non testé (aucun cas dans `hermes-ws-turn.test.ts`).
8. **Tour sans aucun événement terminal** (H-07) : ni deadline, ni test de fuite d'abonné/`wsTurns`.
9. **Socket half-open** (pas de `close`), pas de test.
10. **`tool.failed`** et **outils non refermés côté SSE** (H-10) : le WS a son test (`hermes-ws-turn.test.ts:495`), le SSE **n'a pas l'équivalent**.
11. **`usage` sur SSE** (H-09).
12. **404 de `/v1/runs/{id}/stop`** (H-08) : aucun test n'assert que le stop serveur a effectivement pris.
13. **Texte de réponse énorme** (H-12).
14. **Aucun test de dérive protocole Hermes** — pas d'analogue à `protocol-drift.test.ts` / `protocol-coverage.test.ts`.

---

## 6. Vérification du manifeste `HERMES_WS_CAPABILITIES` (audit ligne à ligne)

| Capacité déclarée | Implémentée ? | Testée ? | Verdict |
|---|---|---|---|
| `abort` (`compat.ts:122`) | **WS oui** (`session.interrupt`, `dispatch.ts:457-486`). **REST NON opérant** (404 garanti, cf. H-08) | non | **MENTEUR sur REST** |
| `agentsDiscovery` (`compat.ts:123`) | oui, 2 chemins (`dispatch.ts:790-846`) | `agents-discovery.test.ts` (générique, pas Hermes) | OK, test faible |
| `inboundAttachments` (`compat.ts:132`) | oui (`ws-turn.ts:729-745`) | **non** — aucun cas ne stage une pièce jointe | déclaré, non testé |
| `cronList` (`compat.ts:134`) | oui (`dispatch.ts:562-636`) | `cron-part.test.ts` ne couvre pas le mapping Hermes | déclaré, non testé |
| `cronManage` (`compat.ts:137`) | **partiel assumé** : `remove` + `pause/resume` seulement, tout le reste → `unsupported` (`dispatch.ts:642-680`) | non | honnête (dégradation explicite), non testé |
| `subagents` (`compat.ts:141`) | oui (`ws-turn.ts:372-429`) | oui (`hermes-ws-turn.test.ts:306`) | OK, mais rollups perdus (H-15) |
| `agentFiles` (`compat.ts:144`) | oui, **et aussi sur REST** (HTTP, pas WS) | oui (`hermes-dispatch.test.ts:84-110`) | **sous-déclaré** |
| *(non déclaré)* `mediaOutbound` | **implémenté** sur WS (`ws-turn.ts:563-600`) | non | **sous-déclaré** |

Trois anomalies de manifeste : un mensonge (`abort`/REST), deux omissions (`agentFiles`/REST, `mediaOutbound`/WS), plus la sous-déclaration du manifeste statique (`compat.ts:195`).

---

## 7. Correctifs proposés (design, ordre d'impact)

1. **Lire l'ACK `prompt.submit`.** `status !== "streaming"` ⇒ ne pas ouvrir de tour : pour `queued`, attendre l'idle réel (poll `session.status`) puis re-soumettre, ou refuser proprement ; pour `steered`, fusionner dans le tour vivant. **Et** faire échouer `subscribeWsSession` si une voie existe déjà pour la même clé (`dispatch.ts:157`), au lieu d'écraser.
2. **Deadlines Hermes**, symétriques à OpenClaw : budget de silence (~240 s), budget élargi sur `status.update kind=compacting` (~900 s), budget « accepté mais muet ». Codes stables `hermes_recv_timeout`, `hermes_compaction_timeout`. Chaque expiration finalise une erreur honnête + libère abonné et registre.
3. **Ping applicatif WS** (30 s) + détection d'absence de pong ⇒ `onClose` synthétique. Supprime la classe « tour zombie ».
4. **Apprendre l'id de session effectif** : REST ⇒ lire `session_id` de `assistant.completed`/`run.completed` et re-lier via `bindProviderChat` ; WS ⇒ re-lier `stored_session_id` de `session.resume` et de `session.info` quand il diffère.
5. **Prompts bloquants** : répondre systématiquement et rapidement (`clarify.respond`/`secret.respond`/`sudo.respond`/`terminal.read.respond` avec un refus explicite), et surfacer un marqueur in-thread « l'agent a demandé X, ce chat ne peut pas répondre ». Idem `approval.respond {deny}` avant de settler — pour ne plus perdre la vraie réponse (H-04).
6. **Consommer `message.interim`** (`already_streamed=false` ⇒ segment supplémentaire ; `true` ⇒ ancrer le segment pour qu'il survive au remplacement par `message.complete`).
7. **Élargir la promotion de prose** au format `^Error:\s` et faire passer `classifyProviderInternal` sur le **texte** quand aucun champ d'erreur n'est fourni (H-06).
8. **Flush des outils ouverts dans `HermesNormalizer.finalize`** + ajouter `tool.failed` à `HERMES_EVENT_NAMES` (phase `completed`, marqueur d'échec).
9. **`usage` sur SSE** : mapper `run.completed.usage` vers `reportSessionMeta` (input/output/total ; pas de fenêtre disponible ⇒ ne pas fabriquer de `contextTokens`).
10. **`warning` de `message.complete`** : surfacer comme anomalie in-thread (« réponse non persistée côté gateway »).
11. **`status:"interrupted"`** ⇒ `run.status:"aborted"`, pas `complete`.
12. **Vendorer un contrat Hermes** : `bridge/protocol/hermes/0.19.0/` (jeu de noms d'événements + champs par événement, extrait des sites d'émission), `coverage.json`, et un `protocol-drift` Hermes observe-only comptant les **noms de champs** inconnus (SOC2 : aucun contenu). Puis corriger `compat.ts` (`maxValidated`, `mediaOutbound`, `agentFiles` sur REST, `abort` retiré ou marqué dégradé sur REST) et les deux docs de design.
13. **REST** : soit implémenter un vrai stop (nécessite un changement amont : enregistrer le `run_id` du flux, ou passer `agent_ref`), soit **retirer `abort` du jeu REST** et griser le bouton Stop côté UI (règle mémoire « pas de conseil de contournement, on rend impossible ce qui est dangereux »).

---

## 8. Questions ouvertes / à trancher en amont

- Le clone `/tmp/hermes-upstream.okb8T2` ne porte **qu'un** tag (`v2026.7.20`). Le delta réel 0.18.2 → 0.19.0 (donc les trames *nouvelles* vs *préexistantes*) reste **NON PROUVÉ**.
- H-12 (data-URL 5 Mo dans le texte REST) n'est prouvé que côté amont ; l'effet exact côté Convex n'a pas été exercé.
- Le transport REST est-il encore utilisé en production, ou peut-il être retiré ? Six des quinze défauts ci-dessus lui sont propres.
