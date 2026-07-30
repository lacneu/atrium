# 06 — Ordre des trames, concurrence, conflits de session

Zone : défaillance #2 (une livraison de sous-agent tue le tour utilisateur et
inversement, réponses vides, bulles bloquées en « Génération… », conflits de
verrou de session).

Sources lues :

| Rôle | Chemin | Version |
|---|---|---|
| Amont OpenClaw | `<scratch>` | tag `v2026.7.1` (`2d2ddc43`) |
| Atrium | `<workspace>/atrium` | `main` @ `ed7bf5d` |

Convention : `$UP/…` = chemin dans le tag amont. Les chemins Atrium sont
relatifs à la racine du dépôt. Toute affirmation non prouvée est marquée
**NON PROUVÉ** avec la lecture qui permettrait de trancher.

---

## 0. Verdict

L'ordre **par connexion** est solide de bout en bout : l'amont émet ses
événements de façon **synchrone** sur un bus in-process, le broadcast WS est
synchrone, le bridge draine la socket dans une file FIFO et la boucle de
consommation applique une trame à la fois. Rien ne réordonne les trames
**en transit**.

Les défauts d'ordre d'Atrium ne viennent donc **pas du réseau** mais de
**tâches asynchrones internes qui écrivent dans le même `TurnSink` en
parallèle de la boucle de consommation**, sans sérialisation ni garde de
génération. Le chemin Hermes possède exactement cette sérialisation
(`ws-turn.ts:259-265` : une chaîne `chain` autour de `sink.apply`) ; le chemin
OpenClaw ne l'a pas. C'est l'asymétrie centrale de ce rapport.

Second défaut structurel : Atrium **n'utilise aucun des deux compteurs `seq`
du protocole** — ni pour l'ordre, ni pour la détection de perte — et **ignore
silencieusement** la trame par laquelle le gateway déclare lui-même une perte
(`agent {stream:"error", data:{reason:"seq gap"}}`). Le système n'a donc
aucun moyen de savoir qu'il a perdu une trame.

---

## 1. Invariants amont RÉELS (prouvés)

### 1.1 Il existe DEUX compteurs `seq`, de portées différentes

| Compteur | Où | Portée | Monotone par | Contigu ? |
|---|---|---|---|---|
| `EventFrame.seq` (enveloppe WS) | `$UP/packages/gateway-protocol/src/schema/frames.ts:203` (optionnel) ; attribué en `$UP/src/gateway/server-broadcast.ts:161,189-195` | **par connexion client** (`WeakMap<GatewayWsClient, number>`), tous événements confondus | connexion | **NON** (voir 1.2) |
| `AgentEventPayload.seq` (payload) | `$UP/packages/gateway-protocol/src/schema/agent.ts:60` (**requis**) ; attribué en `$UP/src/infra/agent-events.ts:442-443` (`state.seqByRun`) | **par `runId`** | run | **NON** (voir 1.3) |

`ChatEvent.seq` (les trames `chat`) est une **copie** du `AgentEventPayload.seq`
de l'événement source : `$UP/src/gateway/server-chat.ts:794,843` (delta),
`886,914` (flush), `680` (terminal) — il n'a **pas** de compteur propre.

Conséquence directe : **il n'existe aucun compteur « par session »**. Deux runs
sur la même session ont deux séries `seq` indépendantes qui repartent de 1.

### 1.2 `EventFrame.seq` : les trous sont NORMAUX et volontaires

`server-broadcast.ts:174-179` — quand le client est lent (`bufferedAmount >
MAX_BUFFERED_BYTES`) et que l'événement est marqué `dropIfSlow`, la trame est
**abandonnée mais le `seq` du client est quand même incrémenté** :

```
if (slow && opts?.dropIfSlow) {
  if (!isTargeted) { clientSeq.set(c, nextSeq); }
  continue;
}
```

Pinné par un test amont : `$UP/src/gateway/gateway-misc.test.ts:593`
« preserves seq gaps when dropIfSlow skips an eligible broadcast ».

De plus, un broadcast **ciblé** (`broadcastToConnIds`) part **sans `seq` du
tout** (`server-broadcast.ts:189` : `const eventSeq = isTargeted ? undefined :
nextSeq;`). Or plusieurs événements de chat/session passent par ce chemin
(`server-chat.ts:950,1038`, `server-session-events.ts:233,256,300`).

Donc : `EventFrame.seq` **détecte une perte** (un trou = au moins une trame
droppée), mais un trou **ne prouve pas un désordre** et l'absence de `seq` ne
prouve rien.

Si l'événement n'est **pas** `dropIfSlow` et que le client est lent, la
gateway **ferme la socket** avec le code `1008 "slow consumer"`
(`server-broadcast.ts:180-186`), plafond `MAX_BUFFERED_BYTES = 50 MiB`
(`$UP/src/gateway/server-constants.ts:4`).

Sont marqués `dropIfSlow` (donc perdables) : les deltas de chat
(`server-chat.ts:854-857, 927-930`), les événements `agent` vers les
destinataires ciblés (`1038`), `session.tool` (`1371`), `sessions.changed`
(`1522`), `session.message` (`server-session-events.ts:233,256,300`),
`chat.send_timing` (`576`).

### 1.3 `AgentEventPayload.seq` : monotone strict par run, mais NON contigu

`enrichAgentEvent` (`$UP/src/infra/agent-events.ts:424-484`) :

- les événements supprimés par une génération de cycle de vie obsolète sont
  rejetés **avant** l'incrément (lignes 432-441 puis 442) → une suppression
  **ne consomme pas** de `seq` ;
- `emitAgentAuditEvent` (`495-507`) **consomme le même compteur `seqByRun`**
  mais ne notifie que `state.auditListeners`, **pas** `state.listeners` (le
  bus public que le gateway écoute). Appelé réellement :
  `$UP/src/agents/command/attempt-execution.ts:926,1288,1322`
  (`params.auditOnly ? emitAgentAuditEvent : emitAgentEvent`).

⇒ **Le flux public a des trous de `seq` par construction.** Un client qui
exigerait la contiguïté produirait des faux positifs.

Le gateway lui-même le sait et le signale quand même :
`$UP/src/gateway/server-chat.ts:1272-1287` diffuse une trame **synthétique**

```
agent { runId, stream: "error", ts, sessionKey, data: { reason: "seq gap",
        expected: last+1, received: evt.seq } }
```

Pinné amont : `$UP/src/gateway/server-chat.agent-events.test.ts:4623-4662`.

### 1.4 Ordre de livraison : FIFO par connexion, garanti par construction

- `notifyListeners` est un simple `for … listener(event)` **synchrone**
  (`$UP/src/shared/listeners.ts:1-14`) ;
- `emitAgentEvent` (`agent-events.ts:487-492`) attribue le `seq` puis notifie
  **immédiatement** ;
- `broadcastInternal` (`server-broadcast.ts:154-200`) sérialise et `send()`
  dans la même pile.

⇒ **L'ordre d'émission par run est préservé sur une connexion donnée** (TCP
FIFO). Il n'y a **aucune réordonnance en transit**. C'est un invariant réel,
mais **implicite** : il n'est déclaré nulle part dans le schéma, il découle du
code.

### 1.5 Les trames de deux runs PEUVENT être entrelacées sur la même session

Prouvé structurellement : le broadcast est **par connexion**, filtré seulement
par *scope* d'événement (`server-broadcast.ts:23-56, 72-103`) — jamais par run
ni par session. Rien ne sérialise deux runs vis-à-vis d'un client.

Et deux runs sur la même session existent réellement :

- un `chat.send` pendant un run actif est **steeré** dans le run actif
  (mode par défaut `steer`) ou **mis en file de suivi** exécutée comme un
  **nouveau run** après (`$UP/docs/concepts/queue.md`, section « Queue modes ») ;
- une livraison d'annonce de sous-agent, quand le demandeur est **idle**,
  tourne comme un **run séparé** `announce:v1:<childSessionKey>:<childRunId>`
  (idem doc + `docs/design/upstream-interpretation-comparison.md:104-113`) ;
- les runs de heartbeat sont estampillés `isHeartbeat` sur les trames `agent`
  (`server-chat.ts:1199,1244,1248,1280`) — le champ existe **précisément parce
  que** ces runs coexistent.

### 1.6 Ce que les lanes/queues sérialisent RÉELLEMENT

- `resolveSessionLane(key)` → `session:<key>`
  (`$UP/src/agents/embedded-agent-runner/lanes.ts:6-10`), utilisée par
  `runEmbeddedAgentInternal` (`$UP/src/agents/embedded-agent-runner/run.ts:669`).
- Concurrence par défaut d'une lane non configurée = **1**
  (`$UP/src/process/command-queue.ts:196`). Lanes globales : `main` (défaut),
  `cron`, `cron-nested`, `subagent`, `nested`
  (`$UP/src/process/lanes.ts:1-7`).
- La doc l'affirme : « Per-session lanes guarantee that only one agent run
  touches a given session at a time » (`$UP/docs/concepts/queue.md`).

**Portée réelle : IN-PROCESS uniquement.** La lane est une `Map` en mémoire du
processus gateway. Elle ne protège ni d'un autre processus, ni d'un chemin qui
n'appelle pas `runEmbeddedAgent`. Le vrai garde-fou inter-écrivains est le
**verrou de fichier de session** — et c'est lui qui tue (1.7).

### 1.7 Conflit de session : qui meurt, et est-ce déterministe ?

Non. Le mécanisme est une **clôture (fence) par empreinte de fichier**, pas une
politique de préemption.

- Pendant la génération, le runner **relâche** le verrou du fichier de session,
  puis le reprend et **revérifie l'empreinte** (`dev/ino/size/mtimeNs/ctimeNs`)
  dans `assertSessionFileFence`
  (`$UP/src/agents/embedded-agent-runner/run/attempt.session-lock.ts:1419-1524`).
- Si le changement ne s'explique pas (réconciliation des écritures possédées,
  dérive de `ctime` bénigne, fusion des entrées ajoutées — toutes tentées
  d'abord), il lève
  `EmbeddedAttemptSessionTakeoverError`
  (`attempt.session-lock.ts:1147-1151`, jetée aux lignes `1291, 1322, 1442,
  1462, 1508, 1524, 1574, 1773, 1827, 1889`).
- **Le run qui meurt est celui qui DÉTECTE le changement**, c'est-à-dire celui
  qui avait relâché le verrou — donc, le plus souvent, le run **le plus
  ancien**. Mais un mid-turn takeover est possible aussi
  (`withSessionWriteLock` revérifie la fence entre deux étapes d'un tour
  multi-outils). **Les deux directions de la course sont possibles**, selon le
  timing. C'est cohérent avec la conclusion déjà écrite dans
  `docs/design/upstream-interpretation-comparison.md:117-128`.
- Le second mécanisme, distinct, est `reply session initialization conflicted`
  (perte OCC pré-génération, `$UP/src/auto-reply/reply/session.ts`) : rien n'a
  été généré, tout le tour meurt.
- **Il n'existe AUCUNE politique amont « un run par session »** : les kills
  observés en prod sont **émergents**.

### 1.8 Ce qui est visible sur le fil quand un run meurt

- run tué : `chat {state:"aborted", stopReason, message?}` + lifecycle
  `{phase:"end", status:"cancelled", aborted:true}` ;
- run `controlUiVisible:false` : tué **sans aucun broadcast**
  (`$UP/src/gateway/chat-abort.ts:528`) ;
- admission en file de suivi : **invisible** (pas d'ack `status:"queued"`) ;
- steering : **rien** à l'injection.

---

## 2. Hypothèses d'ordre côté Atrium — garanties ou seulement observées ?

| # | Hypothèse dans le code Atrium | Preuve Atrium | Garantie amont ? |
|---|---|---|---|
| H1 | Les trames arrivent dans l'ordre d'émission | boucle unique `consume()` `bridge/src/session.ts:429-535` ; file FIFO `bridge/src/providers/openclaw/openclaw-client.ts:178,405-412,442-458` | **OUI** (§1.4) — mais par *connexion*, pas par run/session |
| H2 | Une seule tâche écrit dans le `TurnSink` | *aucune* — `TurnSink.apply` (`bridge/src/core/turn-sink.ts:489-501`) n'a **ni chaîne ni verrou** | **NON APPLICABLE** : c'est une hypothèse interne, **violée** par Atrium lui-même (§3.1, §3.2) |
| H3 | Un `snapshot` remplace tout le texte ; le dernier gagne | `normalizer.ts:1424-1425` (`this.text = candidate`) ; `turn-sink.ts:659-672` (`setSnapshot`) | **OUI si l'ordre tient** ; les deltas droppés sont auto-réparés car le gateway joint **toujours** le texte cumulé dans `payload.message` (`$UP/src/gateway/server-chat.ts:850-856, 900-906`) — bonne propriété, non documentée côté Atrium |
| H4 | `payload.seq` sert uniquement de clé de déduplication | `normalizer.ts:869-883` | **Choix délibéré**, correct : `seq` **n'est pas contigu** (§1.3), donc inutilisable comme détecteur de perte tel quel |
| H5 | Un `runId` inconnu sur ma session pendant la grâce `lifecycle_end` (10 s) ou une compaction est un **follow-on légitime** de mon tour | `normalizer.ts:737-743` | **NON GARANTI** — l'amont ne fournit aucune preuve de filiation ; c'est une heuristique temporelle (§3.4) |
| H6 | Les runs d'annonce/livraison sont reconnaissables par préfixe de `runId` | `run-manager.ts:747-765` (`announce:`, `<tool>:<taskId>:ok`, `talk-…`) | **Vrai pour les familles connues** (`$UP/src/agents/announce-idempotency.ts:11-18`) ; **toute nouvelle famille amont retombe dans H5** |
| H7 | Premier terminal gagne, la génération protège les écritures tardives | `convex/stream.ts:1523-1544` (garde `expectedRunId` + `message.status !== "streaming"`), `convex/stream.ts:825-835, 1010-1013` | **OUI côté Atrium** (transactions sérialisables Convex) — solide |
| H8 | La file d'envoi Convex garantit un seul tour en vol par chat | `convex/lib/outboxQueue.ts:93-146, 171-200`, `convex/bridge.ts:1045-1057` (`reparkIfBusy`) | **Vrai côté Atrium**, mais **ne contraint pas le gateway** : un run d'annonce démarre côté gateway sans passer par la file (§1.5) |
| H9 | Les écritures d'observation sous-agent peuvent arriver dans le désordre | assumé et **traité** : `convex/subAgents.ts:160-176, 363-380` (garde anti-régression de statut) | OK — c'est le bon patron, à généraliser |
| H10 | Le `turnEpoch` protège tout travail transverse | `run-manager.ts:300-303` ; utilisé par `scheduleOrphanRecovery` (`session.ts:699,737,791`) | **Partiellement** : `recoverDeliveredReply` ne l'utilise **pas** (§3.1) |

---

## 3. Courses restantes (défauts)

### 3.1 `recoverDeliveredReply` n'a AUCUNE garde d'époque → écrase et finalise le tour SUIVANT — **CRITIQUE**

**Preuve.**

- Déclenchement, hors boucle, sans `await` : `bridge/src/session.ts:443-445`
  ```
  if (this.runManager.takeRecoveryRequest()) {
    void this.recoverDeliveredReply();
  }
  ```
- Corps : `bridge/src/session.ts:872-899`. Il `await` un `sessions.get` avec un
  **timeout de 10 s** (`session.ts:874-877`), puis appelle
  `this.runManager.recoverVisibleText(text, this.clock())` (`session.ts:885`).
  **Aucune capture ni vérification de `turnEpoch`.**
- Seule garde en aval : `RunManager.recoverVisibleText`
  (`run-manager.ts:708-716`) teste `if (!this.sink.active) return;` — donc
  « il y a un tour actif », **pas** « c'est le MÊME tour ».
- Et `Normalizer.beginTurn` **remet `finalized = false`** et
  `recoveryAttempted = false` (`normalizer.ts` bloc `beginTurn`, champs
  `this.finalized = false` / `this.recoveryAttempted = false`), donc la garde
  `if (this.finalized …)` de `recoverVisibleText` (`normalizer.ts:1168-1176`)
  ne protège pas non plus.
- L'application est un **snapshot final** : `normalizer.ts:1174`
  `this.applyVisible(text, /*isSnapshot*/ true, /*isFinal*/ true, now, events)`
  → `turn-sink.ts:659-672` `setSnapshot` **puis** `finalize`.

**Scénario reproductible.** Tour A délivre sa réponse par le *message-tool* et
ne laisse qu'un ack privé → `wantsHistoryRecovery` → la boucle lance la
récupération. `PRIVATE_ACK_GRACE = 5.0 s` (`normalizer.ts:91`) mais le
`sessions.get` a **10 s** de budget : la grâce finalise le tour A, l'utilisateur
envoie un nouveau message, le tour B s'ouvre, puis le `sessions.get` répond →
le texte du **tour A** est écrit **en snapshot** sur le message du **tour B**,
qui est **finalisé complet** au passage.

**Symptôme utilisateur.** « Ma nouvelle question a reçu la réponse d'avant », et
la bulle se ferme instantanément.

**Contraste qui prouve l'omission.** `scheduleOrphanRecovery` — la machinerie
jumelle — capture `const boundEpoch = rm.turnEpoch` (`session.ts:699`) et
revalide **avant** et **après** le fetch (`session.ts:737-741`, `791-796`).
`recoverDeliveredReply` a été écrit sans cette garde.

**Aucun test ne le couvre** : `bridge/test/history-recovery.test.ts:171`
teste seulement « no-op after the grace already flushed » (tour finalisé et
*non rouvert*).

**Correctif.** Capturer `turnEpoch` avant le RPC ; après résolution, vérifier
`rm.turnEpoch === boundEpoch && !rm.isFinalized` avant d'appeler
`recoverVisibleText`. Idéalement, passer `expectedEpoch` en argument de
`RunManager.recoverVisibleText` pour que la garde soit **dans** l'objet qui
détient l'état, pas chez l'appelant.

---

### 3.2 `TurnSink.apply` n'est pas sérialisé côté OpenClaw → inversion d'ordre entre le rejeu pré-ack et la boucle live — **ÉLEVÉ**

**Preuve.**

- `TurnSink.apply` (`bridge/src/core/turn-sink.ts:489-501`) est un simple
  `for … await this.applyOne(...)` — **pas de chaîne**.
- Le chemin Hermes, lui, sérialise explicitement :
  `bridge/src/providers/hermes/ws-turn.ts:259-265`
  ```
  let chain: Promise<void> = Promise.resolve();
  const apply = (events) => { chain = chain.then(() => sink.apply(events)); };
  ```
  avec, en commentaire (`ws-turn.ts:288-294`), le raisonnement exact sur le
  réordonnancement des écritures.
- Côté OpenClaw il y a **deux appelants concurrents** :
  1. la boucle `consume()` — `session.ts:544` `await this.runManager.feed(...)` ;
  2. la tâche d'envoi HTTP — `bridge/src/server.ts:1067` `await
     session.runManager.beginTurn(...)`, qui à l'intérieur fait
     `await this.sink.apply(...)` pour la provenance
     (`run-manager.ts:401`) **puis rejoue le tampon pré-ack**
     (`run-manager.ts:407-412`).
- Rien ne sérialise (1) et (2). Or, dans `TurnSink.beginTurn`
  (`turn-sink.ts:353`), `this.turnActive = true` est posé **avant** le retour
  (`turn-sink.ts:435` chemin normal, `418` chemin différé) : dès cet instant, la boucle qui reprend
  la main sur un `await` du rejeu voit `sink.active === true` et applique la
  trame **live** via le chemin actif (`run-manager.ts:588-589`), **avant** que
  les trames plus anciennes du rejeu ne soient consommées.

**Effet.** Un snapshot ancien (rejeu) écrase un snapshot récent (live) —
`normalizer.ts:1425` est *last-wins*. Le texte **régresse** visiblement, les
cartes d'outils s'insèrent au mauvais offset (`turn-sink.ts:733-742` documente
déjà que les offsets ne sont pas rebasés), et un `chat:final` rejoué peut
finaliser le tour sur un état antérieur.

**Correctif.** Introduire, dans `RunManager`, une chaîne d'application unique
(`applyChain = applyChain.then(() => sink.apply(evts))`) traversée par **tous**
les producteurs (feed, tick, rejeu pré-ack, flush announce, recovery), à
l'image exacte du chemin Hermes. C'est une correction structurelle, pas un
patch de cas.

---

### 3.3 Aucun usage du `seq` de trame, et le signal amont de perte est jeté en silence — **ÉLEVÉ (observabilité)**

**Preuve.**

- Le seul `seq` lu par Atrium est `payload.seq`, uniquement dans la clé de
  déduplication : `bridge/src/providers/openclaw/normalizer.ts:869-883`.
  `grep -rn "\bseq\b" bridge/src` ne retourne rien d'autre (hors commentaires
  et l'allowlist de drift `protocol-drift.ts:33,49`).
- `frame.seq` (l'enveloppe) n'est **jamais** lu.
- La trame synthétique `agent {stream:"error", data:{reason:"seq gap", expected,
  received}}` (§1.3) **n'a aucune branche** dans `handleAgent`
  (`normalizer.ts:1038-1136` : branches `assistant`, `compaction`, `tool`,
  `lifecycle`, `item`, provenance — rien pour `error`) : elle sort par le
  `return` implicite, sans événement, sans log, sans trace.

**Conséquence.** Une perte de trame déclarée par le gateway est **invisible**
pour Atrium et pour l'exploitant. Les deltas s'auto-réparent (H3) mais **pas**
les trames `tool`, `item`, `media`, `lifecycle` : une carte d'outil manquante,
un média non attaché ou un `lifecycle:end` perdu (⇒ tour qui pend jusqu'au
timeout `recv`) ne laissent aucune trace exploitable.

**Correctif (respecte SOC2 : aucun contenu conversationnel).**
1. Suivre `frame.seq` par connexion dans `OpenClawConnection` ; à chaque trou,
   émettre une trace `chat.frame_gap` avec `{expected, received, missing}` —
   **compteurs uniquement**.
2. Consommer explicitement `agent.stream === "error" && data.reason === "seq
   gap"` : le convertir en trace `chat.gateway_seq_gap` `{expected, received}`
   et en une **phase** visible (pas en erreur de tour — le gateway continue).
3. Ne **jamais** exiger la contiguïté de `payload.seq` (§1.3 le rendrait
   faux-positif).

---

### 3.4 La fenêtre d'adoption « follow-on » adopte n'importe quel run inconnu de la même session — **ÉLEVÉ**

**Preuve.** `bridge/src/providers/openclaw/normalizer.ts:737-743` :

```
if (isString(frameRunId) && frameRunId && this.ownRunIds.size > 0 && !this.ownRunIds.has(frameRunId)) {
  if (this.deadlines.has("lifecycle_end") || this.compactionPending) {
    this.ownRunIds.add(frameRunId);      // adopté
  } else { return []; }
}
```

La fenêtre `lifecycle_end` dure `LIFECYCLE_END_GRACE = 10.0 s`
(`normalizer.ts:92`) ; la fenêtre compaction dure jusqu'à
`COMPACTION_RECV_TIMEOUT = 900 s` (`normalizer.ts:81`).

L'adoption est **purement temporelle** : aucune preuve de filiation n'est
exigée. Les familles gateway-initiées connues sont interceptées **avant**
(`run-manager.ts:747-765` : `announce:`, `<tool>:<taskId>:ok`, `talk-…`), mais
**toute autre** famille (nouvelle version amont, run de heartbeat, run lancé
par un autre client opérateur sur la même session, reprise post-redémarrage
avec un `runId` neuf) est adoptée.

Une fois adopté, ce run étranger peut :
- **écraser le texte du tour** — un snapshot passe par
  `normalizer.ts:1424-1425` (`this.text = candidate`, *last-wins*) ;
- **effacer le texte du tour** — un `lifecycle:end` avec
  `livenessState:"abandoned"` déclenche `resetForCompaction` et l'émission d'un
  `EVENT_MESSAGE_SNAPSHOT` **vide** (`normalizer.ts:1364-1367`) ;
- **finaliser le tour** — un `chat:final`/`chat:error` du run adopté finalise
  (`normalizer.ts:893-987`).

Atrium dispose pourtant du **discriminant sur le fil** et ne l'utilise pas :
`isHeartbeat` est présent sur les trames `agent`
(`$UP/packages/gateway-protocol/src/schema/agent.ts:64`,
`$UP/src/gateway/server-chat.ts:1244,1248`) mais n'apparaît côté Atrium que
dans l'allowlist de drift (`bridge/src/providers/openclaw/protocol-drift.ts:53`)
— jamais lu.

**Réalisabilité en prod : NON PROUVÉ.** Pour trancher, lire dans les traces
prod la co-occurrence, sur une même `sessionKey`, d'un `runId` non-annonce
arrivant pendant les 10 s post-`lifecycle:end` d'un autre `runId` (le compteur
n'existe pas encore — voir le correctif ci-dessous).

**Correctif.**
1. **Jamais adopter un run porteur de `isHeartbeat: true`** — filtre gratuit,
   sur un champ contractuel.
2. Rendre l'adoption **positive** : n'adopter qu'un run dont la filiation est
   prouvée (même `sessionId`, ou explicitement porté par le contrat), sinon le
   **traiter comme un run étranger** (comportement actuel hors fenêtre) et
   émettre une trace `chat.foreign_run_in_grace` `{grace, adopted:false}`.
3. Interdire à un run **adopté** (non ack) les deux actions destructrices :
   remplacer le texte par un snapshot **plus court**, et émettre le snapshot
   vide de compaction. Un run adopté ne devrait pouvoir qu'**ajouter**.

---

### 3.5 La déduplication `chat` n'a qu'un seul emplacement (dernier vu) — **MOYEN**

`normalizer.ts:436, 880-883` : `lastDedupKey` est un **scalaire**. Seule une
retransmission **immédiatement adjacente** est absorbée. Une séquence
`A, B, A` (retransmission décalée d'un `chat:final` — ce qui arrive quand le
gateway rejoue une entrée dédupliquée `meta:{cached:true}`, cf.
`docs/design/upstream-interpretation-comparison.md:305-317`) **n'est pas**
dédupliquée : le `A` tardif ré-applique son snapshot (retour en arrière du
texte) et peut re-finaliser.

Côté Convex la re-finalisation est absorbée (`stream.ts:1541-1544`, premier
terminal gagne), mais le **snapshot** intermédiaire passe (`appendDelta` /
`setSnapshot` ne sont gardés que par la génération, pas par le contenu).

**Correctif.** Remplacer par un ensemble borné (LRU ~64) de clés vues pour le
tour, ou mieux : n'accepter un snapshot que s'il **étend** le texte courant,
sauf marquage `replace: true` (le champ existe :
`normalizer.ts:1003-1006`).

---

### 3.6 La file de trames entrante du bridge n'est pas bornée — **MOYEN**

`bridge/src/providers/openclaw/openclaw-client.ts:178` :
`private readonly queue: GatewayFrame[] = [];` — alimentée sans plafond par
`push()` (`405-412`), drainée par `frames()` (`442-458`).

La boucle de consommation `await`e des écritures Convex HTTP entre deux
trames (`session.ts:544`). Si Convex ralentit, la file croît **sans borne** en
mémoire du bridge, avec un chat par connexion.

Bonne nouvelle collatérale : parce que la socket est drainée immédiatement, le
`bufferedAmount` côté gateway reste bas — donc **le risque de fermeture
`1008 "slow consumer"` (§1.2) est faible**. Le prix est le risque mémoire.

**NON PROUVÉ** : aucune OOM bridge attribuée à cette file n'est documentée.
Pour trancher : instrumenter `queue.length` (compteur, SOC2-safe) et le
publier dans `bridge_status`.

**Correctif.** Plafonner la file, et sur dépassement **fermer la connexion**
avec un code stable (`inbound_overflow`) plutôt que grossir : la reprise
(transcript recovery) existe déjà et est le chemin sûr.

---

### 3.7 Le flush des annonces réécrit l'horloge de toutes les trames — **FAIBLE**

`run-manager.ts:623-638` : `flushPendingAnnounce(now)` réinjecte chaque trame
avec `now` (l'instant du flush) au lieu de `entry.now` (l'instant d'arrivée),
alors que le stash conserve bien `entry.now` (`run-manager.ts:672`).

Les échéances du normalizer sont armées **relativement** à cette valeur : une
annonce stashée 3 minutes voit toutes ses trames « arriver » au même instant,
ce qui écrase la cadence réelle et peut retarder un `recv` légitime.

**Correctif.** Passer `entry.now` (borné à `now`) plutôt que `now`.

---

### 3.8 Le registre d'annonces déjà traitées est borné à 100 — **FAIBLE**

`run-manager.ts:685-692` : FIFO borné à 100 `runId`. Au-delà, la
retransmission d'une annonce ancienne rouvre un **second** tour spontané et
duplique le rapport. Le garde-fou réel est côté Convex
(`stream.ts:504-530` : rebroadcast d'une annonce déjà fusionnée → puits
silencieux), donc l'impact est limité — mais la borne est un choix de mémoire
présenté comme une garantie.

**Correctif.** Documenter que la garantie anti-duplicat est **Convex**, pas ce
Set ; ou fonder le Set sur le TTL (5 min de fenêtre de déduplication amont,
60 min pour les marqueurs d'abandon — `upstream-interpretation-comparison.md:
299-303`) plutôt que sur un compte.

---

### 3.9 `subAgents.updatedAt` est l'heure d'ARRIVÉE, et sert à départager des ancres — **FAIBLE**

Les écritures d'observation sont *fire-and-forget* (`session.ts:322-325,
331-335`) donc arrivent dans le désordre ; `convex/subAgents.ts:291,320`
estampille `updatedAt: now` **à la réception**. Or le repli « chaîne » du
merge d'annonce trie les ancres candidates par `updatedAt`
(`convex/stream.ts:481-483`). Un réordonnancement peut donc désigner la
mauvaise ancre.

La régression de **statut** est bien protégée (`subAgents.ts:363-372`), mais
pas l'ordre temporel.

**Correctif.** Faire porter au bridge l'horodatage d'**événement**
(`observedAt`) et trier dessus, `updatedAt` restant l'heure d'écriture.

---

## 4. Modèle de correction proposé

Quatre briques, dans cet ordre. Aucune ne demande une évolution du gateway.

### R1 — Un seul chemin d'écriture, sérialisé, par tour (corrige 3.1, 3.2)

`RunManager` expose **une seule** méthode d'application, protégée par une
chaîne de promesses, et **tout** producteur y passe :

```
private applyChain: Promise<void> = Promise.resolve();
private applyOrdered(epoch: number, evts: NormalizedEvent[]): Promise<void> {
  this.applyChain = this.applyChain.then(() =>
    epoch === this.turnEpoch ? this.sink.apply(evts) : undefined);
  return this.applyChain;
}
```

- `feed`, `tick`, le rejeu pré-ack, `flushPendingAnnounce`, `recoverVisibleText`
  et `endTurn` deviennent des appelants de `applyOrdered`.
- Le **contrôle d'époque est dans la chaîne**, pas chez l'appelant : aucune
  tâche transverse ne peut plus toucher un tour qu'elle n'a pas ouvert.
- C'est exactement le patron déjà validé côté Hermes (`ws-turn.ts:259-265`).

### R2 — Le run étranger doit être identifié, pas deviné (corrige 3.4)

- Filtre dur : `isHeartbeat === true` ⇒ jamais adopté.
- Adoption seulement sur preuve : même `sessionId` que le tour, ou famille
  gateway-initiée reconnue (chemin `announceRunIdFor`).
- Un run adopté est **additif seulement** : pas de snapshot raccourcissant, pas
  de snapshot vide de compaction, pas de finalisation.
- Chaque refus produit une trace `chat.foreign_run_rejected` `{reason, grace}`.

### R3 — Rendre la perte de trame OBSERVABLE (corrige 3.3)

- Compteur de `frame.seq` par connexion ⇒ trace `chat.frame_gap {missing}`.
- Consommer la trame amont `seq gap` ⇒ trace `chat.gateway_seq_gap
  {expected, received}` + phase visible « le gateway signale une perte ».
- Ne jamais bloquer un tour sur ces signaux : ce sont des **indicateurs**,
  l'auto-réparation par snapshot reste le mécanisme de correction.
- SOC2 : uniquement des entiers et des codes stables ; **aucun** `deltaText`,
  `message`, ni `errorMessage` dans ces traces.

### R4 — Idempotence par contenu, pas seulement par génération (corrige 3.5)

- `setSnapshot` côté Convex : accepter un snapshot qui **étend** le texte
  courant ; refuser (et tracer `stream.snapshot_regression {oldLen, newLen}`)
  un snapshot **strictement plus court** sauf `replace:true` explicite ou
  compaction explicite.
- C'est le seul verrou qui rend l'affichage **insensible** à un désordre
  résiduel : même si une trame ancienne arrive après une récente, le texte ne
  peut plus reculer.

### Ce qu'il faut inscrire au contrat de protocole (docs/design/protocol-contract.md)

Ces quatre points sont des **invariants amont réels** aujourd'hui non écrits :

1. `EventFrame.seq` : monotone **par connexion**, **avec trous légitimes**,
   **absent** sur les broadcasts ciblés.
2. `AgentEventPayload.seq` : monotone **par `runId`**, **non contigu** sur le
   flux public (événements audit-only + suppressions de génération).
3. Ordre : **FIFO par connexion** garanti par une émission synchrone ; **aucune
   garantie inter-runs**, deux runs de la même session **peuvent** s'entrelacer.
4. Conflit de session : **pas de politique**, une clôture par empreinte de
   fichier ; **le perdant n'est pas déterministe**.

---

## 5. NON PROUVÉ — et comment trancher

| Question | Ce qu'il faut lire / mesurer |
|---|---|
| 3.4 se produit-il réellement en prod ? | Instrumenter R2 (trace `chat.foreign_run_rejected`) puis compter sur 7 jours ; en attendant, aucune trace existante ne porte le `runId` étranger |
| 3.1 s'est-il déjà produit en prod ? | Rechercher dans les traces les couples (message finalisé `complete` sans `chat:final` correspondant) et le log `[recovery] message-tool reply recovered` postérieur au `startAssistant` du message suivant (`session.ts:886`) |
| 3.6 : la file entrante a-t-elle déjà grossi ? | Ajouter `inboundQueueLen` à `bridge_status` (`bridge/src/core/health.ts`) et observer |
| Les runs de heartbeat partagent-ils la `sessionKey` d'un chat Atrium ? | `$UP/src/infra/heartbeat-runner.ts:1562` (`resolveEmbeddedSessionLane(sessionKey)`) — remonter à la construction de ce `sessionKey` et la comparer à `buildOpenClawThreadId` (`convex/bridge.ts:718-724`) |
| Un `chat:final` peut-il être rejoué **non adjacent** ? | `$UP/src/gateway/server-methods/chat.ts` (chemin `meta:{cached:true}`) + capture live d'un re-POST `chat.send` sous la même clé d'idempotence |
| Le schéma vendored (`2026.6.11`) masque-t-il des champs d'ordre en `2026.7.1` ? | `bridge/protocol/openclaw/2026.6.11/` vs `$UP/packages/gateway-protocol/src/schema/` — le `DRIFT_VENDORED_VERSION` est périmé (`protocol-drift.ts:24`) |

---

## 6. Vérification proposée (comment PROUVER chaque correctif)

| Défaut | Preuve exigée |
|---|---|
| 3.1 | Test unitaire bridge : ouvrir le tour A (message-tool + ack privé), déclencher la récupération avec un fetcher qui résout **après** un `beginTurn` du tour B ; assertion : le message du tour B n'a **ni** snapshot **ni** finalize |
| 3.2 | Test unitaire : lancer `beginTurn` avec un tampon pré-ack de 3 snapshots dont le `sink.apply` est ralenti, injecter en parallèle un `feed` live ; assertion : l'ordre des `setSnapshot` reçus par un writer factice est strictement l'ordre d'arrivée |
| 3.3 | Fixture amont : rejouer la trame `agent {stream:"error", reason:"seq gap"}` de `$UP/src/gateway/server-chat.agent-events.test.ts:4655` dans `bridge/test/upstream-frames.test.ts` ; assertion : une trace est émise, le tour n'est **pas** mis en erreur |
| 3.4 | Test unitaire normalizer : armer `lifecycle_end`, injecter une trame `agent` d'un `runId` inconnu avec `isHeartbeat:true` ; assertion : `ownRunIds` inchangé, aucun événement |
| 3.5 | Test unitaire : séquence `final(A) → final(B) → final(A)` ; assertion : le texte final est `B` |
| R4 | Test Convex : `setSnapshot(long)` puis `setSnapshot(court)` sans `replace` ; assertion : `liveText` inchangé + trace de régression |
| Global | Banc live (`<hors-dépôt>/live-bench`) : un tour utilisateur long avec un sous-agent qui annonce pendant la grâce, répété 10×, GO si 10/10 sans texte régressé ni bulle figée |
