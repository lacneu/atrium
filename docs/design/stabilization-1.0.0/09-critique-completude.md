# 09 — Critique de complétude du programme 1.0.0 (adversarial)

Rôle : trouver ce qui MANQUE. Ce document ne valide rien. Il ne rediscute pas les
73 lacunes du programme (elles sont, pour celles que j'ai vérifiées, correctement
tracées) : il attaque le **périmètre**, les **prémisses** et le **critère de
sortie**.

Conventions : `A/…` = dépôt Atrium (`<workspace>/atrium`).
« PROD » = fait relevé en direct sur l'instance de production via l'obs MCP
(lecture seule) le 2026-07-24. Toute affirmation non vérifiée est marquée
**NON PROUVÉ** avec ce qu'il faut lire ou exécuter pour trancher.

---

## 0. Ce que j'ai vérifié moi-même (base de la critique)

| # | Vérification | Résultat |
|---|---|---|
| V1 | `A/convex/anomalies.ts:222-264` (upsert détecteur + `notifyAdmins`), `:275-292` (auto-résolution) | Le détecteur **notifie** à l'ouverture puis **auto-résout** ; l'`evidence` est **écrasée** au refresh |
| V2 | PROD `list_anomalies from=now-14d` | 16 lignes ; `assistant.stream_errors` **le 20/07 à 2 min de l'incident context_length**, `resolvedBy: "detector:auto"` 5 min plus tard |
| V3 | PROD `get_compat` | `vendoredVersion: "2026.6.11"`, gateways `2026.7.1`, `drift: []`, `coverage.gaps: 0` |
| V4 | `A/convex/bridge.ts:206`, `:283`, `:1055` — seuls écrivains du statut `outbox` | Aucun écrivain temporel ⇒ pas de réconciliation d'un dispatch mort |
| V5 | `grep AbortSignal\|timeout` sur `A/convex/bridge.ts` | **Aucun timeout** sur le `fetch` `POST /send` (`:1331`) |
| V6 | `A/convex/crons.ts:1-175` (14 crons) | Watchdogs pour `streamingText`, `subAgents`, renditions… **rien** pour `outbox` |
| V7 | `A/convex/stuckStreams.ts:346` `SWEEP_MIN_AGE_MS = 300_000`, `:411-420` | Le balayage de boot **attend 5 min** puis écrit `error/connection_lost` |
| V8 | `A/bridge/src/index.ts:248-262` | SIGTERM : `closeAll()` + `exit` — **aucune** finalisation des tours en vol |
| V9 | `A/convex/messages.ts:203-270` | `loadChatView` = 200 messages + `.collect()` des parts par message + **un `ctx.storage.getUrl` par part média/fichier**, requête **réactive** |
| V10 | `A/src/router.tsx:1226` + `messages/fr.json:1007` | Une erreur de requête ⇒ page d'erreur pleine (« Une erreur est survenue »), pas de dégradation partielle |
| V11 | `A/scripts/loadtest/README.md:6`, `STREAMING_FINDINGS.md:1-30` | Harnais de charge **hors CI** ; deux O(n²) **déjà documentés** dans le dépôt |
| V12 | `A/bridge/src/compat.ts:293-317` | `resolveCapabilities` est pure : **aucune** échappatoire opérateur possible |
| V13 | `A/RELEASE.md:1-40` vs `A/deploy/README.md:254` | 4 artefacts en lockstep ; `npx convex deploy` = **étape manuelle** hors pipeline |
| V14 | `PROTOCOL_VERSION` (`A/bridge/src/compat.ts:34`) | Consommé **uniquement pour affichage** (`A/src/chat/admin/BridgeTab.tsx:304`) — jamais comparé |
| V15 | `A/convex/stream.ts:1538-1545` | `finalize` est bien **first-terminal-wins** ⇒ la prémisse d'idempotence de W8 est **exacte** |
| V16 | `A/bridge/src/providers/openclaw/run-manager.ts:401,411,495,518,589,608,712,731` | 8 sites `await sink.apply` appartenant à des **appelants différents** ⇒ G-29 est exact, le verdict est optimiste |
| V17 | `<hors-dépôt>/skills/add-gateway-version/SKILL.md` + `<hors-dépôt>/live-bench/` | Le processus de version et son banc sont **hors dépôt** ; aucun fichier de `A/.github/workflows/` ne les référence |
| V18 | PROD anomalies `AGENT_RESTRICTED` ×7 fenêtres sur 14 j, même `chatId` récurrent | Classe d'échec **récurrente**, absente du registre et des 12 lots |

---

## 1. La prémisse centrale du programme est fausse — le système S'EST plaint

C'est la critique la plus grave, parce qu'elle oriente tout le séquencement.

Le programme affirme, en tête de verdict et en justification de W9 :

> « le système ne se plaint jamais avant l'utilisateur : les quatre classes de
> défauts de trames de juillet ont toutes été signalées par un utilisateur, aucune par un
> test, une alerte ou une sonde »
> (`00-programme-1.0.0.md`, verdict ; repris de `10-registre-prod.md:44-49`)

**Réfuté par la production.** Le 20/07, pour l'incident de débordement de contexte :

| Horodatage | Objet | Source |
|---|---|---|
| `1784564579236` | anomalie `assistant.stream_errors` — « Assistant stream errors: 2 over 15m », `sampleCorrelationId` = **le chat de l'incident** (`mh7499n7m4g0s8pmb3mng95h198ateyx`) | PROD, détecteur |
| — | `notifyAdmins({kind:"anomaly_open", href:"/settings/anomalies"})` à l'insertion | `A/convex/anomalies.ts:247-255` |
| `1784564879235` (**+5 min**) | même ligne : `status: "resolved"`, `resolvedBy: "detector:auto"` | PROD + `A/convex/anomalies.ts:275-292` |
| `1784565043142` | l'**agent** (pas la sonde) dépose le vrai diagnostic en `improvement_proposal` | PROD |

Donc : **la sonde a détecté, a notifié un admin, puis a effacé son propre
signal 5 minutes plus tard.** Le vrai défaut n'est pas l'absence de détection,
c'est la chaîne de signal :

1. **Spécificité nulle** — « 2 stream errors over 15m » ne dit ni *débordement de
   contexte*, ni *trou de séquence*, ni *run étranger*. Le seuil est un compteur
   d'erreurs, pas une classe (`A/convex/anomalies.ts:402-462`).
2. **Auto-résolution** — `autoResolveClearedDetectors` ferme toute ligne dont la
   condition n'est plus dans la fenêtre de 15 min (`:275-292`). Un incident qui a
   coûté un tour de travail devient un `resolved` automatique.
3. **Historique détruit** — un seul row OPEN par `kind`
   (`findOpenDetectorRow`, `:200-213`) et l'`evidence` est **patchée** au refresh
   (`:259-264`) : la 2ᵉ occurrence écrase la 1ʳᵉ. Impossible de dire « ça s'est
   produit 4 fois en 3 jours » depuis la table.
4. **Aucun propriétaire, aucun KPI** — `severity: "warn"`, une notification, pas
   de destinataire responsable, pas d'objectif de fermeture.

**Conséquence directe sur W9** : W9 est justifié par « la seule couverture
possible », et son plan prévoit explicitement « **UNE** anomalie de pont via
`upsertDetectorAnomaly` ». Il **hérite donc du canal qui vient d'échouer** :
notification unique, auto-résolution, evidence écrasée. On ajoute un inventaire
neuf au-dessus d'une chaîne de signal cassée.

**Correctif attendu (manquant, à ajouter en tête de programme)** : une classe
d'anomalie **par cause** (`context_length_terminal`, `frame_gap`,
`foreign_run_rejected`, `dispatch_stalled`), **immuable par occurrence** (table
d'occurrences append-only + un agrégat, jamais un row écrasé), **jamais
auto-résolue** pour les classes qui coûtent un tour, et un KPI de fermeture. Sans
ça, l'indicateur de sortie n°2 du programme (« inverser le ratio 0/4 ») est
inatteignable : le ratio réel est déjà « détecté mais non exploité ».

---

## 2. Zones que PERSONNE n'a regardées

Les 8 rapports couvrent l'axe **gateway → bridge → normalizer**. Vérifié par
comptage d'occurrences dans `00-programme-1.0.0.md` :

| Terme | Occurrences |
|---|---|
| `reconnex`/`reconnect`, `readonly`, `op budget`, `system operations`, `pagination`, `multi-instance`, `storage`, `attachment`, `rate limit`, `index`, `WebRTC`, `outbox`, `isChatBusy`, `drainNext`, `repark`, `reaper` | **0** |
| `satur`, `NAS`, `React`, `frontend`, `migration` | 1 chacun (et jamais comme sujet — cf. §2 détails) |
| `loadtest`, `O(n`, `amplification`, `latence`, `perçu` | **0** |

### 2.1 Le chemin d'écriture Convex de bout en bout (≈150 modules)

Le **verrou permanent de chat sur un dispatch mort** n'est couvert par rien.

- `isChatBusy` retourne vrai dès qu'une ligne `outbox` est `pending`
  (`A/convex/lib/outboxQueue.ts:96-104`).
- Les seuls écrivains d'un statut terminal sont **l'action de dispatch
  elle-même** : `markOutbox` (`A/convex/bridge.ts:206`) et `failDispatch`
  (`:283`) — plus le re-park (`:1055`).
- Le `fetch POST /send` (`:1331`) n'a **aucun** `AbortSignal`/timeout (V5), et la
  prod a déjà mesuré des dispatches à **43 s**
  (`memory/atrium-prod-listchats-saturation.md`).
- Aucun cron ne réconcilie `outbox` (V6). `A/convex/activity.ts:151` se contente
  de **compter** les « pending dispatch(es) » pour le go/no-go de déploiement.

Donc si l'action meurt avant son écriture terminale (timeout d'action, `convex
deploy` en plein vol — cf. §5 —, redémarrage du backend, OOM), la ligne reste
`pending` **pour toujours** : le chat est busy à vie, chaque envoi part en file
(plafond 20, `MAX_QUEUED_PER_CHAT`), l'utilisateur voit « l'agent travaille »
sans bulle et sans cause. Le dépôt a un reaper pour `streamingText` (12 min), un
pour `subAgents` (20 min), un pour les renditions — **rien** pour le maillon qui
précède les deux.

**NON PROUVÉ** : que ce scénario a mordu en prod. À trancher : requêter les
lignes `outbox` `pending` d'âge > 10 min (`get_activity` expose le compteur ;
`activity.ts:101` lit déjà l'index `by_status`).

### 2.2 Le frontend (86 873 lignes) et le coût réactif

- `loadChatView` (`A/convex/messages.ts:203-270`) relit **200 messages**, fait un
  `.collect()` des `messageParts` **par message** (`:232-236`) et un
  `ctx.storage.getUrl` **par part média/fichier** (`:269`). C'est une requête
  **réactive** : elle se ré-exécute à chaque insertion de part dans la fenêtre.
  Un tour à 21 outils (le comparateur d'écrans du 20/07 : 16 `web_search` + 5
  `web_fetch`) déclenche donc ~21 relectures complètes de la fenêtre.
- Le mode de panne correspondant est **déjà arrivé en prod** : « too many system
  operations » sur `messages:listChats` / `agents:getChatAgent`, backend saturé
  par une rafale d'ingest (`memory/atrium-prod-listchats-saturation.md`). Le
  budget Convex est **par fonction**, donc une requête lourde et réactive est
  exactement le mauvais profil.
- Et la conséquence utilisateur est **binaire** : une seule requête en échec
  affiche la page d'erreur de route (`A/src/router.tsx:1226`, clé
  `app_route_error_title`, `messages/fr.json:1007`) — toute la conversation
  disparaît, aucune dégradation partielle.

Aucun lot ne mesure ni ne borne ce coût, alors que **W3, W4, W5 et W9 ajoutent
tous des écritures** (traces, parts, formes de trames) sur le même backend.

**NON PROUVÉ** (honnêteté) : que `loadChatView` soit *aujourd'hui* la requête qui
casse le budget — le diagnostic prod du 14/06 a réfuté cette hypothèse **pour ce
chat-là** (4 messages). Ce qui est prouvé, c'est que le coût **croît avec le
nombre de parts et de fichiers** et que **personne ne le mesure**. À trancher :
`scripts/loadtest/run.mjs --deltas` + un chat à 200 messages et 50 parts fichier,
en comparant `ctx.storage.getUrl` présent/absent.

### 2.3 Latence perçue et charge — absentes alors que le dépôt les documente

`A/scripts/loadtest/STREAMING_FINDINGS.md:1-30` établit **deux O(n²)** :
re-parse markdown côté client (dominant, visible) et **amplification de push**
Convex (« a reply streamed in K deltas pushes ~K/2× its own size »). Le harnais
qui les mesure existe et est **explicitement hors CI**
(`A/scripts/loadtest/README.md:6`). Le programme n'en parle **pas une fois**.

Or « les clients trouvent Atrium instable » englobe la jank et la latence qui
croît avec la longueur de la réponse — un symptôme que le client attribue au
produit exactement comme une trame perdue.

### 2.4 Cycle de vie du bridge lui-même (= chaque release)

Le programme traite le redémarrage **du gateway** (W3, trame `shutdown`). Il ne
traite **jamais** le redémarrage **du bridge**, qui est l'événement le plus
fréquent du système (0.68.x = plusieurs releases par semaine ; chaque release
recrée l'image `atrium-bridge`).

Ce qui se passe aujourd'hui, prouvé :

1. SIGTERM ferme les connexions et sort (`A/bridge/src/index.ts:248-262`) : **aucun**
   tour en vol n'est finalisé, aucune ligne n'est parquée.
2. Au boot, `sweepStreams` (`A/bridge/src/index.ts:191-193` →
   `A/convex/bridge_ingest.ts:551-561` → `A/convex/stuckStreams.ts:349`) ne touche
   **que** les lignes d'âge > `SWEEP_MIN_AGE_MS = 300 s` (`:346`) — donc le tour
   coupé reste « en cours » 5 minutes, puis une passe différée à +305 s le ferme.
3. La fermeture écrit `status:"error"`, `error:"connection_lost"` en ne
   conservant que le **texte partiel** (`:410-415`). **Aucune tentative de
   récupérer la réponse que le gateway a, lui, terminée** — alors que le chemin
   existe (`A/bridge/src/providers/openclaw/history-recovery.ts`, utilisé pour la
   récupération de tour orphelin en session vivante, `A/bridge/src/session.ts:490`).
4. Les sous-agents attendent le reaper : `SUBAGENT_STALE_TTL_MS = 20 min`
   (`A/convex/lib/outboxQueue.ts:58`), dont le commentaire cite littéralement
   « **a BRIDGE RESTART** » comme cause (`:37-40`).
5. Le balayage est plafonné à 128 lignes par instance
   (`A/convex/stuckStreams.ts:365`), au-delà retour au watchdog 12 min.

**Manque** : un lot « redémarrage propre du bridge » — drain SIGTERM (finaliser
ou parquer explicitement), et au boot **tenter la récupération d'historique**
avant de conclure `connection_lost`. Sans ça, chaque déploiement d'Atrium
fabrique lui-même la classe de défaut que les clients rapportent (« bulle vide /
réponse perdue »), et le programme prévoit **beaucoup** de releases.

### 2.5 Invariant file d'attente / busy / préemption : sans propriétaire

`outbox`, `isChatBusy`, `drainNextQueued`, `preemptRepark`, le reaper de
sous-agents : **0 occurrence** dans le programme. Or c'est là que vivent deux
incidents prod (21/07 announce×envoi ; 19/07 bulles vides) et c'est ce que
**W2, W4 et W8 modifient** (nouveaux chemins terminaux). Un nouveau chemin
terminal qui n'appelle pas `drainNextQueued` = un chat verrouillé. Le fichier le
dit lui-même : « safe to call from EVERY turn-end path … so the queue can never
stall » (`A/convex/lib/outboxQueue.ts:167-170`).

### 2.6 Voix / talk

Les tours vocaux passent par **le même** RunManager/TurnSink/normalizer
(`A/bridge/src/core/talk-consult.ts:1-8`) et sont admis dans la machinerie de
tour spontané (`:11-23`), avec un `Proxy` d'observation du `finalize` (`:31-57`).
Donc W5/W6/W8 les impactent mécaniquement — et W11 reconnaît que `probe-talk.mjs`
n'est dans **aucune** suite exécutée (G-65). Aucun lot ne nomme la voix dans ses
vérifications : c'est une surface fonctionnelle qui peut casser sans un seul test
rouge.

### 2.7 Multi-tenant / autorisation

Aucun des 8 rapports ne regarde l'isolation entre utilisateurs, alors que
l'historique du dépôt contient un IDOR d'upload et que l'isolation d'ingest
par-bridge a été un chantier dédié. Pour une 1.0.0 sous contrainte SOC2, une
revue d'autorisation (grants, agent enablement, pièces jointes, exports) devrait
être un **gate**, pas un hors-sujet.

### 2.8 Persistance des fichiers

`ctx.storage.delete` n'existe que pour les logos de charte
(`A/convex/charts.ts:1357-1501`) et le GC de stream (`A/convex/stream.ts:1099`,
`:1183`). **NON PROUVÉ** : existence de blobs orphelins (suppression de chat /
message / rendition). À trancher : compter les `_storage` sans part référente sur
le backend prod. Le NAS plein est un mode de panne déjà rencontré (ENOSPC au
banc).

---

## 3. Affirmations non prouvées présentées comme des faits

| # | Affirmation du programme | Statut | Preuve |
|---|---|---|---|
| A1 | « les quatre classes … aucune [signalée] par un test, une alerte ou une sonde » | **FAUX** | §1 : l'anomalie a été levée à +2 min et notifiée aux admins, puis auto-résolue (`A/convex/anomalies.ts:247-255`, `:275-292` ; PROD) |
| A2 | « l'ordre par connexion est intact de bout en bout … la boucle applique une trame à la fois » | **TROP FORT** | 8 sites `await sink.apply` avec des appelants distincts — boucle de trames (`run-manager.ts:411`), tick d'horloge (`:608`), récupération (`:712`), fin de tour (`:731`). C'est exactement G-29. Le verdict contredit son propre lot W8, programmé en vague 4 |
| A3 | « les champs Convex ajoutés sont `v.optional` donc rétro-compatibles » (risque W1) | **INCOMPLET, donc trompeur** | Vrai pour les **documents** existants ; faux pour un **déploiement** en retard : la validation de schéma est active par défaut (`A/convex/schema.ts:224` sans option), donc un backend non redéployé **rejette** l'écriture d'un champ inconnu, et *a fortiori* d'une table inconnue (W9 `protocolShapes`). Cf. §5 |
| A4 | « 179k affichés contre **308k réels** » (verdict, `10-registre-prod.md:38-40`) | **CHIFFRES INCOHÉRENTS avec la preuve prod** | L'anomalie du 20/07 porte `observedTokens: 179625`, `reportedContextTokens: **372000**`, `reportedFillPct: 48`, `compactionCheckpoints: 0` (PROD, `jh7ctw46t1wdfdy9apa7wre8p18ax0qs`). Ni 308k ni « jauge à 179k/272k » ne se retrouvent tels quels |
| A5 | (implicite W1) « la jauge devient fidèle si elle suit `contextBudgetStatus` » | **NON PROUVÉ, et probablement insuffisant** | Si la fenêtre annoncée vaut 372 000 et que le mur tombe vers 180 000 comptés, l'erreur est dans le **hors-compte** (schémas d'outils 20-30k, injections `knowledge` ~4k/tour) et/ou le dénominateur — pas seulement dans le numérateur. Le programme le sait (N11) mais W1 n'en fait pas un critère |
| A6 | « `protocolShapes` … TEMPÊTE D'ÉCRITURES bornée » (W9) | **NON PROUVÉ à l'échelle du backend** | Les bornes de W9 concernent le nombre de **formes**, pas le coût agrégé sur un backend dont la saturation est un incident prod établi. Aucun lot ne mesure l'enveloppe d'écriture totale par tour |
| A7 | « le seul risque [de W1] est de retirer un chiffre » | **FAUX en l'état** | W1 ajoute des champs Convex ⇒ hérite du risque d'ordre de déploiement A3 |
| A8 | « `finalize` … Convex est first-terminal-wins » (W8) | **VÉRIFIÉ EXACT** | `A/convex/stream.ts:1538-1545`. Mentionné pour être juste : cette prémisse tient |

---

## 4. Lots dont la régression peut dépasser le défaut corrigé

### 4.1 W2 — le pire risque n'est pas celui que le programme confine

Le programme confine « bloquer un envoi qui aurait réussi » (fail-open sur
exception, une tentative par tour). Il **ignore deux risques plus graves** :

1. **Verrou de chat / double tour.** La garde introduit un **nouveau chemin
   terminal** (« aucun `chat.send`, message finalisé `context_length` ») à
   l'intérieur du handler `/send`, pendant que la ligne `outbox` est `pending`.
   La vérification proposée n'assert **jamais** l'état de l'outbox ni le drain.
   Or : si le bridge répond 200 après avoir finalisé lui-même, Convex marque
   `sent` (`A/convex/bridge.ts:1411-1414`) et attend un tour qui ne viendra
   jamais ⇒ `isChatBusy` reste vrai jusqu'au watchdog. S'il répond 502, on prend
   le chemin `failDispatch` + bulle d'erreur ⇒ **deux** bulles d'erreur pour un
   seul débordement.
   **Exigence manquante** : tout nouveau refus doit terminaliser via le **même**
   chemin (`failDispatch`) et le test doit asserter `outbox.status === "failed"`
   **et** `drainNextQueued` appelé.
2. **Allongement d'un handler synchrone sans borne.** `sessions.describe` est
   borné à 8 s (`A/bridge/src/server.ts:830-834`) ; une `sessions.compact`
   préventive sur une session à 265k tokens n'a **aucune** borne proposée, et le
   `fetch` côté Convex n'a **aucun** timeout (V5). Une compaction lente
   transforme un envoi en dispatch suspendu ⇒ §2.1.
   **Exigence manquante** : deadline explicite sur `compact`, plafond total du
   handler `/send`, et `AbortSignal.timeout` côté `A/convex/bridge.ts`.

### 4.2 W10 — le fail-CLOSED sans échappatoire est une panne auto-infligée

`resolveCapabilities` est une fonction **pure** sans porte opérateur
(`A/bridge/src/compat.ts:293-317`). Basculer en fail-closed signifie : le jour où
le NAS d'un client passe le gateway en 2026.7.2, des fonctions **qui marchaient**
disparaissent, et le **seul** remède est une release d'Atrium (banc live +
validation). Aujourd'hui PROD est aligné (`maxValidated 2026.7.1`, gateways
`2026.7.1`) — donc le lot ne coûte rien tout de suite et coûtera tout au premier
skew.
**Exigence manquante** : une échappatoire explicite, auditée et visible (env
opérateur ou drapeau admin `trustBeyondValidated`, tracé + bannière), sinon le
remède est plus douloureux que le mal.

### 4.3 W9 — hérite du canal cassé (§1) et écrit sur un backend saturable (§2.2)

Décision à corriger : la table dédiée est bonne, mais **l'anomalie de pont via
`upsertDetectorAnomaly` reproduit l'auto-résolution et l'écrasement d'evidence**.

### 4.4 W8 — bon lot, mais son ordre de livraison est faussé par A2

Le verdict affirme l'ordre « intact de bout en bout », ce qui justifie de reléguer
W8 en vague 4. Q9 (garde d'époque de `recoverDeliveredReply`) traite un défaut où
**la réponse du tour N écrit ET finalise le tour N+1** : c'est du même ordre de
gravité que W4, et le programme le reconnaît en le sortant en quick win. La
formulation du verdict crée le risque que W8 soit repoussé indéfiniment.

### 4.5 W5 — surface non nommée : la voix

Changer la classification des phases `tool` et l'armement des deadlines touche le
chemin que la voix emprunte (§2.6) sans qu'aucune suite ne le couvre.

---

## 5. Défaillances de production couvertes par AUCUN lot

| # | Défaillance | Preuve | Couverture |
|---|---|---|---|
| P1 | **`AGENT_RESTRICTED` récurrent** : 7 fenêtres d'anomalie sur 14 jours, `chatId` récurrent `mh777pfqvz…`. L'utilisateur envoie, ça échoue, il recommence : l'UI **laisse envoyer** puis affiche une erreur localisée (`A/src/chat/runStatusView.ts:206`, `:231`), alors que le dispatch sait dès `routing.target === null` (`A/convex/bridge.ts:1151-1167`) | PROD `list_anomalies` | **Aucun lot.** Absent du registre |
| P2 | **Saturation Convex → page d'erreur pleine** (« too many system operations ») | `memory/atrium-prod-listchats-saturation.md` ; `A/src/router.tsx:1226` | **Aucun lot** (§2.2) |
| P3 | **Latence croissante avec la longueur de la réponse** (2 × O(n²)) | `A/scripts/loadtest/STREAMING_FINDINGS.md` | **Aucun lot** (§2.3) |
| P4 | **Tour perdu au redémarrage du bridge** (chaque release) | V7, V8, `A/convex/lib/outboxQueue.ts:37-40` | **Aucun lot** (§2.4) |
| P5 | **Cécité du drift confirmée en prod** : `vendoredVersion 2026.6.11` contre gateways `2026.7.1`, `drift: []`, `gaps: 0` | PROD `get_compat` | G-59/G-66 le disent en théorie ; **la preuve terrain manque au programme** et devrait être son argument n°1 pour W10 |
| P6 | **Le go/no-go de déploiement voit les dispatches pendants mais n'agit pas** | `A/convex/activity.ts:151` | **Aucun lot** |
| P7 | Défauts de config gateway (timeout `before_prompt_build` 15 s, injections hors sujet) | `10-registre-prod.md:61-70` | Explicitement « remonter à l'opérateur » — **acceptable**, mais aucun lot ne livre la **mesure** qui rend la remontée factuelle (compteur d'injections, latence de pré-assemblage). « Atrium doit MESURER et NOMMER » est affirmé, pas outillé |

---

## 6. « Aucune chance de régression lors de l'ajout d'une version » : NON atteint

Le critère porte sur **une version de gateway**. Le programme (W10 + W11) le
traite sur l'axe gateway↔bridge. Il manque quatre choses, chacune capable de
produire une régression prod de bout en bout.

### 6.1 L'axe bridge ↔ Convex ↔ frontend n'a aucun ratchet

- Le contrat interne existe (`PROTOCOL_VERSION = 2`,
  `A/bridge/src/compat.ts:34`) mais il est **décoratif** : consommé uniquement
  pour l'affichage (`A/src/chat/admin/BridgeTab.tsx:304`) — jamais comparé à un
  minimum, jamais refusé (V14).
- La release ship **4 artefacts en lockstep** (2 images, 2 paquets npm ;
  `A/RELEASE.md:1-40`), et le **5ᵉ** — les fonctions et le **schéma** Convex —
  est déployé **à la main**, hors pipeline : « `npx convex deploy` — from the
  repo root, **re-run each release** » (`A/deploy/README.md:254`).
- Or la validation de schéma Convex est active (`A/convex/schema.ts:224`) : un
  bridge/frontend qui écrit un champ ou une **table** que le backend déployé
  ignore se fait **rejeter**. W1 (champs de jauge), W2 (`subAgents.errorCode`),
  W9 (**nouvelle table** `protocolShapes`) sont tous dans ce cas.
- Aucun ordre de déploiement n'est écrit, aucun test de fumée post-déploiement
  n'existe.

**Ce qui manque** : (a) faire de `PROTOCOL_VERSION` un contrat **exécutoire**
(`/health` du bridge annonce `requiredConvexContract` ; Convex annonce le sien ;
divergence ⇒ refus **nommé** + bannière) ; (b) mettre `convex deploy` **dans** le
pipeline de release, avant la bascule d'image ; (c) un smoke post-déploiement qui
exerce un tour synthétique par le contrat d'ingest (le harnais existe déjà :
`A/scripts/loadtest/run.mjs`, côté écriture = `POST /bridge/ingest`).

### 6.2 Le gate de version vit hors du dépôt

La skill obligatoire (`<hors-dépôt>/skills/add-gateway-version/SKILL.md`) et **tout**
le banc (`<hors-dépôt>/live-bench/` : `gateway-swap.sh`,
`run-live-bench.mjs`, `upstream-diff.sh`, `upstream-watchlist.txt`) sont **hors
du dépôt validé**, et aucun fichier de `A/.github/workflows/` ne les référence
(V17). W11 veut vérifier en CI une **preuve signée** (`BENCH.json`) — mais le
**producteur** de la preuve n'est pas versionné avec le code qu'il valide : on
peut modifier le banc (ou perdre le poste de travail) sans qu'aucun rouge
n'apparaisse.

**Ce qui manque** : vendorer le harnais dans le dépôt (ou, au minimum, exiger
dans `BENCH.json` le **commit + hash** du harnais et le vérifier en CI), et
déplacer la skill dans `A/.claude/skills/` — le dépôt le fait déjà pour
`release-notes` (`A/RELEASE.md:23`).

### 6.3 Le corpus doré ne couvre que la frontière du normalizer

W11 compare des `BridgeEvent[]` normalisés. Une version de gateway peut régresser
**au-delà** : mutation Convex refusée, invariant de file cassé, rendu frontend
(les trois zones de §2). Il manque un étage « contrat d'ingest » (rejouer le
corpus doré **jusqu'aux mutations Convex**, avec assertions sur l'état final :
message terminal, `outbox` terminal, file drainée, parts ordonnées) — c'est
faisable en `convex-test`, hermétique, et ça fermerait §2.1/§2.5 par la même
machine.

### 6.4 Pas de chemin de retour arrière prouvé

`gateway-swap.sh <version précédente>` restaure le **banc**, pas la production.
Rien ne décrit le retour arrière côté prod (image bridge + `validatedVersions` +
Convex déjà déployé). Et §4.2 montre qu'après W10, un skew de gateway côté client
n'a **aucune** échappatoire hors release.

**Verdict sur le critère** : le programme rend l'ajout d'une version *beaucoup*
plus sûr sur l'axe qu'il traite. Il **n'atteint pas** « aucune chance de
régression », parce que la régression la plus probable au moment d'un ajout de
version n'est pas une trame mal lue : c'est un **déploiement partiel** (image
sans `convex deploy`), un **bridge redémarré** qui jette les tours en vol, ou une
**capacité fermée** sans échappatoire.

---

## 7. Registre des manques (synthèse)

| id | Sévérité | Manque | Preuve principale |
|---|---|---|---|
| C-01 | critical | Chaîne de signal : détecteur générique + auto-résolution + evidence écrasée ⇒ la prémisse « aucune sonde » est fausse ; W9 hérite du canal | `anomalies.ts:247-292`, PROD 20/07 |
| C-02 | critical | Aucune réconciliation des `outbox` `pending` ⇒ verrou permanent de chat ; `fetch` sans timeout | `bridge.ts:206`,`:283`,`:1331` ; `crons.ts` |
| C-03 | critical | `convex deploy` hors release lockstep + `PROTOCOL_VERSION` décoratif ⇒ déploiement partiel non détecté | `RELEASE.md:1-40`, `deploy/README.md:254`, `BridgeTab.tsx:304` |
| C-04 | high | W2 : nouveau chemin terminal sans assertion outbox/drain, compaction sans deadline | W2 §Vérification ; `server.ts:830-834` |
| C-05 | high | Redémarrage du bridge : pas de drain SIGTERM, pas de récupération d'historique au boot, 5 min de fausse activité | `index.ts:248-262`, `stuckStreams.ts:346`,`:410-415` |
| C-06 | high | Coût réactif du chemin de lecture jamais mesuré ni borné ; erreur de route = conversation blanche | `messages.ts:203-270`, `router.tsx:1226` |
| C-07 | high | Latence perçue / charge absentes du programme alors que deux O(n²) sont documentés dans le dépôt | `STREAMING_FINDINGS.md`, `loadtest/README.md:6` |
| C-08 | high | `AGENT_RESTRICTED` récurrent en prod, non couvert, UI non gardée | PROD ×7 ; `bridge.ts:1151-1167` |
| C-09 | high | Invariant file/busy/préemption sans propriétaire alors que W2/W4/W8 le touchent | `lib/outboxQueue.ts:96-104`,`:167-170` |
| C-10 | high | Gate de version hors dépôt (skill + banc) ⇒ W11 vérifie une preuve non versionnée | V17 |
| C-11 | medium | W10 fail-closed sans échappatoire opérateur | `compat.ts:293-317` |
| C-12 | medium | A2 : le verdict contredit W8 sur l'ordre ⇒ risque de déprioriser Q9/W8 | `run-manager.ts:401-731` |
| C-13 | medium | A4/A5 : chiffres de la jauge incohérents avec la preuve prod ; le hors-compte n'est pas un critère de W1 | PROD `jh7ctw46…` |
| C-14 | medium | Corpus doré arrêté au normalizer : pas d'étage « contrat d'ingest → état Convex » | W11 §contenu |
| C-15 | medium | Voix/talk : même pipeline, aucune suite, aucun lot ne la nomme | `talk-consult.ts:1-23` |
| C-16 | low | Isolation multi-tenant/authz hors périmètre d'un programme 1.0.0 SOC2 | historique IDOR, ingest per-bridge |
| C-17 | low | Blobs orphelins : pas de balayage (NON PROUVÉ) | `stream.ts:1099`,`:1183` |

---

## 8. Questions ouvertes que cette critique ajoute

1. Combien de lignes `outbox` `pending` d'âge > 10 min existent en prod
   aujourd'hui ? (répond à C-02, mesurable immédiatement)
2. `convex deploy` a-t-il déjà été oublié ou retardé lors d'une release ? Si oui,
   quel a été le symptôme client ? (C-03)
3. Le `chatId` récurrent des `AGENT_RESTRICTED` est-il un chat d'utilisateur ou
   une tâche automatisée (cron/curation) qui réémet en boucle ? (C-08)
4. Quel est le vrai plafond de contexte du modèle utilisé le 20/07, et quel est
   l'écart mesuré entre tokens comptés et prompt assemblé ? (C-13 ; conditionne
   la définition même d'une jauge « honnête »)
5. Le transport SSE est-il actif en prod, et l'amplification de push a-t-elle été
   remesurée depuis ? (C-07)
6. Accepte-t-on de faire de `convex deploy` une étape CI (donc de donner à la CI
   un accès de déploiement au backend prod) ? Sinon, quel garde-fou remplace
   l'ordre de déploiement ? (C-03)
