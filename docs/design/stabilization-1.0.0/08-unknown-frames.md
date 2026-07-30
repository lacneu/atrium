# Zone 08 — Auto-découverte des trames non traitées

Rapport factuel. Toute affirmation porte un `fichier:ligne`. Ce qui n'est pas prouvé
est marqué **NON PROUVÉ** avec la lecture à faire pour trancher.

Périmètre lu :
- Atrium `bridge/src/`, `convex/`, `docs/design/`, `src/chat/admin/` (lecture seule).
- OpenClaw amont `@v2026.7.1` : `<scratch>/upstream/openclaw`
  (`git describe --tags` → `v2026.7.1`, HEAD `2d2ddc43`).
- Hermes amont `@v0.19.0` : `/tmp/hermes-upstream.okb8T2`
  (HEAD `3ef6bbd chore: release v0.19.0 (2026.7.20)`, tag `v2026.7.20`).
- Sonde live : `mcp__atrium-dev__get_compat` (dev), exécutée pendant l'analyse.

---

## 0. Verdict

Le détecteur de drift existant répond à **une seule** question : « le gateway
met-il un NOM DE CHAMP que je ne connais pas au premier niveau du payload d'un
event `chat` ou `agent` ? ». Il ne répond à **aucune** des autres :

| Question opérateur | Répondue aujourd'hui ? |
|---|---|
| Le gateway émet-il un **type d'event** que je ne traite pas ? | NON (`protocol-drift.ts:169-175`) |
| Le gateway émet-il un **`stream`** que je ne traite pas ? | NON (`normalizer.ts:1125-1137`) |
| Un champ **imbriqué** (`data.*`) est-il inconnu ? | NON (`protocol-drift.ts:178`) |
| Une trame a-t-elle fait **jeter** le normalizer ? | NON (`session.ts:549-551` : `console.error` seul) |
| Une trame a-t-elle été **perdue en transit** (drop gateway) ? | NON (aucune lecture du `seq` d'enveloppe) |
| Quelle **version de gateway** a émis la trame inconnue ? | NON (singleton process, `protocol-drift.ts:221`) |
| Quel **provider** ? | NON — Hermes n'a **aucun** détecteur |
| Le signal **survit-il** à un redémarrage du bridge ? | NON (état RAM, exposé en PULL) |

Et le fond du problème est amont, prouvé : le schéma OpenClaw **n'est pas
autoritaire** sur ce qui est émis. `AgentEventSchema` déclare
`additionalProperties: false` (`packages/gateway-protocol/src/schema/agent.ts:57-67`)
alors que le gateway diffuse le payload **sans aucune validation de sortie**
(`src/gateway/server-broadcast.ts:189-197` : sérialisation directe, zéro
`Value.Check`). C'est la raison structurelle pour laquelle Atrium a dû ajouter à
la main 20+ champs « observés live » dans `KNOWN_AGENT_FIELDS`
(`protocol-drift.ts:60-130`). L'auto-découverte n'est donc pas un confort : c'est
la **seule** source de vérité disponible.

---

## 1. État des lieux — ce que fait exactement le détecteur de drift

### 1.1 Ce qu'il fait

`bridge/src/providers/openclaw/protocol-drift.ts`

| Aspect | Réalité | Preuve |
|---|---|---|
| Portée | `frame.type === "event"` ET `frame.event ∈ {chat, agent}` | `:167-175` |
| Granularité | clés **de premier niveau** de `payload` uniquement | `:178` (`Object.keys(payload)`) |
| Signal émis | `` `${event}.${key}` `` + compteur | `:180`, `:149-153` |
| Journal | 1 ligne `console.log` par shape **nouvelle** | `:193-195` |
| Borne | 100 shapes max, puis 1 `console.error` unique | `:156`, `:183-190` |
| Cycle de vie | singleton **process**, RAM, jamais persisté | `:221` |
| Restitution | pull `GET /capabilities` → champ `protocol.drift` | `server.ts:2046-2054` |
| Sécurité SOC2 | conforme : noms de champs seulement, jamais de valeur | `:9-11`, vérifié `:180` |
| Non-gating | jamais de rejet/mutation de trame | `:6-7`, `run-manager.ts:437` |

Le chaînage statique est solide et mérite d'être conservé tel quel :
`schéma TypeBox vendored ↔ coverage.json ↔ KNOWN_*_FIELDS`, ratcheté par
`bridge/test/protocol-coverage.test.ts` (décrit `protocol-drift.ts:12-17`,
`docs/design/protocol-contract.md:37-70`).

### 1.2 Ce qu'il ne fait pas — angles morts prouvés

**(A) Un event de TYPE inconnu est invisible.**
`protocol-drift.ts:169-175` : si `f.event` n'est ni `"chat"` ni `"agent"`,
`known === null` → `return`. Aucun compteur.

Or l'amont déclare **33** noms d'events diffusables
(`src/gateway/server-methods-list.ts:39-68`) :

```
connect.challenge, agent, chat, session.message, session.operation, session.tool,
sessions.changed, presence, tick, talk.mode, talk.event, shutdown, health,
heartbeat, cron, task, node.pair.requested, node.pair.resolved,
node.invoke.request, device.pair.requested, device.pair.resolved,
voicewake.changed, voicewake.routing.changed, exec.approval.requested,
exec.approval.resolved, plugin.approval.requested, plugin.approval.resolved,
terminal.data, terminal.exit, update.available
```

Recherche exhaustive dans `bridge/src/` (littéraux) : `session.message` 0,
`session.operation` 0, `session.tool` 0, `sessions.changed` 0, `shutdown` 0,
`exec.approval.*` 0, `plugin.approval.*` 0, `update.available` 0, `talk.event` 0,
`presence` 0, `tick` 0, `health` 0.
→ **31 des 33 types d'events sont ni consommés, ni comptés, ni visibles.**
Le normalizer les jette en amont du drift : `normalizer.ts:697-702`.

Nuance honnête : la plupart de ces events sont **hors périmètre légitime**
(terminal, device pairing, voicewake). La distinction (d) « ignoré volontairement »
vs (e) « perdu » n'est **aujourd'hui pas exprimable** : rien dans le code ne
déclare « je vois `exec.approval.requested` et je choisis de l'ignorer ». C'est
exactement la lacune que l'auto-découverte doit combler.

**(B) La valeur de `stream` n'est jamais auditée.**
Le contrat amont ne l'énumère même pas : `stream: NonEmptyString`
(`packages/gateway-protocol/src/schema/agent.ts:61`). Côté Atrium,
`handleAgent` teste `assistant`/`compaction`/`tool`/`lifecycle`/`item` puis
`isProvenanceStream(stream)` et, sinon, **tombe en fin de fonction sans rien
faire** (`normalizer.ts:1042-1137`). Un `stream` nouveau = silence total.
`data` est lui aussi totalement ouvert : `data: Type.Record(Type.String(), Type.Unknown())`
(`agent.ts:64`) — le drift ne regarde jamais dedans (`protocol-drift.ts:178`).

**(C) Le `catch {}` du détecteur est muet.**
`protocol-drift.ts:201-203` : commentaire « observe-only », mais un payload
hostile (getter qui jette, proxy) est avalé **sans compteur**. Le détecteur
lui-même n'a aucun compteur d'auto-échec.

**(D) Le débordement de borne n'est pas remonté.**
`protocol-drift.ts:183-190` : au 101ᵉ shape, un `console.error` unique — jamais
dans `protocol.drift`, donc **jamais visible** dans `get_compat` ni dans le badge
Bridge (`src/chat/admin/BridgeTab.tsx:497-530`). Un gateway très divergent
« déborde en silence » exactement quand le signal serait le plus utile.

**(E) Aucune dimension version / provider / instance.**
`protocol-drift.ts:221` : singleton process. Or le bridge sert **N gateways**
(`server.ts:2020-2030` : map `served` + `lastGatewayVersion` par instance) et
`get_compat` confirme 8 versions OpenClaw validées et 2 instances live :

```
validatedVersions: 2026.5.19 … 2026.7.1   (8 versions)
instances: client-1@2026.7.1, client-2@2026.7.1
protocol.vendoredVersion: "2026.6.11"     ← une seule, figée
protocol.drift: []
```

La demande utilisateur est littéralement « les trames entrantes **de chaque
version supportée** » : la structure de donnée actuelle ne peut pas l'exprimer.

**(F) Le signal est volatil et en PULL.**
`server.ts:2046-2054` : le drift n'est lisible que si Convex interroge
`/capabilities`. Redémarrage du bridge (déploiement, crash, OOM) = **compteurs
remis à zéro**. `convex/lib/compat.ts:268-303` (`boundProtocolInfo`) puis
`convex/schema.ts:2575-2601` (`bridgeCompat`, singleton `key:"singleton"`)
n'écrivent qu'un **instantané écrasé** à chaque poll : aucun historique, aucune
date de première observation, aucune agrégation.

**(G) Hermes : zéro détecteur.**
Aucune occurrence de `protocolDrift` sous `src/providers/hermes/`.
`src/providers/hermes/normalizer.ts:352-354` : `// opened / unknown frames: no
NormalizedEvent (forward-compat…) ; return []`. Le second provider est un angle
mort **complet**.

### 1.3 Trace de tous les chemins d'échec (catch silencieux inclus)

Recherche : `catch {`, `catch {}`, `.catch(() => {})` sur `bridge/src/` — 60
occurrences. Celles qui touchent le **chemin de trame** :

| # | Chemin | Fichier:ligne | Effet | Compté ? |
|---|---|---|---|---|
| F1 | Exception dans `runManager.feed` (donc dans tout le normalizer / turn-sink) | `session.ts:547-551` | `console.error("session feed error:")`, la trame est perdue, le tour continue | **NON** |
| F2 | Exception dans l'observation sous-agent | `session.ts:589-591` | `console.error`, observation perdue | **NON** |
| F3 | Frame non-objet / non-`event` | `normalizer.ts:689-691` | `return []` | NON |
| F4 | `type === "res"` | `normalizer.ts:692-696` | `return []` (légitime : réponse RPC) | NON |
| F5 | **`event` inconnu** | `normalizer.ts:697-702` | `return []` | **NON** |
| F6 | `payload` non-objet | `normalizer.ts:703-706` | `return []` | **NON** |
| F7 | Session étrangère | `normalizer.ts:733-735` | `return []` (isolation — légitime) | NON |
| F8 | Run étranger hors grâce | `normalizer.ts:737-746` | `return []` | NON |
| F9 | **`stream` inconnu** | `normalizer.ts:1042-1137` (chute en fin de fonction) | rien | **NON** |
| F10 | Rapport provenance hors contrat | `normalizer.ts:1132-1135` | `part === null` → ignoré | NON |
| F11 | `args` message-tool JSON invalide → **texte de réponse perdu** | `normalizer.ts:1519-1527` | `return ""` | **NON** |
| F12 | Annonce déjà traitée (retransmission) | `run-manager.ts:454-460` | `return` sec | **NON** |
| F13 | Débordement du tampon pré-ack | `run-manager.ts:543-547` (`MAX_PENDING_FRAMES`) | trame jetée | **NON** |
| F14 | `catch {}` du détecteur lui-même | `protocol-drift.ts:201-203` | trame non classée | **NON** |
| F15 | Débordement 100 shapes | `protocol-drift.ts:183-190` | shapes suivantes non comptées | log stderr seul |
| F16 | Hermes : `data` non-JSON | `hermes/normalizer.ts:234-241` | corps ignoré | **NON** |
| F17 | **Hermes : event inconnu** | `hermes/normalizer.ts:352-354` | `return []` | **NON** |
| F18 | Frame non sérialisable (dump) | `run-manager.ts:135-137`, `:162-164` | échantillon perdu (diagnostic) | NON |

**F1 est le plus grave** : c'est le seul endroit où une trame provoque une
*exception* — donc typiquement une trame malformée ou une forme inattendue — et
le message d'erreur part dans `stdout` du conteneur. Ni trace Convex, ni
anomalie, ni compteur. Personne ne le saura jamais.

**F11 est une perte de contenu utilisateur silencieuse** : un `args` de
message-tool que le gateway sérialise différemment (ou tronque) fait disparaître
la réponse, et le tour finit « vide ».

### 1.4 La trame qu'on ne reçoit jamais — angle mort supplémentaire

Le gateway **abandonne** des trames quand le socket client est lent :

```
server-broadcast.ts:162   const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
server-broadcast.ts:174-179   if (slow && opts?.dropIfSlow) { if (!isTargeted) clientSeq.set(c, nextSeq); continue; }
server-broadcast.ts:180-186   if (slow) { c.socket.close(1008, "slow consumer"); continue; }
```

Deux faits décisifs :
1. Le drop **avance quand même le compteur** `clientSeq` (`:176`) — la perte est
   donc **détectable** : le `seq` d'enveloppe saute.
2. Ce `seq` est bien émis sur le fil, au niveau **enveloppe** (distinct de
   `payload.seq`) : `server-broadcast.ts:193-196`
   `{"type":"event","event":…,"payload":…,"seq":N}` — sur les broadcasts
   non ciblés uniquement (`eventSeq = isTargeted ? undefined : nextSeq`, `:190`).
   `sendAgentPayload` passe par `broadcast("agent", payload)` quand
   `controlUiVisible` (défaut vrai) : `src/gateway/server-chat.ts:1018-1024`.

Côté Atrium : **aucune lecture du `seq` d'enveloppe** (recherche `frame.seq` /
`.seq` hors `payload.seq`/`data.seq` dans `bridge/src/providers/openclaw/*.ts` +
`session.ts` → 0 résultat). Et `bridge/protocol/openclaw/coverage.json`
(`ChatDeltaEvent.fields.seq`) l'admet noir sur blanc :
`"NOTE: no ordering/gap detection (ordered WS transport)"`.

→ Le symptôme client « trames dans le désordre / réponse tronquée » a une cause
candidate **mesurable gratuitement** et non mesurée.
**NON PROUVÉ** que cela se produise en production Atrium : pour trancher, lire
`MAX_BUFFERED_BYTES` (`src/gateway/server-constants.ts` amont) et instrumenter
le gap de `seq` d'enveloppe côté bridge (cf. §4.2 point C5).

### 1.5 Le cas Hermes — exemple concret de dérive non détectée

Transport réellement utilisé par Atrium : `POST /api/sessions/{id}/chat/stream`
(`bridge/src/providers/hermes/client.ts:205`), parsé en SSE (`hermes/sse.ts:1-13`).

Events **réellement émis** par ce handler en 0.19.0
(`gateway/platforms/api_server.py:2512-2612`) :

| Event amont | Site d'émission | Connu d'Atrium ? |
|---|---|---|
| `run.started` | `api_server.py:2573` | oui (`hermes/normalizer.ts`, `HERMES_EVENT_NAMES.started`) |
| `message.started` | `:2574` | oui (`opened`) |
| `assistant.delta` | `:2562` | oui (`delta`) |
| `tool.progress` | `:2566` | oui (`toolProgress`) |
| `tool.started` | `:2567-2568` | oui (`toolStarted`) |
| `tool.completed` | `:2567-2568` | oui (`toolCompleted`) |
| **`tool.failed`** | `:2567-2568` (branche acceptée) | **NON** → `hermes/normalizer.ts:354` `return []` |
| `assistant.completed` | `:2589` | oui |
| `run.completed` | `:2597` | oui |
| `error` | `:2606` | oui |
| `done` | `:2609` | oui |

Sur `tool.failed`, distinguer proprement :
- **(a) contrat** : le handler l'accepte explicitement
  (`api_server.py:2567` : `event_type in {"tool.started","tool.completed","tool.failed"}`).
- **(b) émission réelle** : **NON PROUVÉ**. Les seuls appelants de
  `tool_progress_callback` dans l'agent passent `"tool.started"`
  (`agent/tool_executor.py:547`, `:1177`), `"tool.completed"` (`:917`, `:1625`),
  `"tool.output_risk"` (`:992`, `:1676`), `"reasoning.available"`
  (`agent/conversation_loop.py:4541`). Aucun `"tool.failed"` trouvé.
  Pour trancher : `grep -rn 'tool.failed' agent/ plugins/` sur une version
  ultérieure, ou capture live.
- **(c) Atrium consomme** : non. **(e) défaut si émis** : la carte d'outil ouverte
  par `tool.started` (`hermes/normalizer.ts:307-333`) ne serait **jamais fermée**
  → outil « en cours » éternel dans l'UI, et l'entrée `openTools` fuit sur le tour.

**Défaut amont adjacent, à signaler à l'éditeur** : sur ce transport,
l'échec d'un outil **n'est pas transportable**. `tool_executor.py:917-921` passe
`is_error=is_error` et `duration=…`, mais le pont SSE `api_server.py:2567-2568`
ne recopie que `{message_id, tool_name, preview, args}` — `is_error` est
**jeté**. Atrium ne peut donc structurellement pas savoir qu'un outil Hermes a
échoué sur `chat/stream`. (Ce n'est pas un défaut Atrium ; c'est une information
à réclamer, et entre-temps une raison de plus de capturer les formes réelles.)

Piège de transport à garder en tête : l'autre route Hermes `/v1/runs/{id}/events`
émet `message.delta` (`api_server.py:4880`), `reasoning.available` (`:4766`),
`approval.request` (`:4939`), `approval.responded` (`:5262`), `run.cancelled`
(`:4907`, `:5008`, `:5058`), `run.failed` (`:5023`) — **aucun** `assistant.delta`.
Basculer de transport sans auto-découverte = perte totale du streaming, en
silence (`hermes/normalizer.ts:354`).

---

## 2. La télémétrie existante — ce sur quoi on peut bâtir

### 2.1 Tables Convex candidates

| Table | Ligne | Contenu | Rétention | Verdict pour l'auto-découverte |
|---|---|---|---|---|
| `traceEvents` | `convex/schema.ts:2319-2348` | `kind`, `route`, `status`, `latencyMs`, `chatId`, `runId`, `correlationId`, `meta` (JSON non-PHI), `redacted` | purge 14 j (`:2366-2367`) | Bon pour l'**événement daté** (« à T, telle forme vue »), mauvais pour l'**inventaire** (pas d'agrégat, purgé) |
| `anomalies` | `:2403-2447` | `kind` stable, `severity`, `status`, `message`, `evidence` (JSON non-PHI), index `by_status_kind` | jamais purgée (`:2454`) | Bon pour l'**alerte** (« une forme inconnue est apparue »), mauvais comme **catalogue** (une ligne par `kind`, pas par forme) |
| `anomalyAttachments` | `:2456-2460` | contenu texte hors des scans | idem | Précédent utile : séparer *métadonnée listable* et *détail à la demande* |
| `bridgeCompat` | `:2575-2601` | singleton, champ `protocol` (`vendoredVersion`/`coverage`/`drift`) | écrasé à chaque poll | Bon pour l'**état courant**, incapable de mémoire |
| `deliverySessions` / `deliveryTimings` / `deliveryRecording` | `:1627-1676` | campagne d'enregistrement bornée : `enabled`, `autoStopAt`, `startedBy`, lignes **content-free**, `rollup` | manuelle | **Le patron exact à réutiliser** pour une campagne de capture |
| `kpiRollups` | `:2386-2391` | agrégats horaires longue durée | longue | Patron d'agrégat |

### 2.2 Bornes et garde-fous déjà en place

- `convex/lib/compat.ts:263-264` : `PROTOCOL_MAX_LIST = 100`, `PROTOCOL_MAX_STR = 120`
  — le drift est tronqué à 100 entrées / 120 caractères avant persistance
  (`:289-302`). Un débordement bridge (F15) **plus** cette troncature = double
  perte silencieuse.
- `convex/lib/compat.ts:313-320` (`mergeProtocolInfo`) : union multi-bridges avec
  **somme** des compteurs par shape ; `vendoredVersion`/`coverage` gardent le
  premier bridge. Correct, mais confirme l'absence d'axe version-gateway.
- `convex/anomalies.ts:198-213` (`findOpenDetectorRow`) + `:222+`
  (`upsertDetectorAnomaly`) : **une seule ligne OUVERTE par `kind`**, patchée au
  lieu d'être dupliquée. C'est le mécanisme anti-spam à réutiliser.
- **Piège** : `convex/anomalies.ts:741-791` (`reportAnomalyInternal`, source
  `agent`) **n'a aucun dédoublonnage** et appelle `notifyAdmins` à **chaque**
  insertion (`:780-788`). Un « je remonte chaque trame inconnue en anomalie »
  naïf noierait les admins de notifications. Contrainte de conception ferme.

### 2.3 Comment un opérateur lit ça aujourd'hui

- MCP `get_compat` → `protocol.{vendoredVersion, coverage, drift}` (sortie live
  ci-dessus, §1.2 E). C'est **la seule** vue protocole.
- MCP `list_anomalies` → 5 `kind` détecteurs seulement
  (`convex/anomalies.ts:104-110` : `api.error_ratio`,
  `openclaw.dispatch_failures`, `assistant.stream_errors`,
  `openclaw.ingest_denied`, `api.access_scan`) — **aucun** de nature protocole.
- MCP `list_traces` → `traceEvents`, purgés à 14 j, sans `kind` protocole.
- UI : `src/chat/admin/BridgeTab.tsx:497-530` — pastille « N unknown field(s) »
  + liste `shape × count`. Pas de date, pas de version, pas de provider, pas de
  chemin imbriqué, rien sur les events/streams inconnus.

**Conclusion §2** : le socle (tables bornées, non-PHI, patron campagne, patron
upsert-par-kind, transport bridge→Convex `/bridge/ingest` déjà authentifié
par-bridge — `convex/http.ts:70-78`, `convex/bridge_ingest.ts:476`) existe. Il
manque **le modèle de donnée** et **les points de capture**.

---

## 3. Système cible — « Frame Shape Registry » (auto-découverte)

Principe directeur : **on ne capture jamais une trame ; on capture sa FORME.**
La forme est un objet de vocabulaire (chemins + types), pas de contenu. La
non-fuite est donc *structurelle*, pas *procédurale*.

### 3.1 L'objet capturé : la signature structurelle

Pour une trame, on produit une liste de **chemins typés**, obtenue par un
parcours qui ne lit **jamais** une valeur scalaire, seulement son `typeof` :

```
frame.type            : "event"          ← DISCRIMINANT, valeur littérale autorisée (liste blanche)
frame.event           : "session.tool"   ← DISCRIMINANT, valeur littérale autorisée (liste blanche)
payload.stream        : "guardian"       ← DISCRIMINANT, valeur littérale autorisée (liste blanche)
payload.data.kind     : "review"         ← DISCRIMINANT, valeur littérale autorisée (liste blanche)
payload.runId         : string
payload.seq           : number
payload.data.verdict  : string
payload.data.findings : array<object>
payload.data.findings[].severity : string
payload.data.notes    : null
```

Règles de production, non négociables :

1. **Trois seuls champs peuvent porter une valeur littérale** : `frame.event`,
   `payload.stream`, `payload.data.kind` (+ `payload.state` pour `chat`,
   `data.phase` pour les items). Ce sont les **discriminants** du protocole :
   sans eux la découverte est inexploitable. Chacun est passé par un filtre
   d'identifiant : `^[a-zA-Z][a-zA-Z0-9._-]{0,47}$`, sinon remplacé par
   `"<non-identifier>"`. Un identifiant ne peut pas contenir de phrase,
   d'espace, d'accent, de ponctuation, ni dépasser 48 caractères → il ne peut
   pas transporter du contenu conversationnel.
   *(Choix assumé, cf. §3.8 : c'est le seul endroit où une valeur amont entre.)*
2. **Tout le reste est réduit à son type** : `string | number | boolean | null |
   array<T> | object`. Jamais la valeur, jamais la longueur d'une chaîne, jamais
   un préfixe. (La longueur est écartée volontairement : c'est un canal latéral.)
3. **Les tableaux sont fusionnés** : `findings[0]`, `findings[1]`… →
   `findings[]`, union des types des 8 premiers éléments.
4. **Bornes de parcours** : profondeur ≤ 6, ≤ 64 clés par objet, ≤ 256 chemins
   par trame. Au-delà : chemin littéral `"<truncated>"` (le signal de troncature
   est lui-même une donnée : il dit « forme anormalement large »).
5. **Clé de forme** = `sha256(provider | gatewayVersion | discriminants | chemins triés)`,
   tronquée à 16 hex. Déterministe, stable entre processus et redémarrages —
   c'est ce qui rend la déduplication possible côté serveur.

### 3.2 Les points de capture (5, plus un)

Tous **observe-only**, aucun ne peut modifier le flux (invariant hérité de
`protocol-drift.ts:6-7`).

| Code | Où poser le capteur | Ce qu'il attrape | Remplace/complète |
|---|---|---|---|
| **C1 — type inconnu** | `normalizer.ts:697-702`, avant le `return []` | event hors `{chat, agent}` | comble §1.2 A |
| **C2 — stream inconnu** | `normalizer.ts:1136`, sortie de `handleAgent` non traitée | `stream` non reconnu, + `data.kind`/`data.phase` | comble §1.2 B |
| **C3 — champ inconnu (existant, élargi)** | `protocol-drift.ts:178` | clés top-level **et** chemins `data.*` | élargit l'existant |
| **C4 — exception** | `session.ts:549-551` (`catch (err)`) | forme de la trame + **classe** d'erreur (`err.constructor.name`) + emplacement | comble F1, le plus grave |
| **C5 — trame perdue** | à l'entrée du consume loop (`session.ts:479-481`) | saut du `seq` **d'enveloppe** (`frame.seq`), par connexion | comble §1.4 |
| **C6 — perte de contenu** | `normalizer.ts:1519-1527`, `run-manager.ts:543-547`, `:454-460` | compteurs de rejet nommés (`msgtool_args_unparsable`, `pending_overflow`, `announce_stale_drop`) | comble F11/F12/F13 |

**C4 est le capteur prioritaire.** Une exception, c'est une trame que le code
n'a pas su lire *du tout* — le cas exact de la demande utilisateur (« arrivées en
erreur »). Aujourd'hui : `console.error` dans les logs du conteneur.

Provider Hermes : mêmes capteurs C1 (event SSE inconnu,
`hermes/normalizer.ts:354`), C4 (`hermes/turn.ts:164`), C6. Le registre est
**partagé** entre providers ; seul le champ `provider` diffère. C'est la règle
mémoire « toute feature conçue pour LES DEUX providers ».

### 3.3 Échantillonnage, déduplication, bornage

Côté bridge, en RAM, par clé `(provider, gatewayVersion, instanceName, shapeKey)` :

| Mécanisme | Valeur | Raison |
|---|---|---|
| Déduplication | 1 entrée par `shapeKey` ; répétition = `count++` | une trame répétée 10 000 fois = 1 ligne |
| Échantillonnage | **aucun** sur la 1ʳᵉ occurrence ; le compteur suit tout | ne jamais rater une forme rare (une forme rare est précisément le bug) |
| Borne mémoire | 512 formes / instance-version, LRU par `lastSeenAt` | 512 × ~1 Ko ≈ 512 Ko, négligeable |
| Débordement | compteur `overflowCount` **inclus dans le flush** | corrige F15 : le débordement devient une donnée, pas un log |
| Flush | toutes les 60 s **et** immédiatement sur 1ʳᵉ occurrence d'une forme de gravité `error` (C4) | latence d'alerte basse là où ça compte |
| Anti-tempête | ≤ 1 flush / 10 s, ≤ 64 formes par flush | protège Convex |
| Persistance locale | aucune (le flush est la persistance) | pas d'état disque à gérer |

### 3.4 Corrélation version + provider + instance

Chaque forme porte, **par construction** (renseignés par le bridge, pas par la
trame) :

| Champ | Source | Preuve d'existence |
|---|---|---|
| `provider` | `"openclaw"` \| `"hermes"` | axe déjà présent dans `bridgeCompat.targets` (`convex/schema.ts:2599`) |
| `instanceName` | instance servie | `server.ts:2020-2030` (map `served`) |
| `gatewayVersion` | version live du gateway | `server.ts:2022` (`lastGatewayVersion.get(soleName)`) ; capturée au hello-ok (`openclaw-client.ts:312-318`) |
| `bridgeVersion` / `buildRevision` | env image | `server.ts:2031-2034` |
| `vendoredVersion` | schéma vendored du build | `protocol-drift.ts:24` |

C'est **l'axe manquant** aujourd'hui, et c'est la demande explicite : « chaque
version supportée ». Deux gateways de la même version peuvent légitimement
diverger (`protocol-drift.ts:84-90` documente le cas `thinkingLevel`/`fastMode`
selon la config admin) → `instanceName` est nécessaire en plus de
`gatewayVersion`, sans quoi une divergence de configuration serait lue comme une
divergence de version.

### 3.5 Transport bridge → Convex

Réutiliser **la voie existante** : `POST /bridge/ingest` (`convex/http.ts:70-78`
→ `convex/bridge_ingest.ts:476`), déjà authentifiée **par bridge** (mémoire
« Isolation ingest per-bridge », R1 0.66.0 publiée). Ajouter un `kind` de
message `protocol.shapes` porté par une `internalMutation` dédiée.

Garde-fous d'ingestion (côté Convex, jamais côté bridge — le bridge n'est pas de
confiance) :
- rejet si `paths.length > 256`, `depth > 6`, longueur d'un chemin > 160 ;
- re-filtrage des discriminants par la **même** regex d'identifiant qu'en §3.1
  (double barrière : un bridge compromis ou une version future ne peut pas
  faire passer du texte libre) ;
- ≤ 64 formes par requête, ≤ 1 requête / 10 s / bridge (réutiliser le patron
  `apiRateLimits`, `convex/schema.ts:2354-2360`).

### 3.6 Stockage — nouvelle table, pas une extension de `anomalies`

**Décision : nouvelle table `protocolShapes` + réutilisation de `anomalies` pour
l'alerte seule.** Justifications :

- `anomalies` est un journal d'**incidents** (`status` open/ack/resolved,
  notification admin à chaque insert `convex/anomalies.ts:780-788`). Une forme
  inconnue est un **inventaire** : elle vit, se recompte, se classe, et ne se
  « résout » pas — elle se *traite* (fixture + test) ou se *déclare ignorée*.
- Mettre l'inventaire dans `anomalies` produirait des centaines de lignes
  ouvertes et autant de notifications (§2.2 piège).

```
protocolShapes: defineTable({
  provider: v.string(),            // "openclaw" | "hermes"
  gatewayVersion: v.string(),      // "2026.7.1"  (axe demandé)
  instanceName: v.string(),
  shapeKey: v.string(),            // sha256 tronqué, 16 hex — identité stable
  capture: v.string(),             // "unknown_event"|"unknown_stream"|"unknown_field"
                                   // |"exception"|"seq_gap"|"content_drop"
  severity: v.string(),            // "info" | "warn" | "error"
  discriminants: v.object({        // liste blanche, filtrés par regex d'identifiant
    event: v.optional(v.string()),
    stream: v.optional(v.string()),
    state: v.optional(v.string()),
    dataKind: v.optional(v.string()),
    dataPhase: v.optional(v.string()),
  }),
  paths: v.array(v.string()),      // "payload.data.findings[].severity:string"
  truncated: v.boolean(),
  errorClass: v.optional(v.string()),   // C4 : "TypeError" — CLASSE, jamais le message
  errorSite: v.optional(v.string()),    // C4 : "normalizer.handleAgent" — code stable
  count: v.number(),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  bridgeVersion: v.optional(v.string()),
  vendoredVersion: v.optional(v.string()),
  status: v.string(),              // "new" | "triaged" | "ignored" | "handled"
  triageNote: v.optional(v.string()),   // écrit par un ADMIN Atrium, jamais par le gateway
  fixtureRef: v.optional(v.string()),   // "bridge/test/fixtures/discovered/openclaw/2026.7.1/<key>.json"
})
  .index("by_shape", ["provider", "gatewayVersion", "shapeKey"])   // upsert O(1)
  .index("by_version_status", ["provider", "gatewayVersion", "status"]) // vue opérateur
  .index("by_status_lastSeen", ["status", "lastSeenAt"])                // triage récent
```

Écriture = **upsert par `by_shape`** (même patron que
`convex/anomalies.ts:198-213`) : `count += n`, `lastSeenAt = now`. Jamais
d'insertion en doublon.

**Pont vers `anomalies`** : un cron horaire ouvre **UNE** anomalie de `kind`
`protocol.unknown_shapes` (via `upsertDetectorAnomaly`, donc 1 seule ligne
ouverte, 1 seule notification) dont l'`evidence` est un JSON agrégé
`{provider, gatewayVersion, newShapes: N, errorShapes: M, topCaptures: […]}`.
L'opérateur clique → la vue détaillée lit `protocolShapes`.

### 3.7 Volume attendu

Ordre de grandeur, avec les chiffres du dépôt :
- surface OpenClaw connue : 41 handled + 50 ignored = 91 champs classés
  (`protocol-drift.ts:141-147`, confirmé par `get_compat`) ;
- formes **inconnues** attendues par version : quelques dizaines (le drift live
  historique cite 3 champs en juillet, `protocol-drift.ts:117-121`) ; borne dure
  512/instance-version (§3.3) ;
- axes : 8 versions validées × 2 providers × ~5 instances.

→ Plafond dur ≈ 8 × 2 × 5 × 512 ≈ **41 000 lignes**, réalité attendue
**quelques centaines**. À ~400 octets/ligne (256 chemins bornés à 160 car. est le
pire cas ; le cas courant est 20-40 chemins) : **quelques Mo au pire**, ~100 Ko
en régime normal. Écritures : ≤ 6 flush/min/bridge × ≤ 64 upserts, soit
< 400 mutations/min en pointe de découverte, et **quasi zéro en régime établi**
(une forme déjà connue n'écrit qu'un `count++`, et on peut agréger les
`count++` par fenêtre de 60 s — c'est déjà le cas via le flush).

Rétention : `handled`/`ignored` gardés indéfiniment (c'est le catalogue, il est
petit) ; `new`/`triaged` non revus depuis 180 jours et `count` stable →
purgeables. À trancher (§5).

### 3.8 Pourquoi aucune fuite de contenu n'est possible — par construction

| Barrière | Mécanisme | Où |
|---|---|---|
| B1 | Le sérialiseur ne lit **jamais** une valeur scalaire, seulement `typeof` | producteur de signature (bridge) |
| B2 | Les 5 discriminants sont **une liste blanche fermée**, pas un opt-out | §3.1 règle 1 |
| B3 | Chaque discriminant passe la regex d'identifiant `^[a-zA-Z][a-zA-Z0-9._-]{0,47}$` | bridge **et** Convex (double barrière) |
| B4 | Les noms de chemin proviennent de `Object.keys`, jamais de valeurs | §3.1 règle 2 |
| B5 | `errorClass` = `err.constructor.name` — **jamais** `err.message` (un message d'erreur peut citer la donnée) | C4 |
| B6 | Pas de longueur de chaîne, pas de préfixe, pas de hash de valeur | §3.1 règle 2 |
| B7 | Test unitaire adverse : injecter du contenu conversationnel dans **chaque** position (clé, valeur, `stream`, `event`, message d'erreur) et asserter qu'aucun octet ne ressort | à écrire, cf. §3.10 |

Le précédent est déjà tenu par `protocol-drift.ts:9-11` + son test
`bridge/test/protocol-drift.test.ts:46-48` (une valeur `"secret content"` est
injectée, seul le nom `chat.steerHint` ressort). On étend exactement le même
contrat de preuve.

**Une seule concession consciente** : les valeurs de `event`/`stream`/`kind`
entrent dans la base. C'est indispensable (sans elles on sait « une forme
inconnue existe » mais pas laquelle) et c'est sûr : ce sont des identifiants de
protocole choisis par le développeur du gateway, filtrés par B3. Si l'on refuse
même cela, la position de repli est de ne stocker que le **hash** du
discriminant — mais la restitution devient inexploitable pour écrire un
correctif. **Recommandation : garder les discriminants filtrés.**

### 3.9 Restitution — ce que l'opérateur voit

**Trois niveaux**, du plus agrégé au plus actionnable.

**Niveau 1 — MCP obs, nouvel outil `list_protocol_shapes`** (préféré à un
élargissement de `get_compat`, qui doit rester un état courant léger) :

```
list_protocol_shapes(provider?, gatewayVersion?, status?, capture?, limit?)
→ [{ shapeKey, provider, gatewayVersion, instanceName, capture, severity,
      discriminants, count, firstSeenAt, lastSeenAt, status, fixtureRef }]
get_protocol_shape(shapeKey)
→ { …, paths: ["payload.data.findings[].severity:string", …], errorClass, errorSite }
```

Règle mémoire respectée : « enrichir l'obs MCP quand une valeur manque ».

**Niveau 2 — UI Bridge**, sous la section Protocole existante
(`src/chat/admin/BridgeTab.tsx:466-530`) : un tableau **par version de gateway**

```
OpenClaw 2026.7.1 — client-1            3 nouvelles formes, 1 en erreur
┌────────────────────┬──────────────────────────┬───────┬───────────┬─────────┐
│ capture            │ discriminants            │ vues  │ 1ʳᵉ vue   │ statut  │
├────────────────────┼──────────────────────────┼───────┼───────────┼─────────┤
│ exception          │ agent / lifecycle        │    12 │ 22/07 14h │ new     │
│ unknown_stream     │ agent / guardian         │ 1 204 │ 19/07 09h │ new     │
│ unknown_event      │ session.tool             │   340 │ 19/07 09h │ ignored │
└────────────────────┴──────────────────────────┴───────┴───────────┴─────────┘
```

Clic → panneau détail : la **liste complète des chemins typés**. C'est
précisément ce qu'il faut pour écrire le correctif sans accès au gateway : on
sait quel `stream`, quel `data.kind`, quels champs, de quels types.

Message clé, formulé pour l'opérateur (règle « pas de conseil de contournement ») :
« Cette version émet une trame que nous ne traitons pas » + le bouton d'action
« Générer la fixture » (§3.10). Jamais « ignorez-la » ni « réessayez ».

**Niveau 3 — anomalie unique** `protocol.unknown_shapes` (§3.6) pour que la
découverte **remonte** au lieu d'attendre qu'on la cherche. Sévérité :
`warn` par défaut, `critical` si `capture === "exception"` (une trame qui fait
jeter est un bug actif) ou si `seq_gap` dépasse un seuil.

### 3.10 Boucle de fermeture : forme découverte → fixture → test

Quatre étapes, dont trois automatisables.

**Étape 1 — génération du squelette (automatique).**
Un script `bridge/scripts/shape-to-fixture.ts` prend un `shapeKey`, lit la forme
via l'API obs, et écrit une trame **synthétique** dans
`bridge/test/fixtures/discovered/<provider>/<version>/<shapeKey>.json` :
chaque chemin typé reçoit une valeur neutre (`"x"`, `0`, `false`, `[]`, `{}`).
Le fichier porte un en-tête `$comment` avec `shapeKey`, `firstSeenAt`,
`gatewayVersion`. **Aucun contenu réel n'y figure — il n'en existe pas.**

**Étape 2 — test de non-régression minimal (automatique).**
Un test paramétré parcourt `fixtures/discovered/**` et asserte, pour chaque
fixture :
1. `normalizer.feed(frame, now)` **ne jette pas** ;
2. la classification produite est celle **attendue et déclarée** (fichier
   `expected.json` à côté : `{ events: [...] }` ou `{ events: [], reason: "ignored:<why>" }`).

Ce test **échoue** si le normalizer régresse sur la forme (exigence
`atrium-test-quality-standard`).

**Étape 3 — classification humaine (manuelle, 1 ligne).**
L'opérateur décide : `ignored` (avec un `why` obligatoire, comme
`coverage.json`) ou `handled`. La décision est écrite **à deux endroits qui
doivent rester d'accord** :
- `protocolShapes.status` + `triageNote` (vue opérateur) ;
- `bridge/protocol/openclaw/coverage.json` ou `KNOWN_*_FIELDS`
  (`protocol-drift.ts:27-131`) — le chaînage statique existant.

**Étape 4 — le ratchet (automatique).**
Étendre `bridge/test/protocol-coverage.test.ts` : **échouer** si une fixture
`discovered/` existe sans entrée correspondante dans `coverage.json`. La forme
découverte devient alors littéralement impossible à oublier : le CI reste ROUGE
tant qu'un humain n'a pas tranché. C'est la mécanique déjà décrite dans
`docs/design/protocol-contract.md:37-70`, étendue du statique au découvert.

**Limite honnête.** Une fixture synthétique prouve *« on ne casse pas, on classe
correctement »*. Elle **ne prouve pas** la sémantique (« ce `stream` porte le
texte de la réponse »). Pour la sémantique il faut une trame réelle, donc du
contenu → elle reste **strictement locale** : `BRIDGE_FRAME_DUMP` existe déjà
(`run-manager.ts:125-138`), est opt-in, et n'écrit que dans les logs du bridge.
D'où le **plan à deux étages** :
- **Plan 1 (prod, Convex)** : formes uniquement, non-PHI par construction — c'est
  ce système.
- **Plan 2 (dev/live-bench, local)** : trames complètes, jamais en base, jamais
  hors du poste. C'est exactement la séparation déjà retenue pour
  `subAgentReports` vs `anomalies` (`convex/schema.ts:2417-2425` : « le plane-2
  content-free d'un plane-1 »).

### 3.11 Découverte proactive — la liste que le gateway donne déjà

À la connexion, le gateway **déclare** ce qu'il sait émettre :
`hello-ok.features.events` (`packages/gateway-protocol/src/schema/frames.ts:99-103`,
peuplé par `GATEWAY_EVENTS` en `src/gateway/server.impl.ts:1581`). Le bridge lit
déjà le hello-ok (`openclaw-client.ts:312-318`) mais **n'exploite pas
`features`** (`grep` : seules les lignes de log).

→ Gain immédiat, sans attendre qu'une trame arrive : au hello-ok, comparer
`features.events` et `features.methods` à la surface connue du build, et écrire
une ligne `protocolShapes` `capture:"undeclared_event"` par écart. On sait alors
**au démarrage** — pas au premier incident client — que la version installée
annonce un event qu'on ne traite pas. Même chose pour Hermes :
`GET /v1/capabilities` est déjà appelé (`hermes/client.ts:152`).

C'est la réponse la plus directe à « quand les fournisseurs sont incapables de
nous fournir exactement les trames qu'ils émettent » : **ils nous donnent déjà la
liste des noms, on ne la lit pas.**

---

## 4. Découvertes de fond (au-delà de la zone stricte)

1. **Le schéma amont ment.** `AgentEventSchema` déclare
   `additionalProperties: false` (`agent.ts:57-67`) mais le gateway diffuse sans
   validation (`server-broadcast.ts:189-197`). Les 20+ champs listés en
   `protocol-drift.ts:60-130` (`session`, `spawnedCwd`, `endedAt`, `childSessions`…)
   sont autant de **violations du schéma de l'éditeur**, découvertes une par une
   en production. Corollaire : vendorer le schéma est nécessaire mais **jamais
   suffisant** — l'auto-découverte est la seule couverture.
2. **`stream` n'est pas énuméré au contrat** (`agent.ts:61 : NonEmptyString`) et
   `data` est un `Record<string, Unknown>` (`agent.ts:64`). La moitié du protocole
   utile est donc **hors contrat par conception amont**.
3. **Le gateway sait perdre des trames et nous le dit** (`seq` d'enveloppe avancé
   au drop, `server-broadcast.ts:174-179`) ; Atrium ne lit pas ce `seq`.
4. **Le gateway sait fermer notre socket** (`close(1008, "slow consumer")`,
   `server-broadcast.ts:180-186`). Atrium traite la fermeture mi-tour comme une
   perte de connexion générique (`session.ts:480-523`) sans distinguer ce code
   1008 — **NON PROUVÉ** que le code de fermeture soit lu : à vérifier dans
   `openclaw-client.ts` (gestion `close`).
5. **Hermes perd l'échec d'outil au niveau du transport amont** :
   `is_error` est calculé (`agent/tool_executor.py:917-921`) puis jeté par le
   pont SSE (`gateway/platforms/api_server.py:2567-2568`).

---

## 5. Questions ouvertes

1. Stocker la valeur littérale des discriminants (`event`/`stream`/`data.kind`)
   ou seulement leur hash ? Recommandation : valeur filtrée par regex
   d'identifiant (§3.8) — sinon la restitution est inexploitable.
2. Rétention des lignes `new`/`triaged` non revues : 180 j ou illimité ?
   (le catalogue est petit ; la purge coûte plus qu'elle ne rapporte).
3. `seq_gap` (C5) : quel seuil déclenche une anomalie `critical` ?
   Prérequis : mesurer d'abord le taux réel en prod, il est peut-être nul.
4. Le capteur C5 nécessite de savoir si l'on est sur un broadcast ciblé
   (pas de `seq` d'enveloppe, `server-broadcast.ts:190`) — comment distinguer
   « ciblé » de « perdu » côté client ? **NON PROUVÉ** qu'on puisse : à trancher
   en lisant quels chemins d'émission Atrium reçoit réellement
   (`server-chat.ts:1018-1038`).
5. Faut-il un mode « campagne » borné (patron `deliveryRecording`,
   `convex/schema.ts:1627-1632` : `enabled` + `autoStopAt`) pour une capture
   *enrichie* lors d'une validation de version, ou le régime permanent
   content-free suffit-il ? Recommandation : régime permanent (le volume est
   négligeable) + campagne locale Plan 2 pour la sémantique.
6. `tool.failed` Hermes : réellement émis ou branche défensive morte ?
   À trancher par capture live sur `/api/sessions/{id}/chat/stream`.
