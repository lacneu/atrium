# Zone 1 — Inventaire d'émission OpenClaw v2026.7.1 (source de vérité amont)

Inventaire exhaustif de ce que le gateway OpenClaw **v2026.7.1** peut envoyer sur
son WebSocket vers un client comme Atrium, et confrontation avec (a) le contrat
TypeBox, (b) les sites d'émission réels, (c) les tests amont, (d) le schéma
*vendored* d'Atrium `2026.6.11`, (e) ce que le bridge Atrium consomme.

**Sources.**
- Amont : `<scratch>/upstream/openclaw` @ tag `v2026.7.1`
  (HEAD `2d2ddc43`). Noté `$UP/` ci-dessous.
  Seul tag présent dans le clone (`git tag --list` → `v2026.7.1`) : la
  comparaison 6.11→7.1 se fait donc contre les fichiers *vendored* d'Atrium,
  qui sont l'artefact ratcheté de toute façon.
- Atrium : `<workspace>/atrium`. Noté `$AT/`.
- Version de protocole négociée : `PROTOCOL_VERSION = 4`,
  `MIN_CLIENT_PROTOCOL_VERSION = 4` (`$UP/packages/gateway-protocol/src/version.ts:2-4`).

**Contrainte SOC2 respectée** : ce rapport ne cite que des *noms de champs*, des
codes stables, des littéraux d'énumération et des compteurs. Aucun contenu
conversationnel.

---

## 0. Fait structurant : le contrat n'est PAS appliqué à l'émission

Le paquet `packages/gateway-protocol` est un artefact de **documentation +
codegen**, pas un validateur d'émission.

| Preuve | Détail |
|---|---|
| `grep "from \"typebox\"" $UP/src/gateway/**` | **aucun** import typebox dans `src/gateway/` |
| `grep "Value.Check\|TypeCompiler\|ProtocolSchemas" $UP/src/gateway/` | **zéro occurrence** |
| `grep -rn "AgentEventSchema\|ChatDeltaEventSchema" $UP/src/` | **zéro occurrence hors du paquet** |
| Garde réellement appliquée | `$UP/packages/gateway-protocol/src/frame-guards.ts:29-34` — `isGatewayEventFrame` ne vérifie que `type==="event"`, `event` non vide, `seq` entier ≥ 0 si présent. Commentaire ligne 27-28 : « validate dispatch-critical envelope fields **without ... rejecting additive payload fields** ». |

**Conséquence directe** : `additionalProperties: false` dans les schémas amont
est une déclaration d'intention côté *lecture*, jamais une garantie côté *fil*.
Tout schéma amont doit être lu comme un **sous-ensemble minimal** de ce qui
arrive réellement. C'est la racine du pattern « N unknown field(s) » observé en
prod (§6).

---

## 1. Enveloppe de trame (contrat)

`$UP/packages/gateway-protocol/src/schema/frames.ts`

| Trame | Champ | Type | Opt. | file:line |
|---|---|---|---|---|
| `RequestFrame` | `type` | `"req"` littéral | non | frames.ts:177 |
| | `id` | NonEmptyString | non | frames.ts:178 |
| | `method` | NonEmptyString (**ouvert**) | non | frames.ts:179 |
| | `params` | `Unknown` | oui | frames.ts:180 |
| `ResponseFrame` | `type` | `"res"` | non | frames.ts:188 |
| | `id` | NonEmptyString | non | frames.ts:189 |
| | `ok` | Boolean | non | frames.ts:190 |
| | `payload` | `Unknown` | oui | frames.ts:191 |
| | `error` | `ErrorShape` | oui | frames.ts:192 |
| `EventFrame` | `type` | `"event"` | non | frames.ts:200 |
| | `event` | NonEmptyString (**ouvert**) | non | frames.ts:201 |
| | `payload` | `Unknown` | oui | frames.ts:202 |
| | `seq` | Integer ≥ 0 | **oui** | frames.ts:203 |
| | `stateVersion` | `{presence:int, health:int}` | oui | frames.ts:204 |
| `ErrorShape` | `code` / `message` | NonEmptyString | non | frames.ts:165-166 |
| | `details` | `Unknown` | oui | frames.ts:167 |
| | `retryable` | Boolean | oui | frames.ts:168 |
| | `retryAfterMs` | Integer ≥ 0 | oui | frames.ts:169 |
| `HelloOk` | `protocol`, `server.{version,connId}`, `features.{methods[],events[],capabilities?}`, `snapshot`, `controlUiTabs?`, `pluginSurfaceUrls?`, `auth.{deviceToken?,role,scopes[],issuedAtMs?,deviceTokens?}`, `policy.{maxPayload,maxBufferedBytes,tickIntervalMs}` | — | — | frames.ts:89-160 |

Non contraints (« champs libres ») : `method`, `event`, `payload`, `params`,
`error.details`, `HealthSnapshotSchema = Type.Any()`
(`$UP/.../schema/snapshot.ts:35`).

Bornes serveur : `MAX_PAYLOAD_BYTES = 25 MiB`, `MAX_BUFFERED_BYTES = 50 MiB`,
`MAX_PREAUTH_PAYLOAD_BYTES = 64 KiB`, `TICK_INTERVAL_MS = 30 000`
(`$UP/src/gateway/server-constants.ts:3-5,24`).

### 1.1 `EventFrame.seq` — sémantique réelle (INVARIANT NON DOCUMENTÉ CÔTÉ ATRIUM)

`$UP/src/gateway/server-broadcast.ts:106,161,174-179,189-195`

- `seq` est un **compteur par connexion** (`clientSeq: WeakMap<client, number>`),
  incrémenté pour **tout** événement diffusé à ce client, tous types confondus.
- Diffusion **ciblée** (`broadcastToConnIds`) : `eventSeq = undefined` → la trame
  part **SANS `seq`** et le compteur **n'est pas** incrémenté (ligne 189-192).
- Quand `dropIfSlow` fait tomber un événement, le compteur **est quand même
  incrémenté** (ligne 176) → **un trou dans `seq` = un événement perdu**. C'est
  le SEUL signal de perte.
- Consommateur lent sans `dropIfSlow` → `socket.close(1008, "slow consumer")`
  (ligne 182).

**Test amont qui épingle cet invariant** :
`$UP/src/gateway/gateway-misc.test.ts:593-613` — « preserves seq gaps when
dropIfSlow skips an eligible broadcast » : le client lent reçoit
`[["heartbeat", 2]]`, le client sain `[["chat",1],["heartbeat",2]]`.
Et `gateway-misc.test.ts:586-590` épingle que `seq` est **par client** (valeurs
`[1,2,2]` sur trois sockets).

---

## 2. Catalogue des événements (contrat vs réalité)

Liste annoncée : `GATEWAY_EVENTS` (`$UP/src/gateway/server-methods-list.ts:39-70`),
renvoyée dans `hello-ok.features.events` (`$UP/src/gateway/server.impl.ts:1581`).
Garde de scope réelle : `EVENT_SCOPE_GUARDS`
(`$UP/src/gateway/server-broadcast.ts:23-56`).

| Événement | Annoncé ? | Scope requis | Schéma TypeBox | Site d'émission (file:line) | Diffusion | `dropIfSlow` | Consommé par Atrium ? |
|---|---|---|---|---|---|---|---|
| `connect.challenge` | oui | (pré-auth) | **aucun** | `server/ws-connection.ts:398` | ciblée | — | non (auth gérée dans `openclaw-client.ts`) |
| `agent` | oui | `operator.read` | `AgentEvent` (**très incomplet**, §3) | `server-chat.ts:1025` (`sendAgentPayload`→`broadcast`), `1274` (synthétique seq gap), `1340/1349/1368/1422/1429/1448` (ciblés) | broadcast + ciblée | non (broadcast) / oui (ciblée) | **oui** (`normalizer.ts:697`) |
| `chat` | oui | `operator.read` | `ChatEvent` (union 4 états) | `server-chat.ts:944` (`sendChatPayload`), `chat-abort.ts:457`, `server-methods/chat.ts:2755` (`broadcastChatFinal`), `2837` (`broadcastChatError`), `6028` (`chat.inject`) | broadcast ou ciblée | **oui pour les deltas** (`server-chat.ts:857,926`), non pour les terminaux | **oui** |
| `chat.send_timing` | **NON** | `operator.read` | **aucun** | `server-chat.ts:561`, `server-methods/chat.ts:380` | ciblée (connId émetteur) | oui | non |
| `chat.side_result` | **NON** | `operator.read` | **aucun** | `server-methods/chat.ts:2791` | broadcast | non | **non — perte de contenu, §7.3** |
| `session.message` | oui | `operator.read` | **aucun** | `server-session-events.ts:222-235` | ciblée (abonnés `sessions.messages.subscribe`) | oui | non (jamais abonné) |
| `session.operation` | oui | `operator.read` | `SessionOperationEvent` | `server-methods/sessions.ts:283-291`, appelé `2838` (start) / `2848` (end) | ciblée (abonnés `sessions.subscribe`) | oui | **non (jamais abonné) — §7.2** |
| `session.tool` | oui | `operator.read` | **aucun** (= payload `agent` + snapshot session) | `server-chat.ts:1363-1373` | ciblée | oui | non (redondant avec `agent`) |
| `sessions.changed` | oui | `operator.read` | **aucun** | `server-chat.ts:729-742` (terminal), `1511-1526` (start), `server-session-events.ts:245-258` / `282-297`, `server-methods/session-change-event.ts:49` | ciblée | oui | non (jamais abonné) |
| `presence` | oui | (aucun) | `PresenceEntry[]` + `stateVersion` | `server/presence-events.ts:14-22` | broadcast | oui | non |
| `tick` | oui | (aucun) | `TickEvent {ts}` | `server-maintenance.ts:118` | broadcast | non | non (mais prouve le socket vivant — cf. `normalizer.ts:660-672`) |
| `talk.mode` | oui | `operator.write` | `TalkModeParams` (params, pas l'événement) — payload réel `{enabled, phase\|null, ts}` | `server-methods/talk.ts:877-882` | broadcast | oui | non |
| `talk.event` | oui | `operator.read` | `TalkEvent` — mais **AUCUN site n'émet cette forme** (§7.5) | `server-methods/nodes.ts:664` (`{nodeId,command,talkEvent}`), `server-methods/talk-shared.ts:55` (`{handoffId,roomId,talkEvent}`), `talk-realtime-relay.ts:57+62` (`{relaySessionId,type,…}`), `talk-transcription-relay.ts:34` | broadcast/ciblée | oui | non |
| `shutdown` | oui | (aucun) | `ShutdownEvent {reason, restartExpectedMs?}` | `server-close.ts:889` | broadcast | non | **non — §7.4** |
| `health` | oui | (aucun) | `Type.Any()` | `server-maintenance.ts:106` | broadcast | oui | non |
| `heartbeat` | oui | (aucun) | **aucun** — `HeartbeatEventPayload` (`$UP/src/infra/heartbeat-events.ts:7-22`) | `server-runtime-subscriptions.ts:297` | broadcast | oui | non |
| `cron` | oui | `operator.read` | **aucun** — `CronEvent` (`$UP/src/cron/service/state.ts:25-46`) | `server-cron.ts:675` | broadcast | oui | non (Atrium interroge `cron.list`) |
| `task` | oui | `operator.read` | **aucun** — `TaskEventPayload` (`$UP/src/gateway/server-methods/task-summary.ts:23-26`) | `server-runtime-subscriptions.ts:336` | broadcast | oui | non (Atrium interroge `tasks.list/get`) |
| `node.pair.requested` | oui | `operator.pairing` | `NodePairRequestParams` (params) | `server-methods/nodes.ts:938`, `server/ws-connection/message-handler.ts:679` | broadcast | oui | non |
| `node.pair.resolved` | oui | `operator.pairing` | **aucun** — `{requestId,nodeId,decision,ts,…}` | `nodes.ts:382/1010/1039`, `message-handler.ts:667/2284` | broadcast | oui | non |
| `node.invoke.request` | oui | `operator.pairing` | `NodeInvokeRequestEvent` | (nodes) | ciblée | — | non |
| `device.pair.requested` | oui | `operator.pairing` | `DevicePairRequestedEvent` | `message-handler.ts:1543/1547` | broadcast | oui | non |
| `device.pair.resolved` | oui | `operator.pairing` | `DevicePairResolvedEvent` | `server-methods/devices.ts:332/400`, `message-handler.ts:1476/1523` | broadcast | oui | non |
| `voicewake.changed` | oui | `operator.read` (+ rôle `node`) | **aucun** — `{triggers}` | `server-node-session-runtime.ts:36` | broadcast | oui | non |
| `voicewake.routing.changed` | oui | `operator.read` (+ `node`) | **aucun** — `{config}` | `server.impl.ts:1125` | broadcast | oui | non |
| `exec.approval.requested` / `.resolved` | oui | `operator.approvals` | `ExecApprovalRequestParams`/`ResolveParams` (params) | `server-methods/approval-shared.ts:457` / `652` | broadcast | oui | non |
| `plugin.approval.requested` / `.resolved` | oui | `operator.approvals` | `PluginApprovalRequestParams`/`ResolveParams` | `approval-shared.ts:457/652`, `node-invoke-plugin-policy.ts:104` | broadcast | oui | non |
| `terminal.data` | oui | `operator.admin` | `TerminalDataEvent {sessionId,seq,data}` | (terminal) | ciblée | — | non |
| `terminal.exit` | oui | `operator.admin` | `TerminalExitEvent {sessionId,exitCode?,signal?,reason?,error?}` | (terminal) | ciblée | — | non |
| `update.available` | oui (`GATEWAY_EVENT_UPDATE_AVAILABLE`) | (aucun) | **aucun** | `server-startup-post-attach.ts:1035` | broadcast | oui | non |
| `plugin.*` (namespace ouvert) | **non** | `operator.write`/`admin` | **aucun** | plugins tiers via `broadcast` | broadcast | selon appelant | non |

### 2.1 Événements émis MAIS non annoncés (cas dangereux)

| Événement | Preuve d'émission | Preuve d'absence du catalogue |
|---|---|---|
| `chat.send_timing` | `server-chat.ts:561`, `server-methods/chat.ts:380` ; garde de scope `server-broadcast.ts:26` | absent de `server-methods-list.ts:39-70` |
| `chat.side_result` | `server-methods/chat.ts:2791` ; garde `server-broadcast.ts:27` | absent de `server-methods-list.ts:39-70` |
| `plugin.<x>` arbitraire | `server-broadcast.ts:77-84` (branche `event.startsWith("plugin.")` acceptée pour `operator.write`/`admin`) | pas d'entrée générique dans le catalogue |

Un client qui négocie ses capacités sur `hello-ok.features.events` ne verra
jamais ces trois familles annoncées, alors qu'elles arrivent bien sur son
socket.

---

## 3. `agent` — le fossé contrat / réalité (le cœur du problème)

### 3.1 Contrat déclaré

`$UP/packages/gateway-protocol/src/schema/agent.ts:57-68` — `AgentEventSchema`,
`additionalProperties: false` :

| Champ | Type | Opt. |
|---|---|---|
| `runId` | NonEmptyString | non |
| `seq` | Integer ≥ 0 | non |
| `stream` | NonEmptyString (**ouvert, pas d'enum**) | non |
| `ts` | Integer ≥ 0 | non |
| `spawnedBy` | NonEmptyString | oui |
| `isHeartbeat` | Boolean | oui |
| `data` | `Record<String, Unknown>` (**totalement libre**) | non |

### 3.2 Ce qui est RÉELLEMENT émis

Payload = `AgentEventPayload` étalé (`$UP/src/infra/agent-events.ts:108-128`)
+ enrichissements du gateway (`$UP/src/gateway/server-chat.ts:1237-1249`)
+ pour certains streams, **le snapshot de session aplati**
(`buildSessionEventSnapshot`, `server-chat.ts:420-521`).

| Champ | Type | Émis par (file:line) | Dans 2026.6.11 (vendored) ? | Dans 2026.7.1 ? | Consommé par Atrium ? |
|---|---|---|---|---|---|
| `runId` | string | `agent-events.ts:467-473` | ✅ schéma | ✅ schéma | ✅ isolation + corrélation (`normalizer.ts:733-746`) |
| `seq` | int (par run, commence à 1) | `agent-events.ts:442-443` | ✅ | ✅ | ⚠️ jamais lu sur les `agent` (voir §7.1) |
| `stream` | string ouvert | idem | ✅ | ✅ | ✅ routage (`normalizer.ts:1042-1136`) |
| `ts` | int | `agent-events.ts:473` | ✅ | ✅ | non |
| `spawnedBy` | string | `server-chat.ts:1243` (via `resolveSpawnedBy`) | ✅ | ✅ | ✅ porte sous-agent (`normalizer.ts:719-731`) |
| `isHeartbeat` | bool | `server-chat.ts:1244` | ✅ | ✅ | non |
| `data` | objet libre | idem | ✅ | ✅ | ✅ par stream |
| **`sessionKey`** | string | `server-chat.ts:1241` | ❌ **hors schéma** | ❌ **hors schéma** | ✅ **porte d'isolation** (`normalizer.ts:733`) |
| **`sessionId`** | string | `agent-events.ts:470` | ❌ hors schéma | ❌ hors schéma | ✅ détection de compaction par rotation (`normalizer.ts:761-775`) |
| **`agentId`** | string | `agent-events.ts:471`, `server-chat.ts:1242` | ❌ hors schéma | ❌ hors schéma | ignoré (connexion déjà scopée) |
| `session` (objet complet) | objet | `server-chat.ts:466` | ❌ | ❌ | ignoré |
| `updatedAt` | int | `server-chat.ts:467` | ❌ | ❌ | ignoré |
| `kind` | string | `:470` | ❌ | ❌ | ignoré |
| `channel` | string | `:471` | ❌ | ❌ | ignoré |
| **`subject`** | string | `:472` | ❌ | ❌ | ❌ **inconnu du détecteur de drift** |
| **`groupChannel`** | string | `:473` | ❌ | ❌ | ❌ **inconnu** |
| **`space`** | string | `:474` | ❌ | ❌ | ❌ **inconnu** |
| `chatType` | string | `:475` | ❌ | ❌ | ignoré |
| `origin` | string | `:476` | ❌ | ❌ | ignoré |
| `spawnedWorkspaceDir` | string | `:478` | ❌ | ❌ | ignoré |
| `spawnedCwd` | string | `:479` | ❌ | ❌ | ignoré (ajouté après badge prod 2026-07-19) |
| **`forkedFromParent`** | bool | `:480` | ❌ | ❌ | ❌ **inconnu** |
| `spawnDepth` | int | `:481` | ❌ | ❌ | ignoré |
| `subagentRole` | string | `:482` | ❌ | ❌ | ignoré |
| `subagentControlScope` | string | `:483` | ❌ | ❌ | ignoré |
| `label` | string | `:484` | ❌ | ❌ | ignoré |
| `displayName` | string | `:485` | ❌ | ❌ | ignoré |
| `deliveryContext` | objet | `:486` | ❌ | ❌ | ignoré |
| `parentSessionKey` | string | `:487` | ❌ | ❌ | ignoré |
| `childSessions` | tableau | `:488` | ❌ | ❌ | ignoré |
| `thinkingLevel` | string | `:489` | ❌ | ❌ | ignoré |
| `fastMode` | bool/`"auto"` | `:490` | ❌ | ❌ | ignoré |
| `verboseLevel` | string | `:491` | ❌ | ❌ | ignoré |
| **`traceLevel`** | string | `:492` | ❌ | ❌ | ❌ **inconnu** |
| **`reasoningLevel`** | string | `:493` | ❌ | ❌ | ❌ **inconnu** |
| **`elevatedLevel`** | string | `:494` | ❌ | ❌ | ❌ **inconnu** |
| **`sendPolicy`** | string | `:495` | ❌ | ❌ | ❌ **inconnu** |
| `systemSent` | bool | `:496` | ❌ | ❌ | ignoré |
| `inputTokens` | int | `:497` | ❌ | ❌ | ✅ trace de pression (`normalizer.ts:1031-1041`) |
| `outputTokens` | int | `:498` | ❌ | ❌ | ✅ idem |
| `lastChannel` | string | `:499` | ❌ | ❌ | ignoré |
| **`lastTo`** | string | `:500` | ❌ | ❌ | ❌ **inconnu** |
| **`lastAccountId`** | string | `:501` | ❌ | ❌ | ❌ **inconnu** |
| **`lastThreadId`** | string | `:502` | ❌ | ❌ | ❌ **inconnu** |
| `totalTokens` | int | `:503` | ❌ | ❌ | ✅ trace de pression |
| `totalTokensFresh` | bool | `:504` | ❌ | ❌ | ignoré |
| `goal` | string/null | `:505` | ❌ | ❌ | ignoré |
| `contextTokens` | int | `:506` | ❌ | ❌ | ignoré |
| `estimatedCostUsd` | number | `:507` | ❌ | ❌ | ✅ trace de pression |
| **`responseUsage`** | string | `:508` | ❌ | ❌ | ❌ **inconnu** |
| `effectiveResponseUsage` | string | `:511` | ❌ | ✅ *seul champ documenté 6.11→7.1 par Atrium* | ignoré |
| `modelProvider` | string | `:512` | ❌ | ❌ | ignoré |
| `model` | string | `:513` | ❌ | ❌ | ignoré |
| `status` | string | `:515` | ❌ | ❌ | ignoré |
| `startedAt` | int | `:516` | ❌ | ❌ | ignoré |
| `endedAt` | int | `:517` | ❌ | ❌ | ignoré (ajouté après badge prod 2026-07-22) |
| `runtimeMs` | int | `:518` | ❌ | ❌ | ignoré |
| `abortedLastRun` | bool | `:519` | ❌ | ❌ | ignoré |
| `hasActiveRun` / `activeRunIds` | bool / string[] | `:458-459`, `:514` — **uniquement si `includeActiveRunState=true`** ⇒ jamais sur `agent`, seulement sur `sessions.changed` | ❌ | ❌ | s/o |

Streams porteurs du snapshot aplati : `tool` (`server-chat.ts:1340`,`1349`,`1368`,`1448`),
`assistant` commentaire caché (`:1422`), `item` caché (`:1429`).
Un `agent` `assistant`/`lifecycle` ordinaire visible Control UI **n'a pas** le
snapshot (`server-chat.ts:1401-1404`) → **la surface de champs varie d'un stream
à l'autre pour un même événement `agent`**.

### 3.3 Vocabulaire de `stream`

`$UP/src/infra/agent-events.ts:9-22` déclare
`"lifecycle" | "tool" | "assistant" | "error" | "item" | "plan" | "approval" |
"command_output" | "patch" | "compaction" | "thinking" | (string & {})`.

Sites d'émission réels dans `$UP/src` (hors tests) :

| `stream` | Occurrences | Exemples de sites | Consommé par Atrium |
|---|---|---|---|
| `lifecycle` | 34 | `agent-command.ts:1936/1960/1996/2027`, `embedded-agent-subscribe.handlers.lifecycle.ts:48/206`, `chat-abort.ts:543` | ✅ `normalizer.ts:1076` |
| `tool` | 10 | `handlers.tools.ts:1051/1075/1193/1219/1491/1523`, `cli-runner/execute.ts:1221/1256` | ✅ `:1072` |
| `assistant` | 7 | `embedded-agent-subscribe.ts:278/282`, `cli-runner/execute.ts:1426` | ✅ `:1052` |
| `item` | 6 | `infra/agent-events.ts:517`, `handlers.tools.ts:315`, `run.ts:870` | ✅ partiellement `:1080` |
| `compaction` | 5 | `handlers.compaction.ts:63/67/153/157`, `run.ts:1922` | ✅ `:1068` |
| `stdout` | 10 | `process/exec.ts:634/718` (sorties process) | ❌ |
| `thinking` | 3 | `embedded-agent-subscribe.ts:1197`, `cli-runner/execute.ts:1453/1464` | ❌ |
| `command_output` | 3 | `infra/agent-events.ts:545`, `handlers.tools.ts:1258/1638` | ❌ |
| `approval` | 3 | `infra/agent-events.ts:531`, `handlers.tools.ts:1571/1664` | ❌ |
| `stderr` | 2 | `process/exec.ts:646/725` | ❌ |
| `patch` | 2 | `infra/agent-events.ts:559`, `handlers.tools.ts:1710` | ❌ |
| `acp` | 2 | `command/attempt-execution.ts:1224/1256` | ❌ |
| `error` | 1 | **`server-chat.ts:1276` — le diagnostic « seq gap » du gateway** | ❌ **§7.1** |
| `plan` | 0 dans `src/` | **8 dans `extensions/`** : `codex/src/app-server/event-projector.ts:1628`, `copilot/src/event-bridge.ts:224/238/257` | ❌ **§7.6** |
| `output` | 0 dans `src/` | 4 dans `extensions/` | ❌ |
| `model` | 0 | réservé (`plugins/agent-event-emission.ts:24`) mais aucun site | s/o |
| `codex_app_server.lifecycle/.guardian/.hook/.item/.tool` | 7+5+4+2+1 | `extensions/codex/**` | ❌ (sauf `*.provenance`) |
| `<pluginId>[.suffix]` **arbitraire** | ouvert | `plugins/agent-event-emission.ts:68-73` | ✅ seulement si `*.provenance` (`normalizer.ts:1130`) |

**Le vocabulaire de `stream` est extensible par plugin tiers**
(`$UP/src/plugins/agent-event-emission.ts:27-29,68-73` : un plugin non *bundled*
peut émettre `pluginId` ou `pluginId.<suffixe>` avec un `data` JSON libre ;
`data` reçoit d'office `pluginId` et `pluginName`, lignes 36-47). Les plugins
*bundled* peuvent émettre **n'importe quel** stream host (ligne 65).

### 3.4 Formes de `data` par stream (émission réelle)

| `stream` | `data` (champs) | file:line |
|---|---|---|
| `lifecycle` start | `phase:"start"`, `startedAt` | `handlers.lifecycle.ts:49-52` ; `agent-command.ts:1938-1945` ajoute `endedAt`,`aborted`,`stopReason` sur `phase:"finishing"` |
| `lifecycle` end | `phase:"end"`, `startedAt`, `endedAt`, `aborted`, `stopReason`, `yielded?`, `timeoutPhase?`, `providerStarted?`, `toolErrorSummary?`, `livenessState?`, `replayInvalid?` | `handlers.lifecycle.ts:185-214` ; `agent-command.ts:1955-1968` |
| `lifecycle` error | idem + `error` (texte), `fallbackExhaustedFailure?` | `agent-command.ts:1990-2015` ; `handlers.lifecycle.ts:197,207-214` |
| `lifecycle` **`finishing`** | `phase:"finishing"`, … | `handlers.lifecycle.ts:196` ; `attempt.ts:3741-3744` ; **4ᵉ valeur de `phase`, ignorée par Atrium (§7.7)** |
| `tool` start | `phase:"start"`, `name`, `toolCallId`, `args` (sanitisés), `hideFromChannelProgress?` | `handlers.tools.ts:1049-1058` |
| `tool` update | `phase:"update"`, `name`, `toolCallId`, `partialResult` | `handlers.tools.ts:1192-1201` |
| `tool` result | `phase:"result"`, `name`, `toolCallId`, `meta`, `isError`, `result`, `toolErrorSummary?` | `handlers.tools.ts:1489-1501` |
| `assistant` | `text` (snapshot cumulatif) et/ou `delta`, `mediaUrls?` | `embedded-agent-subscribe.ts:276-280` ; lecture gateway `live-chat-projector.ts:19-33` |
| `thinking` | `text`, `delta` | `embedded-agent-subscribe.ts:1197-1203` |
| `item` | `itemId`, `phase:start\|update\|end`, `kind`, `title`, `status:running\|completed\|failed\|blocked`, `name?`, `meta?`, `toolCallId?`, `startedAt?`, `endedAt?`, `error?`, `summary?`, `progressText?`, `suppressChannelProgress?`, `hideFromChannelProgress?`, `approvalId?`, `approvalSlug?` | `infra/agent-events.ts:36-56` |
| `approval` | `phase:requested\|resolved`, `kind:exec\|plugin\|unknown`, `status:pending\|unavailable\|approved\|denied\|failed`, `title`, + `itemId?`,`toolCallId?`,`approvalId?`,`approvalSlug?`,`command?`,`host?`,`reason?`,`scope?`,`message?` | `infra/agent-events.ts:66-79` |
| `command_output` | `itemId`, `phase:delta\|end`, `title`, `toolCallId`, `name?`, `output?`, `status?`, `exitCode?`, `durationMs?`, `cwd?` | `infra/agent-events.ts:82-93` |
| `patch` | `itemId`, `phase:"end"`, `title`, `toolCallId`, `name?`, `added[]`, `modified[]`, `deleted[]`, `summary` | `infra/agent-events.ts:95-105` |
| `compaction` start | `phase:"start"` — **et RIEN d'autre** | `handlers.compaction.ts:61-65` |
| `compaction` end | `phase:"end"`, `willRetry`, `completed` | `handlers.compaction.ts:151-155` ; variante hooks `run.ts:1919-1928` ajoute `messages[]` |
| `error` (synthétique) | `reason:"seq gap"`, `expected`, `received` | `server-chat.ts:1281-1285` |
| `plan` (extensions) | `phase:"update"`, `title`, `source`, `explanation?`, `steps[]?`, `operation?`, `actions?`, `requestId?`, `recommendedAction?`, `approved?`, `autoApproveEdits?` | `codex/.../event-projector.ts:1627-1636` ; `copilot/src/event-bridge.ts:222-266` |

**Le `reason` de la compaction (`manual`/`threshold`/`overflow`) est normalisé
mais JAMAIS mis sur le fil** : `normalizeCompactionReason`
(`handlers.compaction.ts:35-39`) le calcule, `compactionLogKind` l'utilise pour
les logs, et `emitAgentEvent` (`:61-65`, `:151-155`) ne l'inclut pas dans `data`.
→ un client ne peut pas distinguer un dépassement de contexte (`overflow`) d'une
compaction de seuil. C'est directement la plainte « erreurs de contexte
dépassé » vue côté client.

---

## 4. `chat` — contrat et émission

`$UP/packages/gateway-protocol/src/schema/logs-chat.ts:128-202`.

| Champ | Type | delta | final | aborted | error | Émis par | Atrium |
|---|---|---|---|---|---|---|---|
| `runId` | NonEmptyString | ✓ | ✓ | ✓ | ✓ | `server-chat.ts:838,986,1006`, `chat.ts:2747` | ✅ |
| `sessionKey` | NonEmptyString | ✓ | ✓ | ✓ | ✓ | idem | ✅ porte d'isolation |
| `agentId` | opt | ✓ | ✓ | ✓ | ✓ | idem | ignoré |
| `spawnedBy` | opt | ✓ | ✓ | ✓ | ✓ | `server-chat.ts:841,984` | ✅ sous-agent |
| `seq` | Integer ≥ 0 | ✓ | ✓ | ✓ | ✓ | `server-chat.ts:842` (= `evt.seq` de l'agent), `chat.ts:2745` (`nextChatSeq`) | clé de dédup uniquement (`normalizer.ts:875`) |
| `state` | littéral | `"delta"` | `"final"` | `"aborted"` | `"error"` | — | ✅ |
| `message` | `Unknown` (opaque) | opt (snapshot cumulatif) | opt | opt | opt | `server-chat.ts:846-852`, `chat.ts:2752` | ✅ précédence snapshot |
| `deltaText` | String | **req** | — | — | — | `server-chat.ts:845` | ✅ |
| `replace` | Boolean | opt | — | — | — | `server-chat.ts:844` (via `resolveBroadcastDelta:241-257`) | ✅ |
| `usage` | `Unknown` | opt | opt | — | opt | **AUCUN site** (§5.2) | ignoré (classification correcte) |
| `stopReason` | String (**libre**) | — | opt | opt | opt | `server-chat.ts:990,1013` | ✅ |
| `errorMessage` | String | — | — | **opt (7.1)** | opt | `server-chat.ts:987,1010`, `chat-abort.ts:447` | ✅ |
| `errorKind` | enum fermé | — | — | — | opt | `server-chat.ts:1012` (source : `readChatErrorKind(evt.data.errorKind) ?? detectErrorKind(evt.data.error)`, `:684`) | ✅ |

`errorKind` = `refusal | timeout | rate_limit | context_length | unknown`
(`logs-chat.ts:137-143` ; producteur `$UP/src/infra/errors.ts:150-186`). La
détection est **textuelle par regex** (`errors.ts:158-185`) : `"context length"`,
`"too many tokens"`, `"token limit"`, `"context_window"`. Un message provider
formulé autrement ⇒ pas de `context_length`.

### 4.1 Ordre et unicité (émission)

- **Un delta tampon est vidé juste avant tout terminal**, avec **le MÊME `seq`**
  que le terminal : `server-chat.ts:977` (flush) puis `:986` / `:1009`
  (terminal). ⇒ `(runId, seq)` **n'est pas** une clé d'ordre utilisable sur le
  flux `chat`.
  Test amont : `server-chat.agent-events.test.ts:1118` « flushes buffered text as
  delta before final when throttle suppresses the latest chunk ».
- Throttle des deltas : 150 ms (`server-chat.ts:826-829`).
- Les deltas sont diffusés avec `dropIfSlow: true` (`:857`, `:926`) ; les
  terminaux **sans** `dropIfSlow` (`:990` → `sendChatPayload(…, opts)` où `opts`
  ne porte pas `dropIfSlow`). Atténuation : chaque delta transporte le
  **snapshot cumulatif complet** dans `message.content[0].text`
  (`:846-852`) ⇒ un delta perdu est récupérable par le snapshot suivant.
- Les événements `agent` sont diffusés **sans** `dropIfSlow` (`server-chat.ts:1025`)
  ⇒ un consommateur lent est **déconnecté** (close 1008) au lieu de perdre un
  événement.
- Nettoyage : `agentRunSeq.delete(evt.runId)` + `delete(clientRunId)` au terminal
  (`server-chat.ts:707-708`). Test : `server-chat.agent-events.test.ts:1421`
  « cleans up agent run sequence tracking when lifecycle completes ».
- Événements post-terminaux **ignorés** :
  `server-chat.agent-events.test.ts:1450` « drops stale events that arrive after
  lifecycle completion » — un `seq:3` après un lifecycle end ne produit **aucun**
  `stream:"error"` et aucun envoi.

### 4.2 `chat.inject` — un `final` avec un `runId` synthétique

`$UP/src/gateway/server-methods/chat.ts:6019-6034` : `runId: "inject-<messageId>"`,
`seq: 0`, `state:"final"`, diffusé en broadcast. Aucun client ne l'a demandé.

---

## 5. Ce que le schéma déclare et que RIEN n'émet

| Schéma / champ | Preuve d'absence d'émission |
|---|---|
| `ChatDeltaEvent.usage`, `ChatFinalEvent.usage`, `ChatErrorEvent.usage` | `grep -n usage $UP/src/gateway/server-chat.ts $UP/src/gateway/chat-abort.ts` → **0 occurrence** ; `server-methods/chat.ts:5412,5422,5680` ne portent `usage` que **dans** `message`, jamais au niveau racine. La classification `ignored` de `$AT/bridge/protocol/openclaw/coverage.json` est donc **exacte**. |
| `TalkEvent` comme payload de `talk.event` | aucun des 4 sites d'émission n'envoie cette forme à plat (§7.5) |
| `stream: "model"` | réservé (`plugins/agent-event-emission.ts:24`), **0 site** |
| `stream: "plan"` côté cœur | 0 dans `$UP/src`, uniquement dans `extensions/` |
| `AgentInternalEvent` (`agent.ts:37-54`) | contrat d'**entrée** (`AgentParams.internalEvents`, `:228`), jamais un événement sortant |

---

## 6. Delta vendored 2026.6.11 → amont 2026.7.1

Diff réel des 5 fichiers vendored (`$AT/bridge/protocol/openclaw/2026.6.11/`)
contre `$UP/packages/gateway-protocol/src/…`.

| Fichier | Changement 6.11 → 7.1 | Sens | Impact Atrium |
|---|---|---|---|
| `agent.ts` | `AgentParamsSchema` **+ `cwd?: NonEmptyString`** (7.1 ligne 209) | client → serveur | aucun (Atrium n'utilise pas `agent`) |
| `logs-chat.ts` | `ChatHistoryParams` **+ `offset?: Integer≥0`** (:35) | client → serveur | aucun (Atrium n'appelle pas `chat.history`) |
| `logs-chat.ts` | `ChatSendParams` **+ `expectedSessionRoutingContract?: NonEmptyString`** (:99) | client → serveur | **levier non exploité** : garde de contrat de routage de session côté gateway (`GATEWAY_SERVER_CAPS.CHAT_SEND_ROUTING_CONTRACT`, `frames.ts:6-8`) |
| `logs-chat.ts` | `ChatAbortParams` **+ `preserveSideRuns?: Boolean`** (:111) | client → serveur | levier non exploité (`chat.abort` d'Atrium) |
| `logs-chat.ts` | `ChatAbortedEvent` **+ `errorMessage?: String`** (:176) | **serveur → client** | ✅ déjà dans `KNOWN_CHAT_FIELDS` (`protocol-drift.ts:42`) et lu (`normalizer.ts:816`) |
| `primitives.ts` | chemins d'import uniquement | — | aucun |
| `client-info.ts`, `secret-ref-contract.ts` | identiques | — | aucun |

**Aucun retrait, aucun retypage.** Le seul changement d'émission 6.11→7.1 est
`ChatAbortedEvent.errorMessage`, déjà couvert.

**Mais** : le périmètre *vendored* ne couvre que `agent.ts`, `logs-chat.ts`,
`primitives.ts`, `client-info.ts`, `secret-ref-contract.ts` — **5 fichiers sur
36** (`$UP/packages/gateway-protocol/src/schema/` en contient 30 + 6 tests).
`frames.ts` (l'enveloppe, dont `EventFrame.seq`), `sessions.ts`
(`SessionOperationEvent`), `snapshot.ts`, `terminal.ts`, `tasks.ts`, `cron.ts`,
`devices.ts`, `nodes.ts`, `channels.ts` ne sont **pas** ratchetés. Le ratchet
d'Atrium ne peut donc pas détecter une régression sur l'enveloppe ni sur les
événements de session.

### 6.1 Le détecteur de drift est une liste d'observations, pas une dérivation

`$AT/bridge/src/providers/openclaw/protocol-drift.ts:47-131` (`KNOWN_AGENT_FIELDS`).
Historique lisible dans les commentaires : `effectiveResponseUsage`
(bench 2026-07-11), `spawnedCwd`/`label`/`displayName` (« badge prod 3 unknown
fields », client-1 2026-07-19), `endedAt` (« badge prod 1 unknown field »,
2026-07-22). Chaque champ est ajouté **après** être apparu en prod.

**Champs présents dans `buildSessionEventSnapshot` (`$UP/src/gateway/server-chat.ts:466-519`)
et ABSENTS de `KNOWN_AGENT_FIELDS`** — donc futurs badges « N unknown field(s) » :

`subject` (:472) · `groupChannel` (:473) · `space` (:474) ·
`forkedFromParent` (:480) · `traceLevel` (:492) · `reasoningLevel` (:493) ·
`elevatedLevel` (:494) · `sendPolicy` (:495) · `lastTo` (:500) ·
`lastAccountId` (:501) · `lastThreadId` (:502) · `responseUsage` (:508)

= **12 champs**. Ils n'apparaissent que lorsque la ligne de session les porte
(`JSON.stringify` supprime les `undefined`) : d'où l'apparition progressive,
imprévisible, par déploiement et par configuration. Le même raisonnement
s'applique aux 5 champs additionnels de `buildGatewaySessionSnapshot` utilisés
par `session.message`/`sessions.changed` si Atrium s'y abonnait un jour.

---

## 7. Défauts d'interprétation côté Atrium (prouvés par lecture croisée)

### 7.1 `EventFrame.seq` jamais lu + diagnostic « seq gap » jeté

- Le bridge ne lit **jamais** `frame.seq` :
  `grep -n "\.seq" $AT/bridge/src/providers/openclaw/{openclaw-client,multiplex}.ts`
  → 0 ; dans `normalizer.ts`, `seq` n'apparaît qu'aux lignes 869-875 (clé de
  dédup, et c'est `payload.seq`, pas `frame.seq`).
- Le gateway émet un `agent` synthétique `stream:"error"` avec
  `data:{reason:"seq gap", expected, received}` quand la séquence par run est
  discontinue (`$UP/src/gateway/server-chat.ts:1272-1287`, épinglé par
  `server-chat.agent-events.test.ts:4623-4662`). Atrium route par `stream` et ne
  traite pas `"error"` (`$AT/.../normalizer.ts:1052-1136`) ⇒ **le seul signal
  amont de désordre est silencieusement jeté**.
- Cette trame synthétique **n'a pas de `seq`** (`server-chat.ts:1274-1286`),
  violant `AgentEventSchema` (`seq` requis). Illustration supplémentaire du §0.

### 7.2 `session.operation` : Atrium n'est pas abonné

`grep -rn "sessions.subscribe\|sessions.messages.subscribe" $AT/bridge/src` → 0.
Méthodes réellement appelées par le bridge : `chat.send`, `chat.abort`,
`sessions.describe`, `sessions.get`, `sessions.patch`, `sessions.reset`,
`sessions.compact`, `sessions.compaction.list`, `agents.*`, `cron.*`, `tasks.*`,
`models.list`, `config.*`, `usage.status`, `talk.client.create`.

Conséquence : le signal de compaction **explicite et corrélé**
(`session.operation` avec `operationId` + `phase` + `completed` + `reason`,
`$UP/.../schema/sessions.ts:23-35`, émis `server-methods/sessions.ts:2838/2848`)
n'atteint jamais Atrium. Atrium doit reconstruire la compaction depuis
`stream:"compaction"` + rotation de `sessionId` + heuristique
`livenessState:"abandoned"` (`$AT/.../normalizer.ts:1276-1330`).

### 7.3 `chat.side_result` : perte de contenu

`SideResultPayload = {kind:"btw", runId, sessionKey, agentId?, question, text,
isError?, ts}` (`$UP/src/gateway/server-methods/chat.ts:795-804`), diffusé sur
l'événement `chat.side_result` (`:2791`). Le normalizer rejette tout `frame.event`
autre que `"chat"`/`"agent"` (`$AT/.../normalizer.ts:697-701`) ⇒ le « by the
way » produit par l'agent **disparaît**.

### 7.4 `shutdown` ignoré

`ShutdownEvent {reason, restartExpectedMs?}` (`frames.ts:25-31`) est émis avant
un arrêt/redémarrage (`server-close.ts:889`). Atrium le jette (même filtre
`normalizer.ts:697-701`) ⇒ un redémarrage annoncé du gateway est vécu comme un
silence, traité par les timeouts.

### 7.5 `talk.event` : le schéma ne décrit aucun payload réel

4 formes émises, aucune égale à `TalkEventSchema` :
`{nodeId,command,talkEvent}` (`nodes.ts:664-670`),
`{handoffId,roomId,talkEvent}` (`talk-shared.ts:55-60`),
`TalkRealtimeRelayEventPayload {relaySessionId,type,…}`
(`talk-realtime-relay.ts:57,62-76`), relais de transcription
(`talk-transcription-relay.ts:34`). `TalkEventSchema` décrit le **`talkEvent`
imbriqué**. Atrium ne consomme pas `talk.event` (0 occurrence) ⇒ pas de bug
aujourd'hui, mais le contrat est faux et piégera toute évolution du mode talk.

### 7.6 `stream:"plan"` natif jamais consommé

Atrium dérive le plan du **flux `tool`** `update_plan`
(`$AT/bridge/src/core/plan-part.ts:1-11`, appelé `turn-sink.ts:781-788`) et, sur
les runs de livraison, d'un `item`+`update_plan` sans contenu
(`normalizer.ts:1112-1121`). Les backends Codex app-server et Copilot émettent
le plan sur `stream:"plan"` avec `steps[]`/`explanation`
(`extensions/codex/src/app-server/event-projector.ts:1623-1636`,
`extensions/copilot/src/event-bridge.ts:222-266`) ⇒ **aucune carte Plan** pour
ces agents.

### 7.7 `lifecycle.phase:"finishing"` non géré

`handleLifecycle` ne branche que `error`/`end`/`start`
(`$AT/.../normalizer.ts:1312,1333,1384`). `finishing` est la 4ᵉ valeur émise
(`$UP/src/agents/embedded-agent-subscribe.handlers.lifecycle.ts:196`,
`agent-command.ts:1938`, `attempt.ts:3741-3744`). Comportement actuel : ignoré
en silence — sans dommage fonctionnel connu, mais non documenté dans le contrat
Atrium (donc non testé).

### 7.8 Troncature à 8 000 caractères sur le `chat.final` du chemin `broadcastChatFinal`

`broadcastChatFinal` construit `message: projectChatDisplayMessage(params.message)`
**sans `maxChars`** (`$UP/src/gateway/server-methods/chat.ts:2752`).
`projectChatDisplayMessage` → `projectChatDisplayMessages` →
`sanitizeChatHistoryMessages(…, options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS)`
(`chat-display-projection.ts:1795-1800`, `:1767-1770`), avec
`DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS = 8_000` (`:27`) et
`truncateChatHistoryText` qui produit
`` `${text.slice(0, maxChars)}\n...(truncated)...` `` (`:52-62`).

Ce `final` est bien émis sur le chemin `chat.send` utilisé par Atrium
(`server-methods/chat.ts:5424-5430` et `5685-5691`, miroir de réponse-source /
livraison par message-tool). Atrium n'a **aucune** connaissance du marqueur
`...(truncated)...` (`grep -rn "truncated" $AT/bridge/src/providers/openclaw/`
→ uniquement des commentaires) et applique la précédence snapshot ⇒ **la réponse
tronquée devient la réponse finale persistée, sans signal**.

À distinguer du chemin `emitChatTerminal` (`server-chat.ts:954-1017`), qui
construit le texte depuis le tampon vif borné à
`MAX_LIVE_CHAT_BUFFER_CHARS = 500_000` (`live-chat-projector.ts:16`, coupe par la
**gauche** `slice(-N)`, `:35-40`) — pas de marqueur, perte du début au-delà de
500 k.

Le chemin de récupération d'Atrium (`sessions.get`) n'est **pas** tronqué : il
renvoie les messages bruts (`server-methods/sessions.ts:2548-2562`, aucune
projection).

### 7.9 `isControlUiVisible = false` ⇒ silence total pour Atrium

`sendChatPayload`/`sendAgentPayload` basculent sur les abonnés
`sessions.messages.subscribe` quand `controlUiVisible === false`
(`server-chat.ts:940-947`, `1013-1027`). Atrium n'est abonné à rien (§7.2) ⇒
**rien** n'arrive. `isControlUiVisible` est faux pour les runs dont le canal
d'origine n'est pas interne (`shouldSurfaceToControlUi = isInternalMessageChannel(…)`,
`agent-runner-execution.ts:1755-1769`, `followup-runner.ts:738-743`,
`agent-command.ts:1088/1330`, `server-methods/agent.ts:3121`). Un tour cron ou
un tour déclenché depuis Telegram/Discord est donc **invisible sur le socket**
pour Atrium.
Tests amont qui épinglent ce comportement :
`server-chat.agent-events.test.ts:3940` « suppresses live client events but
persists lifecycle for non-control-UI-visible runs », `:3972` « sends
non-control-UI-visible live chat only to exact session message subscribers ».

### 7.10 `chat.inject` adoptable pendant une grâce

`normalizer.ts:738-746` : un `runId` inconnu de `ownRunIds` est **admis** si une
grâce `lifecycle_end` ou une compaction est ouverte. Un `chat` `final` injecté
(`runId:"inject-…"`, `seq:0`, broadcast — `server-methods/chat.ts:6019-6034`)
pendant cette fenêtre serait donc adopté comme réponse du tour.
**NON PROUVÉ en live.** Pour trancher : injecter un message via `chat.inject`
pendant la grâce `lifecycle_end` (10 s) d'un tour Atrium et observer le texte
final persisté.

### 7.11 `agentRunSeq` partagé entre le flux agent et `nextChatSeq`

`nextChatSeq` (`server-methods/chat.ts:2731-2735`) incrémente
`context.agentRunSeq`, la **même** `Map` que le détecteur de gap du flux agent
lit et écrit (`server-chat.ts:1254`, `:1288`). Si le même `runId` traverse les
deux chemins, un `nextChatSeq` peut fabriquer un faux « seq gap ».
**NON PROUVÉ** : il faut vérifier si un `runId` non lié (`chatLink === undefined`)
peut recevoir à la fois un `broadcastChatFinal` et des `agent` events. Lecture à
faire : `$UP/src/gateway/server-methods/chat.ts` autour de `clientRunId` vs
`server-chat.ts:1200-1210` (`chatLink`), plus un test ciblé sur
`agentRunSeq`.

---

## 8. Invariants réellement garantis par les tests amont

| Invariant | Garanti | Preuve (file:line) |
|---|---|---|
| `EventFrame.seq` est par connexion, un trou = un drop `dropIfSlow` | **oui** | `gateway-misc.test.ts:586-590`, `:593-613` |
| Les trames ciblées (`broadcastToConnIds`) n'ont **pas** de `seq` | **oui** (code) | `server-broadcast.ts:189-192` — pas de test dédié trouvé |
| Un delta tampon est vidé avant tout terminal | **oui** | `server-chat.agent-events.test.ts:1118`, `:1213`, `:1376` |
| Un delta non-préfixe est marqué `replace: true` | **oui** | `server-chat.agent-events.test.ts:1334` |
| Aucun delta redondant si le texte est inchangé | **oui** | `:1261`, `:1300` |
| Les événements arrivant après le terminal sont ignorés | **oui** | `:1450` |
| L'état de séquence par run est nettoyé au terminal | **oui** | `:1421` |
| `seq gap` synthétique porte `spawnedBy` pour les sessions sous-agent | **oui** | `:4623-4662` |
| Un lifecycle pré-`sessions.reset` ne pollue pas la projection | **oui** | `:2152`, `:2226` |
| La précédence « hard timeout » n'est pas dégradée par un abort tardif | **oui** | `:3016`, `agent-run-terminal-outcome.ts:209-237` |
| Les runs non-Control-UI ne fuient pas sur le broadcast | **oui** | `:3940`, `:3972`, `:4126` |
| `AgentParams.internalEvents` est strict (rejette un champ inconnu) | **oui** | `schema/agent.test.ts:66-72` |
| **L'ordre entre `chat` et `agent` pour un même tour** | **NON garanti par test** — garanti seulement par l'écriture synchrone sur le même socket (`server-broadcast.ts:154-199`) | — |
| **`(runId, seq)` unique sur le flux `chat`** | **NON** — flush + terminal partagent le `seq` (`server-chat.ts:977` vs `:986`/`:1009`) | — |
| **Un seul terminal par `runId`** | **NON garanti** : `emitChatTerminal` (lifecycle) et `broadcastChatFinal`/`broadcastChatError` (chemin `chat.send`) sont deux producteurs indépendants | — |
| **Payload `agent` conforme à `AgentEventSchema`** | **NON** — §3.2 et §7.1 | — |

---

## 9. Ce qu'il faut lire pour trancher les points NON PROUVÉS

1. **§7.10 (`chat.inject` adopté)** — banc live : `chat.inject` pendant la grâce
   `lifecycle_end` (`LIFECYCLE_END_GRACE = 10.0`, `normalizer.ts:92` dans `$AT/.../normalizer.ts`) ;
   observer le texte final persisté.
2. **§7.11 (`agentRunSeq` partagé)** — lecture de
   `$UP/src/gateway/server-methods/chat.ts` (cycle de vie de `clientRunId`) +
   test unitaire amont à écrire sur `nextChatSeq` / détecteur de gap.
3. **Fréquence réelle des 12 champs manquants (§6.1)** — fixture amont : appeler
   `buildSessionEventSnapshot` sur une ligne de session complète et diffuser un
   `agent` `tool` ; ou en prod, lire `/api/v1/compat` (drift report) après avoir
   fixé `sendPolicy`/`reasoningLevel`/`traceLevel` dans la config du gateway.
4. **Impact réel de §7.9** — banc live : déclencher un cron OpenClaw dont le
   canal d'origine n'est pas interne et vérifier si le tour apparaît dans Atrium
   par le socket ou seulement par polling.

---

## 10. Remèdes proposés (design, pas de code)

| Id | Remède | Effort |
|---|---|---|
| `oc-drift-derived` | Dériver `KNOWN_AGENT_FIELDS` de la **forme de retour de `buildSessionEventSnapshot`** vendored (nouveau fichier `2026.7.1/session-event-snapshot.d.ts` extrait à la main du tag + test de bijection), au lieu d'une liste d'observations prod. Ajoute les 12 champs d'un coup et supprime le cycle « badge prod → patch ». | M |
| `oc-frames-seq` | Vendorer `frames.ts` ; lire `EventFrame.seq` dans `openclaw-client.ts` ; compter les trous par connexion en trace SOC2 (`gateway.ws.event_seq_gap` + compteur). Un trou = deltas perdus ⇒ forcer une resynchronisation par snapshot. | M |
| `oc-agent-error-stream` | Traiter `stream:"error"` avec `data.reason==="seq gap"` : anomalie observée (`expected`/`received`, pas de contenu) + resynchronisation. | S |
| `oc-compaction-reason` | Demander à l'amont d'ajouter `reason` dans `data` de `stream:"compaction"` (`handlers.compaction.ts:61-65`, `:151-155`) — ou s'abonner à `sessions.subscribe` pour `session.operation` qui le porte déjà (`schema/sessions.ts:32`). C'est le chaînon manquant du diagnostic « contexte dépassé ». | M |
| `oc-session-subscribe` | S'abonner à `sessions.subscribe` (et `sessions.messages.subscribe` par session active) : débloque `session.operation`, `sessions.changed`, et rend visibles les runs `isControlUiVisible:false` (§7.9). Attention : ces payloads portent une **autre** surface de champs à classer dans `coverage.json`. | L |
| `oc-truncation-guard` | Détecter le suffixe `\n...(truncated)...` sur un `chat.final` et, au lieu de le persister, déclencher la récupération `sessions.get` (non tronquée) ; tracer `chat.final_truncated` (compteur + longueur, jamais le texte). | M |
| `oc-shutdown-side-result` | Consommer `shutdown` (réduire les timeouts, marquer la cause de fin de tour) et `chat.side_result` (partie `kind:"side_result"` sur le message) au lieu du filtre binaire `chat`/`agent` (`normalizer.ts:697-701`). | M |
| `oc-plan-native` | Consommer `stream:"plan"` (`{steps[], explanation}`) en plus du chemin `tool update_plan`, pour couvrir Codex app-server et Copilot. | S |
| `oc-vendor-widen` | Étendre le périmètre vendored de 5 à ~12 fichiers (`frames`, `sessions`, `snapshot`, `terminal`, `tasks`, `cron`, `devices`) pour que le ratchet couvre l'enveloppe et les événements de session. | L |
| `oc-routing-contract` | Exploiter `ChatSendParams.expectedSessionRoutingContract` (nouveau en 7.1) + la capacité serveur `chat-send-routing-contract` (`frames.ts:6-8`) pour que le gateway **refuse** un `chat.send` mal routé au lieu de laisser Atrium corriger après coup. | M |

---

## 11. Récapitulatif du gradient contrat → réalité

```
CONTRAT (TypeBox, 30 modules)          ~ ce qu'un client peut lire sans surprise
   │  jamais appliqué à l'émission (§0)
   ▼
ÉMISSION RÉELLE                        ~ 30 événements, dont 3 non annoncés (§2.1)
   │  agent: 7 champs déclarés → jusqu'à 58 sur le fil (§3.2)
   │  stream: vocabulaire ouvert, extensible par plugin (§3.3)
   ▼
CE QU'ATRIUM REÇOIT                    2 événements sur 30 (chat, agent)
   │  filtre normalizer.ts:697-701
   ▼
CE QU'ATRIUM INTERPRÈTE                5 streams sur 16+ (assistant, tool,
   │                                   lifecycle, item, compaction, *.provenance)
   ▼
PERTES PROUVÉES                        seq gap (§7.1) · session.operation (§7.2)
                                       chat.side_result (§7.3) · shutdown (§7.4)
                                       plan natif (§7.6) · troncature 8k (§7.8)
                                       runs non-Control-UI (§7.9)
```
