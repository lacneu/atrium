# Zone 3 — Ce qu'Atrium fait des trames OpenClaw (map de traitement)

**Portée** : `bridge/src/providers/openclaw/` + `bridge/src/core/turn-sink.ts` + le driver
`bridge/src/session.ts`.
**Amont de référence** : OpenClaw @ `v2026.7.1`
(`<scratch>/upstream/openclaw`, `git describe --tags` = `v2026.7.1`).
**Méthode** : lecture des sites d'émission amont + lecture du code Atrium + **exécution réelle**
du `Normalizer` d'Atrium (vite-node) sur des trames construites à l'image des sites d'émission
amont. Les résultats marqués **[PROUVÉ]** sont des sorties de cette exécution ; les scripts sont
dans `scratchpad/stabilization/probe-tool-update.mjs` et `probe2.mjs`.

---

## 0. Résumé exécutif

Le pipeline est **solide sur son axe central** : isolation par `sessionKey` doublée
(multiplexer + normalizer), état de texte à précédence snapshot/delta cohérente, terminaux
`chat:error`/`chat:aborted` traités, compaction explicite préférée à l'heuristique, buffers
majoritairement bornés et documentés.

Il est **fragile sur trois axes** :

1. **Le vocabulaire `agent.data` n'est ni typé ni ratché.** Le schéma amont déclare
   `data: Type.Record(Type.String(), Type.Unknown())`
   (`packages/gateway-protocol/src/schema/agent.ts:57-68`). Tout ce dont Atrium dépend réellement
   (noms de `stream`, phases outil, phases lifecycle, `livenessState`, `yielded`, champs de
   compaction) est **hors du ratchet** `coverage.json`. Le manifeste dit `data: handled` en une
   ligne, et le test de couverture ne peut donc rien détecter d'un changement de vocabulaire.
2. **Cinq flux amont réels tombent dans le vide** : `stream:"error"` (le signal de **perte de
   trames** que la gateway émet elle-même), `stream:"approval"`, `stream:"command_output"`,
   `stream:"patch"`, `stream:"thinking"` — plus les événements d'enveloppe `shutdown` et
   `chat.side_result`.
3. **Une porte de contamination inter-run reste ouverte 900 s** pendant une compaction : un
   `chat:final` d'un **autre run** de la même session est adopté et devient la réponse de
   l'utilisateur. **[PROUVÉ]**.

---

## 1. Chemin complet d'une trame — points de décision

```
WebSocket (1 socket opérateur / instance)
  │  openclaw-client.ts  — JSON.parse, pas de lecture de `frame.seq` (D0)
  ▼
session.ts:429 consume()      — boucle unique, une lecture pendante + Promise.race(timeout, wake)
  │  D1  winner.done → close mid-turn : orphan recovery / force-abort (session.ts:479-530)
  │  D2  preFeedMessageId = ancre sous-agent (session.ts:542-546)
  ▼
RunManager.feed()  (run-manager.ts:435)
  │  D3  protocolDrift.observe()  — observe-only, jamais bloquant (protocol-drift.ts:164)
  │  D4  sink INACTIF ?
  │      D4a announceRunIdFor() → announce:/ task-delivery / talk-consult   (run-manager.ts:747-765)
  │           · déjà traité            → DROP                (run-manager.ts:454-460)
  │           · replayArmed|finalizing → stash pendingAnnounce (462-471)
  │           · stash non vide         → append + flush        (472-481)
  │           · sinon                  → beginTurn spontané (deferOpen) (488-506)
  │      D4b pendingAnnounce non vide  → flushPendingAnnounce  (510-521)
  │      D4c provenance                → stash pendingProvenance (527-542)
  │      D4d replayArmed               → stash pendingFrames     (543-547)
  │      D4e sinon                     → DROP silencieux
  │  D5  sink ACTIF :
  │      D5a announce d'un AUTRE run   → stash / DROP si retransmission (560-570)
  │      D5b replayArmed + runId ≠ own → stash pendingFrames    (579-587)
  ▼
Normalizer.feed()  (normalizer.ts:688)
  │  D6  frame.type === "res"                       → []        (692-695)
  │  D7  event ∉ {agent, chat}                      → []        (697-702)   ← tick/health/shutdown/side_result
  │  D8  payload non-objet                          → []        (703-706)
  │  D9  spawnedBy === this.sessionKey              → handleSubAgent, RETURN (717-730)
  │  D10 payload.sessionKey ≠ this.sessionKey       → []        (733-735)   ← barrière d'isolation
  │  D11 runId ∉ ownRunIds :
  │         · lifecycle_end armé OU compactionPending → ADOPTÉ (741-742)  ← D11 = porte ouverte
  │         · sinon                                   → []      (743-745)
  │  D12 armRecv(now)                                            (753)
  │  D13 rotation sessionId → context.compaction:preflight        (762-774)
  │  D14 dispatch chat / agent                                    (776-780)
  ▼
handleChat (863) | handleAgent (1024)
  │  handleChat  : dedup (872-883) → error/aborted (893-987) → snapshot (992-996)
  │                → deltaText (997-1010) → empty-final grace (1013-1019)
  │  handleAgent : imageGeneration (1048) → assistant (1052) → compaction (1068)
  │                → tool (1072) → lifecycle (1076) → item (1080) → provenance (1125)
  │                → **aucune branche par défaut** (fin de fonction, silence)
  ▼
BridgeEvent[]  (core/events.ts:18-59 — 11 types normalisés)
  ▼
TurnSink.apply()  (turn-sink.ts:489)
  │  D15 pendingOpen → applyDeferred (buffer / ouverture / discard) (510-557)
  │  D16 messageId null → RETURN, le reste du lot est PERDU        (496-499)
  │  D17 applyOne → ConvexWriter (628-1021)
  ▼
ConvexWriter → HTTP ingest Convex (convex-writer.ts:902 doPost — 0 retry)
```

### Points de décision les plus chargés

| # | Emplacement | Décision | Risque |
|---|---|---|---|
| D0 | `openclaw-client.ts:312-345` | l'enveloppe `frame.seq` n'est jamais lue | perte de trames indétectable (§3.1) |
| D7 | `normalizer.ts:697-702` | tout événement ≠ agent/chat est jeté | `shutdown`, `chat.side_result` perdus (§2.1) |
| D11 | `normalizer.ts:737-746` | adoption d'un runId étranger pendant une grâce | contamination inter-run (§3.5) |
| D16 | `turn-sink.ts:496-499` | `return` (pas `continue`) si `messageId === null` | le reste du lot d'événements est jeté |
| — | `session.ts:547-551` | `catch` autour de `feed()` : log + continue | un throw à mi-lot perd le terminal (§3.7) |

---

## 2. Classification par type de trame

### 2.1 Enveloppe (`frame.type` / `frame.event`)

| Trame amont | Émise par | Atrium | Verdict |
|---|---|---|---|
| `{type:"res"}` | toute RPC | matché par `connection.request()` ; le normalizer renvoie `[]` (`normalizer.ts:692-695`) | **consommée** (hors normalizer) |
| `frame.seq` (enveloppe) | `server-broadcast.ts:191-195` (`seq` par client, monotone) | jamais lu | **PERDUE — défaut** (§3.1) |
| `event:"chat"` | `server-chat.ts:838-856`, `server-methods/chat.ts:2740-2760` | `handleChat` | consommée |
| `event:"agent"` | `infra/agent-events.ts:485-495` | `handleAgent` | partiellement (§2.3) |
| `event:"tick"` | `server-broadcast.ts` (`tick: []`) | jeté par D7 ; sert indirectement de réveil au flush announce (`run-manager.ts:508-521`) | **ignorée volontairement** (comportement documenté) |
| `event:"health"`, `presence` | idem | jeté par D7 | ignorée volontairement |
| `event:"shutdown"` `{reason, restartExpectedMs}` | `server-close.ts:889-892`, émis **juste avant** la fermeture du socket | jeté par D7 | **PERDUE — défaut** : Atrium subit la fermeture comme un incident inexpliqué et déclenche l'orphan recovery à l'aveugle, alors que l'amont annonce le redémarrage et sa durée attendue |
| `event:"chat.side_result"` `{kind:"btw", question, text}` | `server-methods/chat.ts:2778-2800`, appelé en `4960-4988` | jeté par D7 | **PERDUE — défaut** : dans ce chemin l'amont enchaîne un `broadcastChatFinal` **sans `message`** (`chat.ts:2745-2755`) → Atrium voit un final vide → grâce 90 s → `empty_response_silent`. La réponse existait, dans la trame jetée. *Portée : branche `!agentRunStarted` (tours commande / non-agent) — non prouvé en live sur un tour Atrium standard ; à trancher en lisant `chat.ts:4960` avec un `/…` réel.* |
| `event:"task"`, `cron`, `sessions.changed`, `session.message`, `session.operation`, `session.tool` | `server-broadcast.ts:23-56` | jetés par D7 | ignorées volontairement (Atrium a ses propres sources) |
| `event:"exec.approval.requested"` / `plugin.approval.requested` | `server-broadcast.ts:30-33` | jetés par D7 | **PERDUE — défaut** (cf. `stream:"approval"`, §2.3) |

### 2.2 Trames `chat` (schéma `logs-chat.ts:128-190`)

| Champ | Amont | Atrium | Verdict |
|---|---|---|---|
| `runId` | requis | filtre `ownRunIds` (`normalizer.ts:736-749`) | consommé |
| `sessionKey` | requis | barrière d'isolation (`733-735`) + multiplexer (`multiplex.ts:83-108`) | consommé |
| `seq` (payload) | `logs-chat.ts:133` | uniquement dans la clé de dedup (`normalizer.ts:872-879`) | ignoré — mais voir §3.1 |
| `agentId` | optionnel | jamais lu | ignoré volontairement (mono-agent par session) |
| `spawnedBy` | optionnel | admission sous-agent (`717-730`) | consommé |
| `state:"delta"` + `message` | `server-chat.ts:846-851` (porte le **snapshot complet fusionné**) | `applyVisible(snapshot)` (`992-996`) | consommé — c'est ce qui rend Atrium résilient aux deltas droppés |
| `deltaText` | `server-chat.ts:845` | seulement si `message` absent (`997-1010`) | consommé |
| `replace` | `logs-chat.ts:150` | honoré sur le chemin `deltaText` (`1003-1007`) ; incident sur le chemin snapshot (le snapshot remplace de toute façon) | consommé |
| `usage` | `logs-chat.ts:152,163,...` | **jamais lu** | **PERDU** (déjà listé `protocol-schema-coverage.md:255-260`) |
| `state:"final"` + `stopReason` | `logs-chat.ts:167` | `bucketStopReason` → trace seule (`989-991`) | consommé (diagnostic) |
| `state:"error"` + `errorMessage`/`errorKind` | `logs-chat.ts:180-186` | terminalisé + allowlist enum (`930-986`) | consommé |
| `state:"aborted"` | `logs-chat.ts:170-178` | terminalisé `aborted`, sauf pendant une compaction heuristique (`893-928`) | consommé |
| `chat:final` **vide** | `broadcastChatFinal` `message: projectChatDisplayMessage(undefined)` | grâce `EMPTY_FINAL_GRACE` 90 s puis finalize (`1013-1019`) | consommé |

### 2.3 Trames `agent` — par `payload.stream`

Vocabulaire réel amont (grep sur `stream: "…"` dans `src/`, hors tests) :
`lifecycle` ×34, `tool` ×10, `stdout/stderr` ×12, `assistant` ×7, `item` ×6, `compaction` ×5,
`thinking` ×3, `command_output` ×3, `approval` ×3, `patch` ×2, `acp` ×2, `error` ×1.

| `stream` | Site d'émission amont | Atrium | Verdict |
|---|---|---|---|
| `assistant` | `embedded-agent-subscribe.handlers.messages.ts:985-990` | `data.text` → snapshot, `data.delta` → append (`normalizer.ts:1052-1067`) | consommé — mais `data.phase` (`"commentary"`) et `data.replace` et `data.itemId` **ignorés** (§3.4) |
| `lifecycle` | `…handlers.lifecycle.ts:198-215` | phases `start`/`end`/`error` (`normalizer.ts:1312-1392`) | partiellement (§3.2) |
| `tool` | `…handlers.tools.ts:1049-1058` (start), `1191-1201` (**update**), `1489-1502` (result) | `phase==="start"` vs **tout le reste = terminal** (`normalizer.ts:1207-1242`) | **MAL INTERPRÉTÉ — défaut** (§3.3) |
| `item` | `…handlers.tools.ts:1060-1075` etc. | uniquement `name:"message"` et les runs de livraison (`normalizer.ts:1080-1124`) | ignoré volontairement (le flux `tool` couvre les tours normaux) |
| `compaction` | `…handlers.compaction.ts:60-68`, `152-160` | `phase` start/end + `willRetry` (`normalizer.ts:1276-1310`) | consommé — `completed` **ignoré** (§3.6) |
| `<plugin>.provenance` | contrat Atrium | `parseProvenanceReport` (`normalizer.ts:1125-1136`) | consommé |
| `error` | `server-chat.ts:1272-1287` — **`{reason:"seq gap", expected, received}`** | **aucune branche** → `[]` **[PROUVÉ]** | **PERDU — défaut critique** (§3.1) |
| `approval` | `infra/agent-events.ts:525-533`, `…handlers.tools.ts:1571`, `1664` | **aucune branche** → `[]` **[PROUVÉ]** | **PERDU — défaut** (§3.8) |
| `command_output` | `infra/agent-events.ts:539-547`, `…handlers.tools.ts:1258`, `1638` | aucune branche | **PERDU** (sortie live d'un `exec` — feature manquante, pas une régression) |
| `patch` | `infra/agent-events.ts:553-561`, `…handlers.tools.ts:1710` | aucune branche | **PERDU** (résumé de diff jamais montré) |
| `thinking` | `embedded-agent-subscribe.ts:1197`, `cli-runner/execute.ts:1453` | aucune branche | ignoré (choix produit défendable — **mais non documenté** : rien dans `coverage.json` ne dit « ignoré, raison X ») |
| `acp` | `agents/command/attempt-execution.ts:1224,1256` | aucune branche | ignoré |

### 2.4 Champs `agent` top-level

| Champ | Atrium | Verdict |
|---|---|---|
| `seq` (payload, monotone **par run**, `agent.ts:60`) | **jamais lu** — `coverage.json` prétend `handled: "frame dedup/tally"`, or `tallyFrame` (`run-manager.ts:143-149`) ne l'inclut pas et `handleChat` ne dédupe que les trames `chat` | **manifeste faux** (§3.1) |
| `ts` | ignoré (horloge injectée) — documenté | ignoré volontairement |
| `isHeartbeat` | ignoré — documenté (`coverage.json`) | ignoré volontairement |
| `totalTokens`/`inputTokens`/`outputTokens`/`estimatedCostUsd` (aplatis) | `diagUsage` (`normalizer.ts:1029-1041`) | consommé |
| ~40 autres champs de métadonnées aplatis | listés dans `KNOWN_AGENT_FIELDS` (`protocol-drift.ts:47-131`) pour ne pas déclencher la dérive | ignorés volontairement |

---

## 3. Fragilités

### 3.1 [CRITIQUE] Le signal de perte de trames de la gateway est jeté

**Amont, trois faits chaînés :**
1. `server-broadcast.ts:162-176` : si `socket.bufferedAmount > MAX_BUFFERED_BYTES`, une trame
   marquée `dropIfSlow` est **abandonnée** (`continue`) tout en **incrémentant `clientSeq`**.
2. Les deltas de chat sont émis avec `dropIfSlow: true` (`server-chat.ts:854`, `926`).
3. `server-broadcast.ts:194-195` : chaque trame porte `"seq":N`, monotone par client
   (`EventFrameSchema.seq`, `frames.ts:198-205`). **Le trou de `seq` EST la preuve du drop.**
4. Et la gateway détecte elle-même les trous côté `payload.seq` par run, et **prévient** :
   `server-chat.ts:1272-1287` émet `{event:"agent", stream:"error", data:{reason:"seq gap",
   expected, received}}`.

**Atrium :** ni l'enveloppe `frame.seq` (`openclaw-client.ts` ne la lit pas), ni `payload.seq`
agent, ni le `stream:"error"` ne sont exploités. **[PROUVÉ]** :
`n.feed(agent stream:"error" {reason:"seq gap"})` → `[]`, zéro événement, zéro trace.

**Le doc actuel se trompe de raison.** `docs/design/protocol-schema-coverage.md:264-268` classe
« `seq` gap-detection absent (low impact) … the transport is an ordered WS/TCP stream ; the
gateway does not reorder on one socket ». C'est vrai pour le **ré-ordonnancement** et faux pour
la **perte** : l'amont *drope* délibérément, et l'ordre TCP n'y change rien.

**Symptôme client :** réponse tronquée / paragraphe manquant, sans aucune anomalie ni trace —
exactement « trames qui arrivent dans le désordre / conflits de trames ». Atténuation partielle
réelle : les deltas de chat portent le snapshot complet (`server-chat.ts:849-851`), donc le TEXTE
se resynchronise ; ce sont les **cartes outil, media, item et lifecycle** (flux `agent`, sans
snapshot cumulatif) qui disparaissent sans trace.

**Note connexe :** une trame **non** `dropIfSlow` (les `chat:final` de
`broadcastChatFinal`, `chat.ts:2758`) sur un consommateur lent fait **fermer le socket**
(`server-broadcast.ts:180-184`, code 1008 « slow consumer »). Atrium classe cela en
`connection_lost` sans jamais nommer la cause. Il lit `policy.maxPayload` du hello-ok
(`openclaw-client.ts:334-340`) mais **pas `policy.maxBufferedBytes`** ni `tickIntervalMs`
(`frames.ts:145-152`).

### 3.2 [HAUT] `lifecycle` : la moitié du terminal est jetée

L'amont émet le terminal lifecycle avec (`…handlers.lifecycle.ts:185-215`) :
`phase`, `error`, **`stopReason`**, **`yielded`**, **`timeoutPhase`**, **`providerStarted`**,
**`aborted`**, `livenessState`, `replayInvalid`, `endedAt`, `startedAt`.

Atrium (`normalizer.ts:1312-1392`) ne lit que `phase` et `livenessState` (+ `data.error`).

Conséquences :

* **`phase:"finishing"`** (`…lifecycle.ts:195-196`, quand `deferTerminalLifecycle` est vrai —
  `auto-reply/reply/agent-runner-execution.ts:2703`, `followup-runner.ts:1355`,
  `agents/agent-command.ts:2250`) : **aucune branche** dans Atrium.
  **[PROUVÉ]** → `[]`, aucune grâce armée, `nextTimeout` reste à 240 s. Le tour ne se referme
  que par le terminal différé (`agent-lifecycle-terminal.ts:70-115`) ou, s'il n'arrive pas, par
  le recv-timeout. La **métadonnée du terminal** (`stopReason`, `yielded`) transportée par
  `finishing` est perdue définitivement — l'amont, lui, la mémorise
  (`agent-lifecycle-terminal.ts:56-68`, `DEFERRED_TERMINAL_METADATA_KEYS`).
* **`data.yielded === true`** est le signal *explicite* du hand-off. Atrium déduit la même
  chose par **heuristique** : `turn-sink.ts:715-720` regarde un `tool.status`
  `name==="sessions_yield" && phase==="completed"`. C'est exactement le motif « heuristique là où
  un signal explicite existe ». Pire, la même heuristique est cassée par §3.3 (une phase
  `update` est traduite en `completed`).
* **`data.timeoutPhase`** expliquerait la classe entière des tours « silencieux » observés en
  prod. Ignoré.

### 3.3 [HAUT — PROUVÉ] `stream:"tool"` : toute phase ≠ `start` est traitée comme terminale

`normalizer.ts:1207-1242` : `if (phase === "start") {…} else {…terminal…}`.
Or l'amont émet **`phase:"update"`** pour les résultats partiels
(`…handlers.tools.ts:1191-1201`, `emitDetailedLiveUpdate`), et le frame `phase:"result"` **ne
porte pas `args`** (`…handlers.tools.ts:1489-1502`).

**[PROUVÉ]** (`probe-tool-update.mjs`) :

```
start  → {phase:"start",     toolCallId:"tc1", input:{command:"ls -la /tmp"}}
update → {phase:"completed", toolCallId:"tc1", input:{command:"ls -la /tmp"}}   ← faux terminal
result → {phase:"completed", toolCallId:"tc1", output:{aggregated:"done"}}      ← input DISPARU
```

Effets :
1. **Carte outil marquée « terminée » alors que l'outil tourne encore** (symptôme visible).
2. `this.toolArgs.delete(toolCallId)` (`normalizer.ts:1225`) au premier `update` : les
   arguments sont consommés trop tôt. Le patch Convex `{...row.part, ...part}`
   (`convex/stream.ts:1211-1218`) les préserve *par chance* ; toute évolution vers un
   remplacement de part les perdrait.
3. `toolCallCount` (`turn-sink.ts:679-690`) est **incrémenté à chaque update** → le compteur
   `toolCalls` de la trace `gateway_pressure` est faux (diagnostic corrompu, or c'est
   précisément l'instrument utilisé pour les enquêtes overflow).
4. Les portes `spawnCalledThisTurn` et `yieldCalledThisTurn` (`turn-sink.ts:692-720`) gatent sur
   `phase === "completed"` **précisément pour ne pas rider un appel échoué**. Un `update`
   traduit en `completed` défait l'invariant.
5. `data.partialResult`, `data.meta`, `data.toolErrorSummary`, `data.hideFromChannelProgress`
   ne sont jamais lus.

### 3.4 [MOYEN] `stream:"assistant"` : `phase`/`itemId`/`replace` ignorés

`normalizer.ts:1052-1067` lit `data.text` / `data.delta` sans regarder `data.phase`.
L'amont émet du **commentaire** (préambule de raisonnement) sur le même flux, marqué
`phase:"commentary"` et distingué par `itemId` :
`…handlers.messages.ts:682` (`{text, replace:true, phase:"commentary"}`) et
`:802-810` (`{delta: chunk, phase:"commentary", itemId}`).

* Un `{text: commentary, replace:true}` passe par `applyVisible(isSnapshot=true)` → `this.text`
  = le commentaire ET **`hasSnapshot = true`**. À partir de là, `applyVisible` ignore
  définitivement tous les deltas (`normalizer.ts:1429-1431`). Si la réponse finale arrive en
  deltas purs, **la réponse affichée serait le commentaire**.
* Le chemin nominal (`…messages.ts:985-990`, `{text: cleanedText, delta, replace}`) porte un
  `text` snapshot qui écrase, donc le cas converge en pratique.
* **NON PROUVÉ** : je n'ai pas de fixture qui ordonne `commentary(text,replace)` puis
  `final(delta seul)`. Pour trancher : capturer un tour GPT-5 avec préambule via
  `BRIDGE_FRAME_DUMP=commentary` et vérifier la séquence des `data.phase` du flux `assistant`.
* `data.replace` du flux assistant n'est **jamais** honoré côté delta (contrairement au chemin
  chat, `normalizer.ts:1003-1007`).

### 3.5 [HAUT — PROUVÉ] Contamination inter-run pendant la fenêtre de compaction

`normalizer.ts:737-746` : un `runId` étranger est **adopté** dans `ownRunIds` si
`deadlines.has("lifecycle_end")` (10 s) **ou `compactionPending`** — et `compactionPending`
ouvre une fenêtre de **900 s** (`COMPACTION_RECV_TIMEOUT`, `normalizer.ts:81`).

Le `RunManager` ne détourne que trois familles de runs (`run-manager.ts:747-765`) :
`announce:`, livraison de tâche, consult talk. **Tout autre run** (un second `chat.send` depuis
la Control UI sur la même session, un run de follow-up, un run heartbeat routé sur la même clé)
traverse jusqu'au normalizer.

**[PROUVÉ]** (`probe2.mjs`, cas E) — après un `compaction phase:"start"`, un
`chat:final{runId:"heartbeat-run-42"}` produit :

```
message.snapshot "réponse d'un AUTRE run"
message.final    "réponse d'un AUTRE run"
run.status final runId=heartbeat-run-42
```

→ **la réponse d'un autre run devient la réponse de l'utilisateur et clôt son tour.**
Symptôme client : « réponse qui n'a rien à voir avec ma question » — le pire des bugs listés.

Le commentaire de code justifie l'adoption par « un follow-on / replay légitime », ce qui est
vrai pour la grâce `lifecycle_end` de 10 s, mais l'extension à 900 s de compaction n'a aucun
garde-fou : ni corrélation par `sessionId`, ni par famille de runId, ni exigence que le run
adopté soit le *replay* du run courant.

### 3.6 [MOYEN] Compaction : `completed:false` silencieux

L'amont émet `{phase:"end", willRetry, completed: hasResult && !wasAborted}`
(`…handlers.compaction.ts:152-160`). Atrium ne lit que `willRetry`
(`normalizer.ts:1297-1308`). **[PROUVÉ]** : `{phase:"end", willRetry:false, completed:false}` →
`[]` événements, `compactionPending` repasse à `false`.

Une compaction **échouée** est donc traitée comme une compaction réussie : budget de silence
ramené à 240 s, aucun marqueur, aucune trace. La session reste sur-remplie → le tour suivant
part en overflow, et le diagnostic de la cause a été effacé. C'est exactement la classe
« erreurs de contexte dépassé » signalée par les clients.

L'amont n'émet pas non plus `reason` (`manual`/`threshold`/`overflow`) sur le fil — il est
seulement loggé (`…compaction.ts:35-43`). Donc Atrium ne peut pas distinguer une compaction
subie (overflow) d'une compaction de seuil. **Écart de contrat amont**, à remonter.

### 3.7 [HAUT] `sink.apply()` n'est pas atomique et son échec est avalé

* `turn-sink.ts:489-501` : boucle séquentielle avec `await` par événement. Un throw sur
  n'importe quel écrivain (`addProvenancePart`, `addCronPart`, `addPlanPart`, `finalize`)
  **abandonne le reste du lot**.
* `convex-writer.ts:902-938` (`doPost`) : timeout, puis `throw`. **Zéro retry.**
* `turn-sink.ts:1066-1078` (`flushFinal`) met `turnActive = false` **avant** l'appel, puis
  `flushFinalInner` fait le `writer.finalize()`.
* `session.ts:547-551` : `catch (err) { console.error("session feed error:", …) }` — log, on
  continue.

**Chaîne complète du défaut** : un hoquet HTTP unique sur le `finalize` ⇒ le tour est mort côté
bridge (`normalizer.finalized = true`, `sink.active = false`) mais le message Convex reste
`streaming`. Aucun chemin ne réessaie. L'utilisateur voit « Génération… » jusqu'au watchdog
12 min, puis `stream_orphaned`.

* `turn-sink.ts:496-499` : `return` (et non `continue`) quand `messageId === null` — le reste du
  lot est jeté sans log.

### 3.8 [MOYEN — PROUVÉ] Les demandes d'approbation bloquent le run en silence

`stream:"approval"` (`infra/agent-events.ts:525-533`) et l'événement d'enveloppe
`exec.approval.requested` (`server-broadcast.ts:30`) signalent qu'un run **attend une décision
humaine**. **[PROUVÉ]** : Atrium renvoie `[]` et `nextTimeout` reste à 240 s.

Séquence utilisateur : le tour reste silencieux 240 s → `recvSilence` → orphan recovery
(`session.ts:634-661`) → poll de transcript infructueux → `response_timeout`. L'utilisateur ne
saura jamais qu'une approbation était demandée. Aggravation : Atrium n'a **aucun** chemin pour
répondre (`exec.approval.resolve`), donc le run reste bloqué côté gateway.

### 3.9 [MOYEN] Un upload media qui pend gèle le finalize sans borne

`convex-writer.ts:1507-1530` (`streamToUploadUrl`) n'a **ni `AbortController` ni timeout**,
contrairement à `doPost` (`convex-writer.ts:902-912`). Il est appelé depuis `addMedia`
(`convex-writer.ts:1410`), lui-même dans le `mediaChain` (`turn-sink.ts:868-888`).
`flushFinalInner` fait `await this.mediaChain` **sans timeout** (`turn-sink.ts:1147`).

Un upload qui pend ⇒ le `finalize` n'est jamais posté, `finalizeInFlight` reste `true` pour
toujours ⇒ (a) le message reste `streaming` jusqu'au watchdog, (b) `run-manager.ts:462-471`
stashe **tous** les announces à jamais (`flushPendingAnnounce` early-return sur
`sink.finalizing`, `run-manager.ts:624-631`) → les rapports de sous-agents sont perdus jusqu'à
la troncature à 5000 trames.

### 3.10 [BAS] Le manifeste de couverture affirme un traitement inexistant

`bridge/protocol/openclaw/coverage.json`, `AgentEvent.seq` :
`{"status":"handled","by":"frame dedup/tally; no gap detection (ordered WS)"}`.
Or `tallyFrame` (`run-manager.ts:143-149`) ne met pas `seq` dans sa clé, et la dedup
(`normalizer.ts:872-879`) ne s'applique qu'aux trames `chat`. Le `seq` **agent** n'est lu nulle
part. Un champ classé `handled` sur une preuve fausse est plus dangereux qu'un `gap` déclaré.

Deuxième point : `AgentEvent.data` est classé `handled` **en un seul verdict**. Le schéma amont
le type `Record<String, Unknown>` (`agent.ts:66`), donc le ratchet
(`test/protocol-coverage.test.ts`) ne peut pas descendre dedans. **Tout le vocabulaire
sémantique dont Atrium dépend est hors ratchet** — c'est la raison structurelle pour laquelle
§3.2/§3.3/§3.6 ont pu passer.

Troisième point : `DRIFT_VENDORED_VERSION = "2026.6.11"` (`protocol-drift.ts:24`) alors que la
version validée est 2026.7.1 ; les schémas vendorés sont ceux de 6.11
(`bridge/protocol/openclaw/2026.6.11/`), et `frames.ts` (l'enveloppe, donc `seq`) **n'est pas
vendoré du tout** (`agent.ts`, `client-info.ts`, `logs-chat.ts`, `primitives.ts`,
`secret-ref-contract.ts` seulement).

---

## 4. Inventaire des buffers et états en mémoire

| Buffer | Emplacement | Borne | Qui le vide | Si le vidage n'arrive jamais |
|---|---|---|---|---|
| `pendingFrames` | `run-manager.ts:72` | 1000 | `beginTurn` (407-415) / `disarmReplayBuffer` (266) | armé/désarmé par `server.ts:1053`+`1092` (try/catch complet) — **OK** |
| `pendingProvenance` | `run-manager.ts:65` | `MAX_PROVENANCE_PARTS_PER_TURN` | `beginTurn` (396-402) | borné, purgé au tour suivant — OK |
| `pendingAnnounce` | `run-manager.ts:86` | 5000, dépassement **loggé** (658-673) | `flushPendingAnnounce` (623) sur feed/tick sink inactif | **bloqué** si `sink.finalizing` reste vrai (§3.9) ou si `replayArmed` reste armé → rapports tronqués |
| `spontaneousReplayCopy` | `run-manager.ts:103` | 5000 | ouverture du message différé (644-654) / `beginTurn` (374) | OK |
| `handledAnnounceRuns` + `…Order` | `run-manager.ts:90-91` | FIFO 100 (685-692) | rotation FIFO | OK |
| `frameTally` / `frameSampled` | `run-manager.ts:56-57` | non borné **intra-tour** | `beginTurn` (382-384) | cardinalité de formes faible — risque théorique |
| `toolArgs` | `normalizer.ts:495` | **non borné intra-tour** | 1ère phase ≠ start (1225) / `beginTurn` (548) | un tour à N milliers de `tool:start` sans résultat accumule N entrées ; un outil qui ne rend jamais fuit jusqu'au tour suivant |
| `mediaPaths` | `normalizer.ts:435` | **non borné intra-tour** | `beginTurn` (539), `resetForCompaction` (1681) | idem |
| `observedChildKeys` | `normalizer.ts:452` | **non borné intra-tour** | `beginTurn` (543) | idem |
| `deadlines` | `normalizer.ts:499` | 4 clés max | `tick`/`finalize` (1574) | OK |
| `deferredEvents` | `turn-sink.ts:277` | 500 (538, 551) | `tryOpenDeferred` (584-600) / `resetDeferred` | **dépassement silencieux** (pas de log, contrairement à `pendingAnnounce`) |
| `turnArtifactChunks` | `turn-sink.ts:258` | 512 KiB (1029) | `flushFinalInner` (1113-1114) | OK |
| `hostedThisTurn`, `spawnedChildKeysThisTurn` | `turn-sink.ts:127,170` | non bornés intra-tour | `beginTurn` (390,399) | OK en pratique |
| `mediaChain` | `turn-sink.ts:135` | chaîne de promesses | `await` dans `flushFinalInner` (1147) | **DEADLOCK sans borne** (§3.9) |
| `pendingDelta`/`chains`/`confirmedText`… | `convex-writer.ts:880-900` | 1 entrée / message | `forgetMessage` dans le `finally` de `finalize` | OK (le `finally` couvre l'échec — commentaire `convex-writer.ts:1559-1566`) |
| Observer : `observations`, `recentlyFinal`, `pendingSpawnConfig`, `resolvedSpawnCalls`, `pendingItemSpawns` | `sub-agent-observer.ts:188-197`, `1083-1108` | 64 / TTL 15 min / TTL 180 s / cap 64 / cap 64 | sweep TTL (`session.ts:669`) | **bornés et testés — pas de risque** |
| `protocolDrift.counters` | `protocol-drift.ts:159` | 100 formes, dépassement loggé | jamais (par design, per-build) | OK |

---

## 5. Zones où une trame inattendue produit une erreur visible utilisateur

| Déclencheur | Chemin | Ce que voit l'utilisateur |
|---|---|---|
| `chat.side_result` + final vide | D7 jette, `normalizer.ts:1013-1019` arme la grâce, `turn-sink.ts:1286-1300` | 90 s d'attente puis **« L'agent a terminé le tour sans produire de réponse »** alors que la réponse existait |
| Demande d'approbation exec | `stream:"approval"` jeté (§3.8) | 240 s de « Réflexion… », puis `querying_gateway`, puis **`response_timeout`** |
| Trame droppée par `dropIfSlow` sur le flux `agent` | §3.1 | carte outil / media **manquante**, aucune anomalie levée |
| `chat:final` non-droppable sur consommateur lent | `server-broadcast.ts:180-184` ferme le socket | **`connection_lost`** sans cause nommée |
| Run étranger pendant une compaction | §3.5 | **réponse d'une autre conversation/run** dans le fil |
| Échec HTTP unique sur `finalize` | §3.7 | 12 min de « Génération… » puis **`stream_orphaned`** |
| Upload media qui pend | §3.9 | idem + tous les rapports de sous-agents bloqués |
| Compaction échouée (`completed:false`) | §3.6 | tour suivant en **overflow de contexte** sans explication |
| `lifecycle phase:"finishing"` sans terminal différé | §3.2 | 240 s de silence puis fermeture par timeout |
| Outil long à résultats partiels | §3.3 | carte outil **« terminée » prématurément**, compteur d'outils faux dans la trace |

---

## 6. Ce qui est solide (à ne pas casser)

* **Isolation** : double barrière `sessionKey` (`multiplex.ts:83-108` + `normalizer.ts:733-735`),
  admission sous-agent par `spawnedBy` qui **retourne** avant l'état de run parent
  (`normalizer.ts:717-730`). Testée, commentée, correcte.
* **Précédence texte** : snapshot > delta > ack privé, avec le `replace` chat honoré sans
  verrouiller le mode delta (`normalizer.ts:1003-1007`) — subtilité correcte.
* **Compaction explicite préférée à l'heuristique** (`normalizer.ts:1338-1359`) : le fallback
  `livenessState:"abandoned"` se retire dès qu'un `{stream:"compaction"}` a été vu. C'est le bon
  patron, à généraliser.
* **Deadlines absolues** (jamais des budgets réarmables par une trame quelconque) et horloge
  injectée : le comportement temporel est déterministe et testable.
* **Sous-agent observer** : tous les états sont bornés + TTL + sweep piloté par `minTimeout`.
* **`protocolDrift`** : observe-only, borné, SOC2-propre (noms de champs uniquement). Bonne base
  pour y brancher la détection de trous de `seq` (§3.1).

---

## 7. Questions ouvertes / à trancher par lecture ou capture

1. `chat.side_result` : la branche `!agentRunStarted` (`chat.ts:4960`) est-elle atteignable
   depuis un `chat.send` Atrium (commande slash tapée par un utilisateur) ? → capturer avec
   `BRIDGE_FRAME_DUMP=side_result`.
2. Ordre réel `commentary` vs réponse finale sur le flux `assistant` (§3.4) → capture GPT-5.
3. Familles de runId réellement observables sur une même `sessionKey` en prod (§3.5) → interroger
   `list_traces` / `query_openclaw` sur les `runId` non-`announce:` adoptés.
4. Fréquence réelle des drops `dropIfSlow` sur le déploiement client → nécessite la détection
   de trous de `seq` (donc la correction elle-même est l'instrument de mesure).
