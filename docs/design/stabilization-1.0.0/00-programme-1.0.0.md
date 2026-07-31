# Programme de stabilisation Atrium 1.0.0

Document de référence du chantier. Synthèse des huit rapports de reconnaissance
(`01`…`08`) et du registre de production (`10-registre-prod.md`), dédupliquée,
hiérarchisée par impact utilisateur réel, et découpée en lots livrables
indépendamment.

## État d'avancement au 2026-07-28

Vérifié **contre le code**, pas contre un souvenir : chaque « livré » ci-dessous a été
confirmé par un artefact distinctif présent dans le dépôt (le bandeau de la section le
nomme). Cette table existe parce que le 27/07 un scan du document laissait croire que
cinq vagues livrées ne l'étaient pas — seules W2 et W10 portaient un bandeau.

| Vague | Sujet | État |
|---|---|---|
| W1 | Jauge de contexte honnête | **livré** — lot 3 |
| W2 | Défense contre le débordement de contexte | **livré** — lot 13 |
| W3 | Perte de trames, fin de connexion nommée | **livré** — lots 4 et 6 |
| W4 | Intégrité de la réponse | **livré** — lot 11 |
| W5 | Vocabulaire `agent.data` | **livré** — lot 12 |
| W8 | Sérialisation interne, écritures robustes | **livré** — lots 7 à 10 |
| W10 | Cliquet de version, fin du fail-open | **TERMINÉE** — lots 14 à 22 (G0, G1, **G2 sur 26 méthodes**, G3, G7, Q21, Q24 ; toute la surface RPC sous contrat, **596 entrées** classées, 6 défauts réels corrigés) |
| W6 | Tours Hermes bornés | **TERMINÉE** — lots 29, 30, 31, atteints comme reports en chaîne du lot 28 et non comme vague planifiée. G-37 (tour zombie 12 min, fuite d'abonné) est fermée sur les DEUX transports ; G-40 (sortie amont sans terminal) est couverte par l'échéance. **W6 TERMINÉE** : G-36 au lot 32, G-38 **et G-39** au lot 33, G-41 au lot 45, G-42 au lot 37. Le report « Stop pendant le silence », ouvert au lot 31, est fermé au lot 45 — même mécanisme que G-41 |
| W7 | Contenu et continuité de session Hermes | **TERMINÉE** — G-43 (lots 34+35), G-44 (34), G-45 (38), G-46 (36), G-48 (41), G-49 (44), G-50 (39), G-51 (42), G-52 (43). G-47 fermée au **lot 48**, en refonte : la première tentative avait été ANNULÉE avant commit, ses tests étant verts sur un état initial que la production ne produit jamais — et la faute est revenue par une autre porte à la 3ᵉ passe de revue du lot 48 (`parseSendBody` reconstruisait le corps sans la poignée) |
| W12 | Conscience de version Hermes | **au périmètre depuis la décision produit du 28/07** — le motif du report (« aucune instance Hermes en production ») est mort : Hermes tourne sur le VPS client. État réel : **G-55 fermée au lot 46** (la version arrive par `session.info`, une règle de schéma unique aux trois portes, l'overlay résout chaque capacité à son propre minimum). **Restent G-56 et G-58 (tranches 2+ : surface WS par AST, détecteur de drift à l'exécution, lockstep features)** ; G-57 est traitée en pratique par la règle de schéma du lot 46 plus (`maxValidated` est à 0.19.0 avec attestation). **G-56 est mesurée SANS MORDANT (30/07)** : Atrium n'utilise rien au-delà du palier 2 de `DESKTOP_BACKEND_CONTRACT`, déjà déclaré par 0.17.0 — une garde ne pourrait pas se déclencher. **G-74 est fermée** : les deux affirmations fausses de `docs/design/protocol-schema-coverage.md` portent leur correction datée (26/07 pour la justification « ordered WS », 30/07 pour « structural placeholder with zero capabilities »), et `/capabilities` expose bien pour Hermes un provider, une version et des capacités résolues avec l'overlay de transport. **Correction du 30/07** : la phrase qui suivait affirmait que le seul artefact Hermes sous `bridge/protocol/` était `BENCH.json` — c'est faux depuis le lot 47. L'état réel est `hermes/0.19.0/` = `BENCH.json`, `rest-contract.json`, `rest-contract.source.py`, `PROVENANCE.json`, plus un cliquet de chemins. Restent absents, et c'est le périmètre de G-58 : pas d'artefact de coverage, pas de détecteur de drift |
| W9 | Auto-découverte des trames non traitées | **tranches 1 et 2a livrées** — lots 23 et 28 (points 6 et 8 : `KNOWN_AGENT_FIELDS` dérivé du vendoring, drift par état, débordements comptés bout en bout, auto-échec du détecteur ; puis le capteur d'exception C4 sur les sept lecteurs). **Le point 4 est livré au lot 38** — la table `protocolShapes` existe (`convex/schema.ts:1453`), le registre des formes est durable et triable. **Reste la tranche 2b** : points 1, 3, 5, 7, 9, 10 |
| W11 | Corpus doré, banc attesté, lockstep | **TERMINÉE** — lots 24, 25 et 26 (corpus doré rejouable + garde de fidélité ; `validatedVersions` adossé à une attestation ; partition front ⟷ manifeste + fixture régénérée, un défaut de résolution Hermes en prod corrigé au passage) |

**MESURE DU 30/07 — G-56 n'a pas de dents aujourd'hui, et c'est un fait, pas un avis.**
Atrium a besoin du palier **2** du `DESKTOP_BACKEND_CONTRACT` (c'est lui qui ajoute
`file.attach`, dont dépend `inboundAttachments`) et n'utilise **rien** des paliers 3
(`approvals.mode`) ni 4 (`session.create fast=false`). Or le palier 2 est déjà déclaré par
**0.18.0** (`v2026.7.1`) — et même par **0.17.0**, sous le plancher supporté. Sur toute la
plage supportée, et en dessous, le contrat est donc **toujours suffisant** : un garde
construit maintenant ne pourrait jamais se déclencher, exactement comme le lockstep
`features` écarté au lot 47 et la garde tautologique du lot 25. **À rouvrir le jour où Atrium
utilise une capacité d'un palier supérieur**, pas avant.

**DÉCISION PRODUIT (2026-07-28) : Hermes est aussi essentiel qu'OpenClaw.**
Hermes tourne sur le VPS client et doit être parfaitement branché à Atrium. Le motif
du report de la vague 3 — « aucune exposition production » — **tombe**. W6, W7 et W12
rentrent au périmètre au même rang que le reste, et la vague 3 cesse d'être « nécessaire
au titre de P5 » pour devenir bloquante pour la 1.0.0.

Trois faits mesurés le jour de la décision, à ne pas confondre :
1. **La validation se fait en LOCAL, jamais sur le VPS.** Erreur de cadrage corrigée le
   29/07 : j'avais réclamé l'URL de l'Atrium du VPS « pour mesurer l'instance réelle et
   lancer la validation live » — c'est-à-dire tester en PRODUCTION, ce que ce projet ne
   fait pas (règles `autonomous-live-local-testing` et `verify-live-local-before-deploy`).
   Le VPS n'est qu'une surface d'OBSERVATION via ses MCP ; il ne sera jamais une cible de
   test. Le banc est local et il EXISTE déjà : conteneur `hermes-bench`
   (`nousresearch/hermes-agent`), gateway WS sur `127.0.0.1:18642`, plus `dev.sh` et le
   harnais `live-bench/`.
2. **ÉCART DE VERSION ENTRE LA SOURCE CITÉE ET LE BANC — constat du 29/07.** Le
   conteneur de banc sert **0.18.2** (`GET /health` local), qui est exactement ce que
   `COMPAT_MANIFEST` valide — tandis que la source amont vendorée pour lecture, et donc
   **toutes les citations `fichier:ligne` des lots 32 à 37**, sont en **0.19.0**
   (tag `v2026.7.20`). Les lots restent valides (les repères lus existent bien en 0.19.0)
   mais ils n'ont PAS été exercés contre la version qu'ils citent. Deux façons de fermer
   l'écart : monter le banc local en 0.19.0 — c'est le lot de validation prévu — ou citer
   0.18.2. La première est la bonne : elle fait gagner l'attestation en même temps.
   `COMPAT_MANIFEST` valide Hermes jusqu'à 0.18.2 (`bridge/src/compat.ts:245`) alors
   que l'amont est en **0.19.0** (`pyproject.toml:10`). Une instance 0.19.0 n'est donc pas
   coupée — le cliquet **gèle** le profil 0.18.2 — mais elle affiche le bandeau « version
   au-delà du validé » et se voit refuser toute capacité introduite depuis. « Parfaitement
   branché » exige donc une **validation live de 0.19.0** avec son attestation (lot 25).
3. **G-36 est confirmée dans la source ET en amont**, et la conception est tranchée par
   une observation : les trames ne portent que `session_id`, **aucune corrélation par
   tour** (vérifié sur `ws-capture.jsonl`). Deux tours Atrium sur une même session runtime
   ne sont pas démultiplexables — la seule voie honnête est d'empêcher le second
   abonnement, pas de trier après coup.

**INCIDENT RÉSOLU (29/07) : la source amont Hermes avait été effacée, elle est
restaurée AILLEURS.** Le nettoyage périodique de `/tmp` a vidé
`/tmp/hermes-upstream.okb8T2` à minuit — y compris son `.git` (plus de pack, plus de
HEAD), donc irrécupérable sur place. Origine retrouvée dans le `FETCH_HEAD`
survivant : `github.com/NousResearch/hermes-agent`, tag **v2026.7.20**. Recloné et
vérifié : le tag annoté `c7d08de` pointe sur le commit **`3ef6bbd`**, celui-là même
des lots précédents, et les repères lus aux lots 33 et 36
(`_sync_session_key_after_compress:3516`, `raw = f"Error: …"`) sont aux mêmes lignes.

**LEÇON D'OUTILLAGE : une source de vérité ne vit pas dans `/tmp`.** Tout ce
programme trace ses affirmations à un `fichier:ligne` amont ; les héberger dans un
répertoire que le système balaie rendait chaque preuve périssable. `$HE` désigne
désormais un emplacement DURABLE, hors de tout dépôt (ni Atrium, ni les notes) :
`<workspace>/hermes-upstream`.

**LOT G-47 ANNULÉ AVANT COMMIT (28/07).** Écrit, testé vert, puis reverté sur les
constats de revue : le terminal `transport_lost` **efface la session** (lots 31-32),
donc l'envoi suivant n'a plus rien à reprendre et `inflight.assistant` n'est jamais
lu ; et la mutation exigeait que le dernier message soit l'assistant alors que `send`
insère le message UTILISATEUR avant de dispatcher. Les tests étaient verts sur un
**état initial que la production ne produit jamais**. Conception correcte consignée :
un handle de récupération DISTINCT, en lecture seule, séparé de `openclawChatId`.
Règle ajoutée : *avant d'écrire une assertion, dire quelle séquence de production
amène le système dans cet état.*

**~~PROCHAIN LOT PRÊT (W9 tranche 2b, point 4)~~ — LIVRÉ au lot 38.** La dérive
protocole était un **instantané** : le bridge la tenait en mémoire, `convex/compat.ts`
la pliait et la rangeait en `protocol: v.any()` sur la ligne compat, écrasée à chaque
sondage. Elle mourait avec le processus et personne ne la triait. Le lot 38 a créé la
table `protocolShapes` (forme, provider, instance, première/dernière vue, compte,
`status` de triage) alimentée par le sondage existant, ce qui rend MESURABLE
l'indicateur de sortie n° 3 du programme (« `protocolShapes` en `status:"new"` non
triées ⇒ 0 après une semaine »). Le registre dit désormais aussi ce qu'il n'a **pas**
vu, et non seulement ce qu'il a rencontré.

**PROCHAIN LOT PRÊT (W9 tranche 2b, point 7 — G-70) — non bloqué.** La passerelle
**publie déjà** le catalogue de ce qu'elle émet (`hello-ok.features.events` côté
OpenClaw, `/v1/capabilities` côté Hermes) et Atrium ne le lit pas : il découvre les
formes en les subissant. Lire ce catalogue à la connexion transforme la découverte
de **réactive** en **proactive** — une forme annoncée mais jamais traitée devient une
lacune connue AVANT qu'un utilisateur la rencontre, au lieu d'après.

**Correction de cap, à dire plutôt qu'à laisser filer (28/07)** : les lots 29 à 31 ont
été ouverts comme reports en chaîne du lot 28 et se trouvent être du **W6**, la vague
explicitement reportée faute d'instance Hermes en production. Le travail est bon — il
ferme une lacune **C**ritique — mais le raisonnement « pas d'exposition prod » a été
érodé sans décision. À trancher avant d'en ouvrir un quatrième : soit W6/W7 rentrent au
périmètre, soit on s'arrête là sur Hermes.

**Règle de tenue** : un lot n'est pas fini tant que le bandeau de sa section ne dit pas
ce qui a été livré, ce qui reste, et ce qui a été DÉCIDÉ de ne pas faire — avec la
raison. Un document qui ne se relit pas coûte un lot entier de re-découverte.

---

**Statut de lecture** : toutes les affirmations de ce document sont tracées à un
`fichier:ligne` réel. Les faits marqués **(V)** ont été re-vérifiés directement
sur disque pendant la rédaction de ce programme (lecture seule). Ce qui n'est pas
prouvé est marqué **NON PROUVÉ** avec la lecture à faire pour trancher.

Conventions de chemins :
- Atrium : chemins relatifs à `<workspace>/atrium`
- `$UP` : OpenClaw amont @ `v2026.7.1` (`…/scratchpad/upstream/openclaw`, HEAD `2d2ddc43`)
- `$HE` : Hermes amont @ `0.19.0` / tag `v2026.7.20`, commit `3ef6bbd`
  (`<workspace>/hermes-upstream` — DURABLE, plus jamais `/tmp`)

---

## 1. Verdict — l'état réel de la stabilité

Atrium n'est pas un logiciel fragile dans son cœur : l'isolation par `sessionKey`
est doublée, l'ordre par connexion est intact de bout en bout, les échéances sont
absolues sur horloge injectée, et **aucune classe de défaut corrigée n'est
revenue** (`10-registre-prod.md:50-52`). Le problème n'est pas la qualité des
correctifs — c'est que **le système ne se plaint jamais avant l'utilisateur**.
Quatre classes distinctes de défauts de trames en cinq jours (19, 21, 22,
23/07) : les quatre ont été signalées par un utilisateur, aucune par un test, une alerte
ou une sonde (`10-registre-prod.md:44-48`).

Trois causes structurelles expliquent presque tout le reste.

**(1) La mesure du contexte est fausse, et c'est le seul défaut encore actif.**
`activeTokens` (jauge) et `sessionMeta.totalTokens` sont **le même champ amont**
`SessionEntry.totalTokens` lu à deux instants : `bridge/src/core/turn-sink.ts:1428`
prend `pendingDiagUsage.totalTokens`, aplati depuis l'événement `agent`, tandis
que `bridge/src/server.ts:628` prend `sess.totalTokens` du `sessions.describe`
**(V)**. Le commentaire `convex/schema.ts:1068-1072` affirme que le premier est
« REAL window usage » et le second « CUMULATIVE » : c'est une mésattribution. Sa
dérivation amont retombe sur l'accumulateur **cumulatif** du run
(`$UP/src/agents/usage.ts:335` + `$UP/src/agents/command/session-store.ts:210-217`),
et la garde anti-absurde `used > contextTokens ⇒ null` ne s'applique **pas** à
`activeTokens` (`src/chat/sessionKnobs.ts:122-126` : retour prioritaire) **(V)**.
C'est le 179k affiché contre >308k réel du 20/07. Quatre débordements en trois
jours, tous soldés par « l'utilisateur perd son tour et réinitialise à la main »
(`10-registre-prod.md:31-36`).

**(2) La perte de trames est structurellement invisible.** Le gateway abandonne
volontairement des trames sur consommateur lent en **avançant quand même** le
compteur (`$UP/src/gateway/server-broadcast.ts:174-179`), et il émet lui-même le
diagnostic (`agent`, `stream:"error"`, `data.reason:"seq gap"`,
`$UP/src/gateway/server-chat.ts:1272-1287`, épinglé
`$UP/src/gateway/server-chat.agent-events.test.ts:4623-4662`). Atrium ne lit
`seq` que comme clé de déduplication (`normalizer.ts:875`, seule occurrence)
**(V)** et n'a **aucune branche** `stream === "error"`. La plainte client
« trames dans le désordre / réponse tronquée » a donc une cause candidate
**mesurable gratuitement et non mesurée**.

**(3) Le contrat amont n'est pas autoritaire, et le ratchet est débranché.**
`AgentEventSchema` déclare `additionalProperties: false`
(`$UP/packages/gateway-protocol/src/schema/agent.ts:57-67`) alors que le gateway
diffuse sans aucune validation de sortie (`$UP/src/gateway/server-broadcast.ts:189-197`) :
l'événement `agent` déclare 7 champs et en porte jusqu'à ~58 sur le fil
(`$UP/src/gateway/server-chat.ts:466-519`). En face, `bridge/protocol/openclaw/`
ne contient **qu'un** répertoire `2026.6.11` de **5 fichiers**, alors que
`bridge/src/compat.ts:167` déclare `maxValidated: "2026.7.1"` **(V)** — le
ratchet CI compare donc le manifeste à un schéma périmé : **no-op silencieux**.
Cinq additions de contrat 7.1 sont entrées dans le support sans qu'aucune machine
ne les présente à un humain, et 15 des 20 méthodes RPC réellement appelées
(cron, sessions, tasks, config, models) n'ont **aucun** garde-fou.

À quoi s'ajoutent deux asymétries lourdes. Côté Hermes, `dispatch.ts:824`
retourne `gatewayVersion: null` **en dur** sur le transport par défaut **(V)** :
tout le manifeste compat Hermes est du code mort, et l'amont vient de passer son
contrat GUI↔backend de 2 à 4 (`$HE/tui_gateway/server.py:3726`) sans qu'Atrium le
sache. Côté écriture, `TurnSink.apply` est une simple boucle `for` sans
sérialisation (`bridge/src/core/turn-sink.ts:489-501`) **(V)** — le chemin Hermes
a exactement la sérialisation qui manque au chemin OpenClaw
(`bridge/src/providers/hermes/ws-turn.ts:259-265`) — et `recoverDeliveredReply`
n'a **aucune** garde d'époque (`bridge/src/session.ts:872-899`) **(V)**, donc la
réponse récupérée du tour N peut écrire **et finaliser** le tour N+1.

Conclusion : la 1.0.0 ne demande pas une réécriture. Elle demande **une mesure
honnête, une détection de perte, une politique d'admission stricte, et un
processus de version qui refuse par la machine**. Tout le reste est du
durcissement qui peut attendre.

---

## 2. Principes du programme (contraintes non négociables)

| # | Principe | Origine |
|---|---|---|
| P1 | Un lot doit être implémentable, vérifiable et déployable **seul** | exigence de mission |
| P2 | Chaque test doit **ÉCHOUER** si sa cible régresse | mémoire `atrium-test-quality-standard` |
| P3 | Les traces ne portent **jamais** de contenu conversationnel : noms de champs, compteurs, codes stables | contrainte SOC2 du dépôt |
| P4 | On corrige le défaut et on rend l'action dangereuse impossible ; on ne prescrit **jamais** un contournement à l'utilisateur | mémoire `no-user-workaround-advice` |
| P5 | Toute feature est conçue pour **LES DEUX** providers | mémoire `design-agent-does-the-work-both-providers` |
| P6 | Une erreur non gérée n'invalide **jamais** le bridge (robustesse Mars) | mémoire `atrium-bridge-mars-robustness` |
| P7 | Pas de release pour de l'instrumentation seule : l'obs voyage avec un lot correctif | mémoire `release-only-for-corrective-fixes` |
| P8 | Une troncature ne doit **jamais** être silencieuse | `bridge/src/providers/openclaw/run-manager.ts:658-673` (précédent du dépôt) |
| P9 | Quand une valeur manque au diagnostic, on enrichit l'obs MCP | mémoire `atrium-improve-obs-mcp-on-diagnostic-gaps` |
| P10 | La frontière Atrium / config gateway doit être **dite**, jamais floue | `10-registre-prod.md:72-75` |

---

## 3. Registre de lacunes consolidé

90 constats des huit zones fusionnés en **73 lacunes** distinctes. Colonne
« Zones » = les rapports qui décrivent la même lacune sous un angle différent (la
fusion ne perd rien : chaque preuve des rapports sources reste valable).
Colonne « Sév. » : C = critique, H = haute, M = moyenne, B = basse.

### 3.1 Contexte : mesure et débordement — la seule classe encore ACTIVE en prod

| ID | Lacune | Sév. | Zones | Preuve clé | Lot |
|---|---|---|---|---|---|
| G-01 | `activeTokens` et `totalTokens` sont **le même champ amont** lu à deux instants ; la jauge peut afficher un cumul de run comme un remplissage de fenêtre (179k affichés / mur à 308k) | **C** | 5 | `turn-sink.ts:1428` vs `server.ts:628` **(V)** ; dérivation `$UP/src/agents/usage.ts:335` + `$UP/src/agents/command/session-store.ts:210-217` ; commentaire faux `convex/schema.ts:1068-1072` | W1 |
| G-02 | `contextBudgetStatus` (l'estimation de prompt du gateway lui-même, avec `overflowTokens`) est sur le fil et jeté | H | 5 | produit `$UP/src/agents/embedded-agent-runner/run/preemptive-compaction.ts:428-467` ; exposé `$UP/src/gateway/session-utils.ts:2407-2408` ; jeté `server.ts:614-630` **(V)** | W1 |
| G-03 | `totalTokensFresh = false` (« ce compteur est périmé ») ignoré ; la jauge fige un vieux % | H | 5 | émis `$UP/src/gateway/session-utils.ts:2387` + `session-event-payload.ts:73` ; l'amont s'en sert lui-même `$UP/src/auto-reply/reply/agent-runner-memory.ts:837-840` ; Atrium le sait et l'ignore `protocol-drift.ts:78` | W1 |
| G-04 | Aucune garde pré-envoi, alors qu'un `sessions.describe` est **déjà** fait avant chaque envoi | H | 5 | describe `server.ts:828-859` **(V)** ; envoi inconditionnel `server.ts:1055` ; RPC de remédiation déjà câblées `server.ts:1167-1174` | W2 |
| G-05 | Un context engine `ownsCompaction:true` désarme **à la fois** la compaction auto native et le precheck pré-prompt → plus aucune garde pré-vol (config gateway) | **C** | 5 | `$UP/src/agents/embedded-agent-runner/run/attempt.ts:4843-4853` ; `$UP/src/agents/agent-settings.ts:174-184` ; contrat `$UP/src/context-engine/types.ts:9-37` | W2 (opérateur) |
| G-06 | La garde mi-tour conçue **exactement** pour ce symptôme est off par défaut (config gateway) | H | 5 | gating `$UP/…/run/attempt.ts:2729-2730` ; aide de config `$UP/src/config/schema.help.ts:1531-1532` (« long tool-heavy sessions hit context overflow before turn-end compaction ») | W2 (opérateur) |
| G-07 | L'échec overflow est terminal ET répétable ; la carte conseille `/reset`, qui n'existe pas dans Atrium (violation P4) | H | 5 | terminal `$UP/src/agents/embedded-agent-runner/run.ts:3032-3035` ; carte `src/chat/runStatusView.ts:179` ; mutations de sortie existantes `src/chat/SessionPanel.tsx:152-153` | W2 |
| G-08 | **PARTIELLEMENT LIVRÉ (lot 12)** — Une compaction **échouée** (`completed:false`) est traitée comme réussie : aucun marqueur, budget de silence revenu à 240 s | M | 3 | amont `$UP/src/agents/embedded-agent-subscribe.handlers.compaction.ts:152-160` ; Atrium `normalizer.ts:1297-1308` ; prouvé par exécution (`probe2.mjs` cas D → `[]`) | W5 |
| G-09 | **CORRIGÉ DANS LE CONSTAT (2026-07-26)** : `reason` EST sur le fil — `emitSessionOperation(context, {operationId, operation:"compact", phase:"end", sessionKey, completed, reason})` dans le build 2026.7.1 déployé. Le manque est donc UNIQUEMENT l'abonnement (`sessions.subscribe {}`, scope read) ; attention, l'événement part avec `dropIfSlow:true` — il peut être PERDU pour un consommateur lent, donc l'heuristique de rotation reste un repli obligatoire. — La cause de compaction (`overflow`/`threshold`/`manual`) est calculée puis jamais mise sur le fil ; le seul événement porteur (`session.operation`) n'est pas souscrit | H | 1, 3 | calcul `$UP/…/handlers.compaction.ts:35-43` ; émission sans `reason` `:61-65`, `:151-155` ; porteur `$UP/packages/gateway-protocol/src/schema/sessions.ts:23-35` ; `grep sessions.subscribe bridge/src` → 0 | W2 |
| G-10 | La rehydratation est bornée en **caractères** seulement (hypothèse 3 car/tok optimiste), aucun plafond en tokens sur l'ensemble composé | M | 5 | `convex/lib/rehydration.ts:19`, `:88-91` **(V)** ; ratios amont plus prudents `$UP/…/run/preemptive-compaction.ts:26-27` (2 car/tok sur tool results) + marge 1.2 `$UP/src/agents/compaction-planning.ts:17` | W2 |
| G-11 | Un overflow de **sous-agent** n'est jamais classé (table `subAgents` sans `errorCode`) : texte brut illisible, invisible en obs | M | 5 | schéma `convex/schema.ts:1354-1380` ; classifieur existant non appliqué `normalizer.ts:129-133` + `convex/lib/chatRenderState.ts:58-88` ; cas amont épinglé `$UP/src/agents/subagent-registry.test.ts:2440` | W2 |
| ~~G-50~~ **FERMÉE (lot 39)** | Hermes : `compressions` (compteur de compactions), `context_percent`, `active_subagents`, `calls` jetés ; **aucune** donnée d'usage sur le transport REST | M | 2, 4 | amont `$HE/tui_gateway/server.py:3605-3662` ; Atrium ne lit que 2 champs `hermes/ws-turn.ts:609-611` ; REST `hermes/normalizer.ts:275` | W1 |

### 3.2 Réponse fausse ou perdue — ce que l'utilisateur voit comme « le bot répond à côté »

| ID | Lacune | Sév. | Zones | Preuve clé | Lot |
|---|---|---|---|---|---|
| G-12 | Un run **ÉTRANGER** de la même session est adopté pendant la grâce (10 s lifecycle, **900 s** compaction) et devient la réponse de l'utilisateur, en fermant son tour | **C** | 1, 3, 6 | `normalizer.ts:733-746` **(V)** ; fenêtre `normalizer.ts:81`, `:92` ; prouvé par exécution (`probe2.mjs` cas E : `chat:final{runId:"heartbeat-run-42"}` devient la réponse) ; runs concurrents réels `$UP/docs/concepts/queue.md`, heartbeats `$UP/src/gateway/server-chat.ts:1199`, injections `$UP/src/gateway/server-methods/chat.ts:6019-6034` ; discriminant `isHeartbeat` disponible et non lu (`$UP/packages/gateway-protocol/src/schema/agent.ts:64`) | W4 |
| G-28 | `recoverDeliveredReply` n'a **aucune** garde de `turnEpoch` : la réponse récupérée du tour N est écrite **et finalise** le tour N+1 | **C** | 6 | `bridge/src/session.ts:872-899` **(V)** (aucune capture d'époque autour d'un RPC de 10 s) ; grâce concurrente `normalizer.ts:91` (5 s) ; contraste `session.ts:699`, `:737-741` (l'orphan recovery, lui, capture `boundEpoch`) | W8 |
| G-13 | Le `chat.final` du chemin `broadcastChatFinal` est tronqué à **8 000 caractères** avec le marqueur littéral `...(truncated)...` et persisté tel quel | **C** | 1 | `$UP/src/gateway/server-methods/chat.ts:2752` → `chat-display-projection.ts:1795-1800` → `:27` (8_000) → `:52-62` ; chemin utilisé par Atrium `$UP/…/chat.ts:5424-5430` ; aucune détection (`grep truncated bridge/src/providers/openclaw/` → commentaires seuls) | W4 |
| G-14 | Rien n'empêche un snapshot **plus court** d'écraser le texte déjà écrit (Convex ne garde que la génération) | H | 6 | `normalizer.ts:1424-1425` (last-wins) → `turn-sink.ts:659-672` ; cas déjà survenu en prod et rustiné en aval seulement `convex/stream.ts:1560-1578` | W4 |
| G-15 | La déduplication des trames chat n'a **qu'un seul emplacement** : une retransmission non adjacente (A,B,A) repasse | M | 6 | `normalizer.ts:436` (`lastDedupKey` scalaire), `:880-883` ; rejeu amont documenté `docs/design/upstream-interpretation-comparison.md:305-317` (`meta:{cached:true}`) | W4 |
| G-16 | `args` de message-tool illisible ⇒ **texte de réponse perdu**, sans compteur ni log | H | 8 | `normalizer.ts:1519-1527` (`return ""`) ; le tour finit alors « vide » | W4 |
| G-17 | Le flux `assistant` ignore `data.phase` (`"commentary"`), `data.itemId` et `data.replace` : le préambule peut verrouiller le buffer via `hasSnapshot` | M | 3 | amont `$UP/src/agents/embedded-agent-subscribe.handlers.messages.ts:682`, `:802-810` ; Atrium `normalizer.ts:1052-1067` **(V)** puis verrou `:1429-1431` ; **NON PROUVÉ** que l'ordre défavorable se produise (capture `BRIDGE_FRAME_DUMP=commentary` requise) | W4 |
| G-18 | `chat.side_result` porte du contenu produit par l'agent (« by the way ») et est intégralement jeté ; le final vide qui suit arme 90 s de grâce puis `empty_response_silent` | M | 1, 3 | amont `$UP/src/gateway/server-methods/chat.ts:795-804`, `:2778-2798`, déclencheur `:4963-4970` ; filtre Atrium `normalizer.ts:697-701` **(V)** ; **NON PROUVÉ** atteignable depuis un `chat.send` Atrium (branche `!agentRunStarted`, `$UP/…/chat.ts:4960`) | W4 |
| G-19 | **LIVRÉ (lot 1)** — Toute phase de `tool` ≠ `"start"` est traitée comme **terminale** : `phase:"update"` produit un faux « completed » et **consomme les arguments** | H | 3 | `normalizer.ts:1205-1242` **(V)** (`if (phase === "start") … else { terminal }`, `toolArgs.delete`) ; amont `$UP/…/handlers.tools.ts:1191-1201` ; prouvé par exécution (`probe-tool-update.mjs`) ; effets `turn-sink.ts:679-690` (compteur faussé), `:692-720` (gate spawn/yield défait) | W5 |
| ~~G-43~~ **FERMÉE (lot 34+35)** | Hermes : `message.interim` jeté ⇒ le texte streamé **disparaît** quand `message.complete` remplace le buffer (l'amont documente explicitement ce risque) | H | 2, 4 | `$HE/tui_gateway/server.py:10063-10075` (« so the desktop can seal it … instead of losing it »), `:4386` ; Atrium `hermes/ws-turn.ts:703-707` (`default:`) | W7 |
| ~~G-44~~ **FERMÉE (lot 34)** | Hermes : `status:"interrupted"` lu comme `"complete"` ⇒ une réponse tronquée est présentée comme définitive | H | 2, 4 | amont `$HE/tui_gateway/server.py:10169-10175` (3 statuts) ; Atrium `hermes/ws-turn.ts:625` (binaire error/complete) ; symétrie SSE `hermes/normalizer.ts:262-274` | W7 |
| ~~G-45~~ **FERMÉE (lot 38)** | Hermes : `warning` (« la réponse n'a PAS été sauvée dans l'historique de session ») jeté | M | 4 | `$HE/tui_gateway/server.py:10197-10201`, libellé `:10145-10148` ; Atrium `hermes/ws-turn.ts:543-665` ne le lit jamais | W7 |
| ~~G-46~~ **FERMÉE (lot 36)** | Hermes : rotation de session après auto-compaction jamais apprise ⇒ en REST, **tous** les tours post-compaction repartent du transcript pré-compaction | **C** | 2, 4 | exposé `$HE/gateway/platforms/api_server.py:2588`, `:2592`, `:2597` ; WS `$HE/tui_gateway/server.py:3827` ; perte prouvée `$HE/…/api_server.py:2223-2231` (pas de `resolve_resume_session_id`) vs `:2414` (qui le fait) ; Atrium n'apprend que `run_id` `hermes/normalizer.ts:243-244` | W7 |
| ~~G-48~~ **FERMÉE (lot 41)** | Hermes : le fallback `cwd` via `session.status` est du **code mort** ⇒ fichiers livrés perdus en silence | M | 2 | `hermes/ws-turn.ts:567-579` puis `:580` (`if (!sessionCwd) return;`) ; amont ne renvoie que `{"output": …}` `$HE/tui_gateway/server.py:8736`, forme identique en 0.18.2 | W7 |

### 3.3 Tours figés — la bulle qui tourne sans fin

| ID | Lacune | Sév. | Zones | Preuve clé | Lot |
|---|---|---|---|---|---|
| ~~G-36~~ **FERMÉE (lot 32)** | Hermes : l'ACK de `prompt.submit` (`queued` / `steered`) n'est **jamais lu**, et `subscribeWsSession` **écrase** la voie d'un tour existant ⇒ la réponse du tour N part sur le message N+1, le vrai terminal est jeté | **C** | 2, 4 | ACK jeté `hermes/ws-turn.ts:749-752` **(V)** ; trois ACK amont `$HE/tui_gateway/server.py:9506`, `:5691`, `:5677` ; politique par défaut `interrupt` `:5661-5663` ; écrasement `hermes/dispatch.ts:157-169` ; garde qui jette le terminal `hermes/ws-turn.ts:307` ; aggravant : `session.interrupt` efface `queued_prompt` `$HE/…/server.py:9101` | W6 |
| G-37 | Hermes : **aucune deadline, aucun ping** ⇒ tour zombie (12 min minimum) + fuite définitive d'abonné et d'entrée de registre | **C** | 4 | corps SSE non borné `hermes/client.ts:218-223` ; `await turnDone` sans timer `hermes/ws-turn.ts:795` ; `finally` jamais atteint `:796-806` ; aucun ping `hermes/ws-client.ts:141-186` ni côté serveur `$HE/hermes_cli/web_server.py:17679-17696` ; contraste OpenClaw `normalizer.ts:80-81` (240 s / 900 s) | W6 |
| ~~G-38~~ **FERMÉE (lot 33)** | Hermes : **quatre** prompts bloquants non gérés — `clarify.request` (300 s), `secret.request` (300 s), `sudo.request` (120 s), `terminal.read.request` (30 s) ; et sur REST une approbation ne produit **aucune** frame | H | 2, 4 | `_block` amont `$HE/tui_gateway/server.py:2346-2371` ; sites `:4366`, `:4467`, `:4460`, `:4371` ; répondeurs disponibles `:11276-11292` ; Atrium `hermes/ws-turn.ts:703-707` (`default:`), `grep clarify.respond bridge/src` → 0 ; REST : `register_gateway_notify` absent de `_handle_session_chat_stream` (seule occurrence `$HE/gateway/platforms/api_server.py:4978`) | W6 |
| ~~G-39~~ **FERMÉE (lot 33)** | Hermes : `approval.request` tue le tour **sans répondre au gateway** ⇒ la vraie réponse (produite 60 s plus tard) est jetée mais **persistée côté Hermes** : le tour suivant part d'un contexte que le fil ne contient pas | H | 4 | `hermes/ws-turn.ts:356-371` (finalized + settle, sans `approval.respond` ni `session.interrupt`) ; expiration fail-closed `$HE/tools/approval.py:2493-2496` ; répondeur non utilisé `$HE/tui_gateway/server.py:11297` | W6 |
| G-40 | Hermes : chemin de sortie amont **sans terminal** (course annulation/ACK) ⇒ ni `message.complete` ni `error` | B | 2, 4 | `$HE/tui_gateway/server.py:9494-9508` (`return` sec) ; voisin qui émet bien une erreur `:9481-9491` | W6 |
| ~~G-41~~ **FERMÉE (lot 45)** | Hermes : `abort` déclaré au manifeste sur REST alors que le stop serveur est **structurellement inopérant** (404 garanti) ⇒ le gateway continue de générer, facture, et persiste une réponse jamais vue | H | 4 | manifeste `bridge/src/compat.ts:121-124` ; 404 avalé `hermes/dispatch.ts:524-529` ; `_active_run_agents` écrit uniquement en `$HE/…/api_server.py:4926` (POST /v1/runs) alors que le `run_id` SSE est minté `:2534` et jamais enregistré ; annulation par déconnexion impossible `:4637`, `:2578-2586` | W6 |
| ~~G-42~~ **FERMÉE (lot 37)** | Hermes : le classifieur transitoire reçoit « Hermes run failed. » au lieu du détail réel ⇒ **aucun** auto-retry sur panne amont | H | 4 | amont met le détail dans le TEXTE `$HE/tui_gateway/server.py:10169-10175`, `:1335` ; Atrium `hermes/ws-turn.ts:636-641` ; promotion de prose limitée à 2 préfixes `hermes/normalizer.ts:51-57` (`^Error:` non couvert) ; conséquence `convex/turnRetry.ts:62-66` **(V)** | W6 |
| G-21 | OpenClaw : `stream:"approval"` jeté ⇒ 240 s de silence puis `response_timeout`, sans jamais dire qu'une approbation était demandée ; le run reste bloqué côté gateway | M | 3 | amont `$UP/src/infra/agent-events.ts:525-533`, `$UP/…/handlers.tools.ts:1571`, `:1664` ; `exec.approval.requested` diffusé `$UP/src/gateway/server-broadcast.ts:30-33` ; Atrium `normalizer.ts:697-702` + aucune branche `:1052-1136` ; prouvé par exécution (`probe2.mjs` cas C → `[]`) | W5 |
| G-20 | OpenClaw : terminal `lifecycle` lu à moitié — phase `"finishing"` **ignorée** (240 s de silence évitables), `yielded` / `stopReason` / `timeoutPhase` / `aborted` perdus alors que le hand-off est déduit par heuristique | H | 1, 3 | amont `$UP/…/handlers.lifecycle.ts:185-215`, `:195-196` ; sites `$UP/src/agents/agent-command.ts:1938`, `$UP/…/run/attempt.ts:3741-3744` ; Atrium `normalizer.ts:1312-1392` ; prouvé par exécution (`probe2.mjs` cas A → `[]`) ; heuristique `turn-sink.ts:715-720` | W5 |
| G-25 | `shutdown` (`{reason, restartExpectedMs}`) jeté ⇒ un redémarrage annoncé devient un timeout générique | M | 1, 3 | contrat `$UP/packages/gateway-protocol/src/schema/frames.ts:25-31` ; émis en broadcast sans garde de scope `$UP/src/gateway/server-close.ts:889` ; Atrium `normalizer.ts:697-701` | W3 |
| G-26 | Le code de fermeture `1008 "slow consumer"` n'est pas distingué d'une perte de connexion générique | M | 8 | `$UP/src/gateway/server-broadcast.ts:180-186` ; `$UP/src/gateway/server-constants.ts:4` (50 MiB) ; **NON PROUVÉ** que le code soit lu : à vérifier dans la gestion `close` de `openclaw-client.ts` | W3 |

### 3.4 Perte silencieuse et cécité de diagnostic

| ID | Lacune | Sév. | Zones | Preuve clé | Lot |
|---|---|---|---|---|---|
| G-23 | `EventFrame.seq` **jamais lu** : un trou est le SEUL signal amont d'un événement perdu par `dropIfSlow` | **C** | 1, 3, 6, 8 | drop qui avance le compteur `$UP/src/gateway/server-broadcast.ts:174-179` ; invariant épinglé `$UP/src/gateway/gateway-misc.test.ts:593-613` ; deltas chat émis `dropIfSlow:true` `$UP/src/gateway/server-chat.ts:857`, `:926` ; Atrium : seule occurrence `normalizer.ts:875` = `payload.seq` **(V)** ; `frames.ts` **pas vendored** `bridge/protocol/openclaw/2026.6.11/` **(V)** ; aveu `coverage.json` (`ChatDeltaEvent.fields.seq` : « no ordering/gap detection ») ; justification falsifiée `docs/design/protocol-schema-coverage.md:264-268` |
| G-24 | Le diagnostic de désordre émis **par le gateway lui-même** (`stream:"error"`, `reason:"seq gap"`, `expected`, `received`) est silencieusement jeté | **C** | 1, 3, 6 | `$UP/src/gateway/server-chat.ts:1272-1287` ; fixture de forme `$UP/src/gateway/server-chat.agent-events.test.ts:4623-4662` ; aucune branche `normalizer.ts:1052-1136` ; prouvé par exécution (`probe2.mjs` cas B → `[]`) | W3 |
| G-33 | Une exception dans `runManager.feed` (donc dans tout le normalizer / sink) = `console.error` dans stdout du conteneur : ni trace, ni anomalie, ni compteur (F1, le plus grave des 18 chemins d'échec muets) | **C** | 8 | `bridge/src/session.ts:547-551` **(V)** ; inventaire complet des 18 chemins `08-unknown-frames.md:154-173` | W9 |
| G-69 | **31 des 33** types d'events amont ne sont ni consommés, ni comptés, ni visibles ; un `stream` inconnu = silence total ; `data.*` jamais audité | H | 8, 3 | catalogue `$UP/src/gateway/server-methods-list.ts:39-70` ; filtre `normalizer.ts:697-702` ; portée du drift `protocol-drift.ts:167-178` (top-level de `chat`/`agent` seulement) ; `stream` non énuméré au contrat `$UP/packages/gateway-protocol/src/schema/agent.ts:61` ; `data` = `Record<String,Unknown>` `:64` | W9 |
| G-70 | Le gateway **donne déjà** la liste de ce qu'il émet (`hello-ok.features.events`, `GET /v1/capabilities`) et Atrium ne la lit pas | H | 8 | `$UP/packages/gateway-protocol/src/schema/frames.ts:99-103` peuplé par `$UP/src/gateway/server.impl.ts:1581` ; hello-ok lu mais `features` inexploité `openclaw-client.ts:312-318` ; Hermes déjà appelé `hermes/client.ts:152` | W9 |
| G-67 | Le vocabulaire `agent.data` (streams, phases, `livenessState`) est **hors ratchet** ; `coverage.json` affirme un traitement inexistant (`AgentEvent.seq` classé `handled` avec la preuve « frame dedup/tally », or `tallyFrame` ne l'inclut pas) | H | 3 | `$UP/…/schema/agent.ts:57-68` (data non typable) ; `coverage.json` ; `run-manager.ts:143-149` ; c'est la cause structurelle de G-08, G-19, G-20 | W9 |
| G-68 | `KNOWN_AGENT_FIELDS` est une **liste d'observations prod**, pas une dérivation de l'amont : 12 champs de `buildSessionEventSnapshot` lui manquent déjà | H | 1 | `protocol-drift.ts:47-131` (commentaires datés « badge prod 3 unknown fields, 2026-07-19 », « 2026-07-22 endedAt ») ; source amont `$UP/src/gateway/server-chat.ts:466-519` (absents : `subject`, `groupChannel`, `space`, `forkedFromParent`, `traceLevel`, `reasoningLevel`, `elevatedLevel`, `sendPolicy`, `lastTo`, `lastAccountId`, `lastThreadId`, `responseUsage`) | W9 |
| G-66 | Le détecteur de drift ne voit que l'**entrant**, masque les additions par **union d'états**, et ne tourne **qu'en prod** ; débordement de borne invisible ; `catch {}` muet ; aucun axe version/provider/instance ; état RAM perdu au redémarrage | H | 7, 8 | portée `protocol-drift.ts:159-170` ; union `:28-43` (`ChatAbortedEvent.errorMessage` masqué par `ChatErrorEvent`) ; câblage runtime seul `run-manager.ts:437` ; borne `:183-190` ; catch `:201-203` ; singleton `:221` ; troncature aval `convex/lib/compat.ts:263-264` | W9 |
| G-53 | Hermes : événements à `session_id` vide jetés sans trace (hypothèse non écrite) | B | 2 | routage strict `hermes/ws-client.ts:207` + `hermes/dispatch.ts:125-128` ; l'amont en émet `$HE/tui_gateway/server.py:14748`, `:9891` ; le client officiel gère le cas explicitement (`apps/desktop/src/lib/gateway-events.ts:20-56`) | W9 |
| ~~G-49~~ **FERMÉE (lot 44)** | Hermes SSE : outils ouverts **jamais refermés** au terminal (spinner éternel) ; `tool.failed` inconnu ; `is_error` perdu dans le mapping amont | M | 2, 4, 8 | `hermes/normalizer.ts:375-411` (finalize ne vide pas `openTools` `:197-216`) ; `HERMES_EVENT_NAMES` sans `tool.failed` `:66-87` ; le chemin WS a corrigé ce défaut `hermes/ws-turn.ts:227-242` ; perte amont `$HE/agent/tool_executor.py:917-921` → `$HE/…/api_server.py:2567-2568` | W7 |
| ~~G-51~~ **FERMÉE (lot 42)** | Hermes : `tool.output_risk` (verdict de risque + redaction) jeté — payload **déjà** content-free, donc traçable tel quel | M | 2 | `$HE/tui_gateway/server.py:4136-4144` ; alimenté `$HE/agent/tool_executor.py:992-998` ; Atrium `hermes/ws-turn.ts:703` | W7 |
| ~~G-52~~ **FERMÉE (lot 43)** | Hermes : rollups de sous-agents (tokens, coût, durée, fichiers) jetés ; statuts `interrupted`/`timeout` écrasés en `error` | B | 4 | `$HE/tui_gateway/server.py:4192-4218` + `$HE/tools/delegate_tool.py:2291-2316` ; statuts `:2134-2141`, `:2070` ; Atrium `hermes/ws-turn.ts:405-413` | W7 |
| G-22 | OpenClaw : flux natif `stream:"plan"` non consommé ⇒ carte Plan vide sur Codex app-server et Copilot | M | 1 | `$UP/extensions/codex/src/app-server/event-projector.ts:1623-1636` ; `$UP/extensions/copilot/src/event-bridge.ts:222-266` ; Atrium dérive le plan du tool `update_plan` `bridge/src/core/plan-part.ts:1-11` | W5 |
| G-72 | Tout run dont `isControlUiVisible` est faux (cron, canal externe) est **totalement invisible** sur le socket | H | 1 | `$UP/src/gateway/server-chat.ts:936-947`, `:1013-1032` ; tests amont `$UP/…/server-chat.agent-events.test.ts:3940`, `:3972` ; `grep sessions.messages.subscribe bridge/src` → 0 | **notNow** |

### 3.5 Écritures et sérialisation internes (défauts qui ne viennent PAS du gateway)

Point établi par la zone 6 et qui doit rester au centre du diagnostic : **rien ne
réordonne les trames en transit**. L'amont émet de façon synchrone
(`$UP/src/shared/listeners.ts:1-14`, `$UP/src/infra/agent-events.ts:487-492`), le
broadcast WS est synchrone (`$UP/src/gateway/server-broadcast.ts:154-200`), le
bridge draine la socket en FIFO (`openclaw-client.ts:178`, `:442-458`) et la
boucle de consommation applique une trame à la fois (`session.ts:429-535`). Les
défauts d'ordre viennent de **tâches asynchrones internes** qui écrivent dans le
même `TurnSink` en parallèle de cette boucle.

| ID | Lacune | Sév. | Zones | Preuve clé | Lot |
|---|---|---|---|---|---|
| G-29 | `TurnSink.apply` n'est **pas sérialisé** côté OpenClaw : le rejeu du tampon pré-ack et la boucle live s'entrelacent (inversion d'ordre, régression de texte) | H | 6 | `turn-sink.ts:489-501` **(V)** (boucle `for` nue) ; producteurs concurrents `session.ts:544` et `server.ts:1067` → `run-manager.ts:401`, `:407-412` ; `turnActive=true` posé avant retour `turn-sink.ts:435` ; snapshot last-wins `normalizer.ts:1424-1425` ; **le chemin Hermes a la sérialisation** `hermes/ws-turn.ts:259-265` + rationale `:288-294` | W8 |
| G-30 | Un échec HTTP **unique** sur finalize laisse le message en streaming 12 min, sans aucun chemin de reprise (zéro retry, échec avalé) | H | 3 | `convex-writer.ts` `doPost` : timeout puis `throw`, **aucun** retry **(V)** ; `turn-sink.ts:1066-1078` met `turnActive=false` avant l'appel ; `session.ts:547-551` avale **(V)** ; watchdog `convex/stuckStreams.ts:120` (12 min) **(V)** | W8 |
| G-31 | Un upload média qui pend gèle le finalize **sans borne** et bloque tous les announces du chat | H | 3 | `streamToUploadUrl` **sans** `AbortController` ni timeout **(V)** (à comparer à `doPost`, qui en a un) ; `await this.mediaChain` sans timeout `turn-sink.ts:1147` **(V)** ; stash des announces `run-manager.ts:462-471`, cap 5000 `:35` | W8 |
| G-32 | `apply` fait `return` (et non `continue`) quand `messageId === null` : le reste du lot — dont le `run.status` terminal — est jeté **sans log** | M | 3 | `turn-sink.ts:496-499` **(V)** | W8 |
| G-34 | Quatre états intra-tour non bornés (`toolArgs`, `mediaPaths`, `observedChildKeys`, `hostedThisTurn`, `spawnedChildKeysThisTurn`) ; troncature de `deferredEvents` **silencieuse** (viole P8) | B | 3 | `normalizer.ts:495`, `:435`, `:452` ; `turn-sink.ts:127`, `:170` ; cap silencieux `turn-sink.ts:277`, `:538`, `:551` ; contraste `run-manager.ts:658-673` (logue bruyamment) | W8 |
| G-35 | `flushPendingAnnounce` réinjecte les trames avec l'horloge du flush au lieu de leur horloge d'arrivée (échéances armées trop tard) | B | 6 | `run-manager.ts:623-638` alors que le stash conserve `entry.now` `:672` | W8 |
| G-27 | La file de trames entrantes n'est **pas bornée** (mort du bridge par mémoire si Convex ralentit ; tous les chats de l'instance tombent) | M | 6 | `openclaw-client.ts:178`, push `:405-412`, drain `:442-458` ; effet collatéral positif : la socket est drainée vite, donc peu de risque de `close(1008)` | W8 |
| G-15b | `handledAnnounceRunIds` borné à 100 : présenté comme une garantie anti-duplicat alors que le vrai garde-fou est Convex | B | 6 | `run-manager.ts:685-692` ; puits silencieux Convex `convex/stream.ts:504-530` | W8 (doc) |
| G-15c | `subAgents.updatedAt` est l'heure d'**arrivée** d'écritures désordonnées, mais départage les ancres de chaîne | B | 6 | écritures fire-and-forget `session.ts:322-325`, `:331-335` ; estampille `convex/subAgents.ts:291`, `:320` ; tri `convex/stream.ts:482-483` | W8 |
| ~~G-47~~ **FERMÉE (lot 48)** | Hermes : `session.resume` expose déjà `running` / `status` / `inflight` (le texte partiel) / `queued`, et Atrium n'en lit que `session_id` et `info.cwd` ⇒ une coupure transforme en erreur une réponse intégralement produite | M | 2 | `$HE/tui_gateway/server.py:6676-6693`, `inflight` `:5731-5745`, `queued` `:5747-5759` ; Atrium `hermes/ws-turn.ts:141-147` ; finalisation en erreur sans tentative `hermes/dispatch.ts:133-137` | W7 |
| G-54 | Hermes REST : le gateway inline les images `MEDIA:` en data-URL jusqu'à 5 Mo dans le texte de réponse, sans plafond côté Atrium | B | 4 | `$HE/gateway/platforms/api_server.py:619-659`, plafond `:616`, appliqué `:2587` ; Atrium `hermes/normalizer.ts:257-268` ; **NON PROUVÉ** en live (effet Convex non exercé) | **notNow** |

### 3.6 Processus de version et conscience de version

| ID | Lacune | Sév. | Zones | Preuve clé | Lot |
|---|---|---|---|---|---|
| ~~G-55~~ **FERMÉE (lot 46)** | Hermes : `gatewayVersion: null` **en dur** sur le transport par défaut ⇒ tout le manifeste compat Hermes est du code mort, alors que la version est **sur le fil** | **C** | 2 | `hermes/dispatch.ts:824` **(V)** ; défaut WS `:794` ; politique plancher `bridge/src/compat.ts:284-300` ; source disponible `$HE/tui_gateway/server.py:3849-3851` (chaque `session.info`) ; seconde source `$HE/hermes_cli/web_server.py:2935-2936` | W12 |
| G-56 **(garde NON constructible aujourd'hui — mesuré le 30/07)** | `DESKTOP_BACKEND_CONTRACT`, passé de **2 à 4** entre 0.18.2 et 0.19.0, totalement ignoré — là où le client officiel **refuse** un backend en skew | **C** | 2 | `$HE/tui_gateway/server.py:3726`, sémantique `:3719-3725` ; historique par tags (v2026.7.7.2 = 2, v2026.7.20 = 4) ; garde du client officiel `apps/desktop/src/store/updates.ts:90-95` ; émis dans 3 réponses déjà reçues `$HE/…/server.py:3828`, `:5910`, `:6060` ; Atrium `hermes/ws-turn.ts:141-152`, `:521-528` | W12 |
| G-57 | Hermes a changé de schéma de version (tag `v2026.7.20` vs `pyproject` `0.19.0`) : selon la chaîne qui alimente la version, `2026 > 0` ⇒ **beyond validated ⇒ toutes capacités à `true`** | H | 7 | `bridge/src/compat.ts:193` (`maxValidated: "0.18.2"`) **(V)** ; `parseVersion` `:211-224` ; politique fail-open `:310-316` **(V)** ; **NON PROUVÉ** sous quel format Hermes reporte au bridge : lire `hermes/client.ts`, `ws-client.ts`, `server.ts:1533` (`onHermesVersion`) | W12 |
| G-58 **(tranche 1 livrée, lot 47)** | Aucun contrat Hermes vendored, aucun coverage, aucun ratchet, aucun détecteur de drift (asymétrie totale) | **C** | 2, 4 | **au 26/07** : `ls bridge/protocol/` → `openclaw` seul **(V)** ; `ls bridge/src/providers/hermes/` → pas de `protocol-drift.ts` **(V)**. **Au 30/07 (lot 47)** la première moitié est levée — `bridge/protocol/hermes/0.19.0/` porte `rest-contract.json`, `rest-contract.source.py`, `PROVENANCE.json` et un cliquet de chemins ; la seconde tient toujours, il n'y a **ni coverage ni détecteur de drift** Hermes. Trois artefacts machine exploitables existent (contrat entier monotone, `/v1/capabilities` 33 booléens `$HE/…/api_server.py:2004-2070`, `session.info.version`) et la surface est extractible par AST | W12 |
| G-59 | Vendored figé à `2026.6.11` alors que `maxValidated: "2026.7.1"` ⇒ **le ratchet CI est un no-op** ; 5 additions de contrat 7.1 non triées, dont `ChatAbortedEvent.errorMessage` (motif d'abort jeté) | **C** | 7 | `bridge/protocol/openclaw/2026.6.11/` = 5 fichiers **(V)** ; `compat.ts:167` **(V)** ; `protocol-coverage.test.ts:23-27` (version en dur) ; exigence non tenue `docs/design/protocol-contract.md:39-45` ; skill sans étape de re-vendorisation `<hors-dépôt>/skills/add-gateway-version/SKILL.md:80-87` ; commentaire factuellement faux `protocol-drift.ts:20-24` | W10 |
| G-60 | Les paramètres RPC **sortants** ne sont jamais validés contre la version **PLANCHER** du range ⇒ ajouter un champ 7.1 casserait durement tous les gateways < 7.1 (`additionalProperties:false`) | **C** | 7 | schémas stricts `bridge/protocol/openclaw/2026.6.11/logs-chat.ts` ; l'amont le confirme `$UP/src/tui/gateway-chat.ts:243-245` (« Protocol v4 peers reject unknown fields ») ; une seule forme émise `server.ts:1055`, `:2407-2410` ; le banc ne rejoue jamais le plancher `SKILL.md:60-74` | W10 |
| G-61 | Ratchet sur **3 modules de schéma sur 31** ⇒ 15 des 20 méthodes RPC appelées (cron, sessions, tasks, config, models) sans aucun garde-fou ; même trou dans la watchlist du diff amont | **C** | 7 | `protocol-coverage.test.ts:23-25` ; inventaire des 20 RPC `07-version-process.md:221-233` ; `<hors-dépôt>/live-bench/upstream-watchlist.txt` (22 fichiers, aucun cron/sessions/tasks/config) ; `sessions.get`, réellement appelé, n'a **aucun** schéma amont (`$UP/src/gateway/server-methods/sessions.ts:2513-2527`, params validés à la main) | W10 |
| G-62 | Au-delà de `maxValidated`, `resolveCapabilities` accorde **toutes** les capacités (échec ouvert), sans aucune restriction ni bannière utilisateur — dans le scénario opérationnel documenté par le dépôt lui-même | **C** | 7 | `compat.ts:310-316` **(V)** ; scénario `docs/design/protocol-contract.md:82-84` (« the NAS updates OpenClaw before the bridge image ») ; seule conséquence visible = badge admin `src/chat/admin/compatView.ts:41` | W10 |
| G-63 | `validatedVersions` est une **déclaration humaine** : aucun artefact ne prouve qu'un banc a tourné (le test ré-épingle la même liste littérale) | H | 7 | `compat.ts:168-184` **(V)** ; `bridge/test/compat.test.ts:166` ; `grep -rn "bench-runs\|live-bench"` → 3 commentaires seuls ; le banc produit pourtant déjà un verdict structuré `run-live-bench.mjs:616`, exit code `:506` ; banc absent de la CI (`.github/workflows/ci.yml` = 3 jobs **(V)**) | W11 |
| G-64 | Manifeste de capacités incomplet (15 bridge / 11 front) et « lockstep » qui ne détecte rien : fixture périmée éditée à la main, test unidirectionnel, accès par chaîne brute hors du gate compile | H | 7 | `compat.ts:75-110` vs `src/chat/capabilities.ts:22-34` ; contournement `convex/scheduled.ts:96-97` ; test auto-référentiel `src/chat/capabilities.test.ts:53-73` et unidirectionnel `:84-87` ; fixture avouée `src/chat/bridgeCapabilitiesFixture.ts:1-6`, `:47`, `:62-68` | W11 |
| G-65 | **6 features majeures** couvertes par le seul banc live manuel ; **2** (`talk`, `announce×queue`) dans **aucune** suite exécutée | H | 7 | `<hors-dépôt>/live-bench/scenarios.mjs:70-85`, `:86-102`, `:103-228`, `:229-264`, `:265-288` ; `announce-queue-race.mjs` et `probe-talk.mjs` hors suite | W11 |
| G-73 | Le diff d'interprétation amont est **explicitement non bloquant** et compare depuis une base différente du ratchet (le signal a été émis puis ignoré) | M | 7 | `upstream-diff.sh:14-17`, base `:31-35` ; rapport existant `<hors-dépôt>/bench-runs/upstream-diff-2026.6.11-vs-2026.7.1/report.md` (« 15 changed », « Anchors: 15 ok ») | W10 |
| G-71 | Trois familles d'événements sont émises **hors du catalogue annoncé** par `hello-ok` (`chat.send_timing`, `chat.side_result`, `plugin.*`) | B | 1 | catalogue `$UP/src/gateway/server-methods-list.ts:39-70` renvoyé `$UP/src/gateway/server.impl.ts:1581` ; gardes de scope présentes `$UP/src/gateway/server-broadcast.ts:26`, `:27`, `:77-84` | W9 (doc) |
| G-74 **(FERMÉE — 26/07 puis lot 47 le 30/07)** | Le contrat de conception affirmait des choses non tenues : `docs/design/protocol-schema-coverage.md` décrivait Hermes comme « structural placeholder with zero capabilities » et justifiait l'absence de détection de perte par « ordered WS » (raison falsifiée par le code amont — l'amont **jette des trames exprès** via `dropIfSlow`, en avançant le `clientSeq`). | M | 3, 4, 7 | Les deux passages portent leur correction **datée**, laissée en place plutôt que réécrite : un document qui efface ses erreurs n'apprend pas à s'en méfier. Le « NON PROUVÉ » sur `/capabilities` est levé : les cibles Hermes y portent provider, version résolue et capacités avec l'overlay de transport (`bridge/src/server.ts:2238-2246`, `applyHermesTransportOverlay`) — le placeholder à zéro capacité n'existe plus. | W10/W12 (doc) |

---

## 4. Les douze lots

Chaque lot est **implémentable, vérifiable et déployable seul** (P1). Les
dépendances déclarées sont des dépendances de **sens** (livrer B avant A rendrait
A faux ou inutile), pas de compilation.

### W1 — Jauge de contexte honnête (mesure fidèle) — effort M

> **LIVRÉ (lot 3, 0.68.x)** — jauge fondée sur l'estimation gateway, état INCONNU
> explicite. Vérifié dans le code le 27/07 : `totalTokensFresh` lu par
> `bridge/src/server.ts`, `src/chat/sessionKnobs.ts` et le schéma Convex. Le chemin
> d'estimation reste conditionné aux leviers gateway (voir W2).

**Lacunes** : G-01, G-02, G-03, G-50.
**Objectif observable** : la jauge n'affiche **jamais** un pourcentage faux ;
quand la source est absente ou périmée, elle dit « inconnu » plutôt qu'un chiffre.
Un survol indique **d'où** vient le chiffre.

**Pourquoi c'est le lot 1** : le registre prod est catégorique — « un utilisateur
ne peut pas s'autoréguler avec un instrument faux, et nous-mêmes avons
diagnostiqué de travers au premier passage » (`10-registre-prod.md:38-42`). Toute
défense en profondeur (W2) construite sur la mesure actuelle serait armée au
mauvais moment. C'est aussi le lot le moins risqué : il **retire** de l'affichage,
il n'ajoute aucun comportement.

**Contenu**
1. `parseSessionMeta` (`bridge/src/server.ts:614-630`) projette en plus, en
   content-free : `contextBudgetStatus` → `{estimatedPromptTokens,
   promptBudgetBeforeReserve, overflowTokens, route, source, updatedAt}` et
   `totalTokensFresh`. Zéro appel gateway supplémentaire : le `sessions.describe`
   est **déjà** fait avant chaque envoi (`server.ts:828-859`).
2. Ordre de priorité de la jauge : `contextBudgetStatus.estimatedPromptTokens`
   (le chiffre que l'amont utilise pour son propre affichage,
   `$UP/src/status/status-message.ts:958-961`) > `activeTokens` > `totalTokens`.
3. `totalTokensFresh === false` ⇒ **jauge indéterminée**, jamais de %.
   Précédent explicite côté Hermes (#50421,
   `$HE/tui_gateway/server.py:3619-3644` : « leave it unknown otherwise »).
4. Étendre la garde `used > contextTokens ⇒ null` à `activeTokens`
   (`src/chat/sessionKnobs.ts:122-126`).
5. Ajouter `sessionMeta.contextSource: "budget_estimate" | "last_call_usage" |
   "unknown"`, affiché au survol. **Corriger le commentaire**
   `convex/schema.ts:1068-1072`, qui documente aujourd'hui une fausse
   distinction.
6. Hermes (P5) : lire `usage.compressions` (compteur de compactions — exactement
   le signal qui manque au diagnostic contexte) et `usage.context_percent` en
   contrôle croisé (`hermes/ws-turn.ts:609-611`) ; sur SSE, consommer
   `run.completed.usage` pour la pression cumulée, **sans fabriquer** de
   `contextTokens` (le transport ne l'expose pas — trou de transport à écrire au
   contrat).

**Risque de régression et confinement** : le seul risque est de *retirer* un
chiffre auquel un utilisateur s'était habitué. C'est voulu : un chiffre faux est
pire qu'une absence. Aucun chemin d'envoi ni de finalisation n'est touché. Les
champs Convex ajoutés sont optionnels (`v.optional`) donc rétro-compatibles.

**Vérification**
- Tests purs `sessionKnobs` : `activeTokens > contextTokens ⇒ null` ;
  `totalTokensFresh:false ⇒ null` ; `contextBudgetStatus` présent ⇒ il prime.
  Chacun **ÉCHOUE** si la garde est retirée (P2).
- Test `parseSessionMeta` sur une fixture `sessions.describe` dérivée de
  `$UP/src/gateway/session-utils.ts:2387`, `:2407-2408`.
- Test Hermes : `message.complete` avec `usage.compressions = 3` ⇒ compteur à 3 ;
  `run.completed` SSE avec `usage` ⇒ totaux remontés, `contextTokens` **absent**.
- Banc live local : sur une session longue, comparer le % affiché à
  `contextBudgetStatus.estimatedPromptTokens / contextTokenBudget`.
- Preuve du défaut passé (obs) : dans `chat.gateway_pressure`, chercher les tours
  où `postTotalTokens` dépasse `contextTokens` ou est incohérent avec
  `postInputTokens + postOutputTokens`.

**Point de vigilance prouvé** : `contextBudgetStatus` est **vide** sous un moteur
`ownsCompaction` (`$UP/…/run/attempt.ts:4842`, `:4855` gardés par
`shouldSkipPrecheck` ; effacé par `$UP/src/agents/command/session-store.ts:240-242`,
`:267`, `:404`). Donc en déploiement réel (LCM), W1 livre surtout **l'honnêteté**
(dire « inconnu ») ; la fidélité complète exige le levier opérateur de W2. C'est
un résultat, pas un échec : aujourd'hui la jauge mentait, demain elle se taira.

---

### W2 — Défense en profondeur contre le débordement de contexte — effort L

> **LIVRÉ (lot 13, 2026-07-26)** — les six points du contenu ci-dessous sont codés,
> prouvés par neutralisation, et la boucle Codex a convergé en 6 passes (8 findings
> réels corrigés, 4 rejetés avec raison écrite). Ce que le lot a appris et qui
> corrige ce document :
>
> - **La garde peut coûter le tour qu'elle protège.** `assertBeforeSendDeadline`
>   (8 min, `dispatchAgeMs` inclus) tourne EN AVAL de la garde : une compaction de
>   60 s sur un dispatch déjà ancien fait refuser l'envoi. Le budget restant est
>   donc mesuré avant de décider, la RPC est bornée par ce qui reste, et une
>   réserve couvre le re-describe, la rehydratation/le staging ET l'envoi.
>   Sans budget suffisant : on n'attente rien et **on envoie**.
> - **`sessions.compact` a TROIS réponses, pas deux.** `compacted:true` = rétréci ;
>   `compacted:false` = refus OBSERVÉ ; champ absent = **inconnu**, et un inconnu ne
>   doit jamais retenir un envoi. Le refus lui-même se scinde : `already_active` /
>   `already_in_flight` disent « pas maintenant » (donc **on envoie** : la chose qui
>   tourne est peut-être une compaction en train de rétrécir la session), tandis
>   qu'un `unsupported_harness_compaction` est le SEUL refus mémorisable d'un tour
>   sur l'autre. `no transcript` ne l'est pas : un envoi ordinaire en crée un, et le
>   mémoriser enfermait la conversation sur une preuve périmée.
> - **Une compaction interrompt un run actif** (`interruptSessionRunIfActive` dans
>   le handler du gateway). La garde refuse donc de compacter quand un run est vivant
>   — y compris un tour d'announce DIFFÉRÉ, qui est occupé tout en étant invisible.
>   La fenêtre résiduelle (un run qui démarre PENDANT la RPC) est un écart **déclaré**
>   dans `docs/design/protocol-schema-coverage.md`, pas contourné.
> - **Le seuil de 95 % ne PROUVE rien** : la réserve de sortie n'est pas encore
>   déduite et le message du tour n'est pas compté. C'est une décision produit
>   (décision produit, 26/07), pas une démonstration — seul `overflowTokens > 0` est une
>   preuve, et c'est alors lui qui décide, sans exiger que le remplissage soit connu.
> - **Trois mesures étaient calculées puis jetées**, la faute récurrente du
>   programme : la cause de compaction n'atteignait aucune trace (l'ingest projetait
>   tous les autres champs), le `reason` du marqueur était retiré par la projection
>   de `messageParts` (donc la phrase de cause de W5 était inatteignable), et la
>   compaction manuelle rapportait un succès sur un refus HTTP 200 — sur le bouton
>   même que cette carte propose comme issue.
> - **Dette de harnais payée** : `bridge/test/helpers/fake-gateway.ts` répond aux RPC
>   avec un script (describe successifs, issue de compaction, délais, timeouts
>   enregistrés). C'est ce qui rend enfin exprimables les trois tests qui comptent —
>   « une compaction réussie laisse partir l'envoi », « une garde en exception laisse
>   partir l'envoi », « un dispatch trop vieux n'est pas retenu ».
>
> **Deux découvertes d'environnement, plus graves que le lot :**
>
> 1. **`sessions.subscribe` sur la socket qui porte la conversation casse les tours.**
>    C'était la voie évidente vers `session.operation` (le seul porteur de la CAUSE de
>    compaction, G-09). Résultat mesuré : `spawn-parallel-merge` passe de OK/67 s à un
>    échec REPRODUCTIBLE à ~180 s, deux runs d'announce sur trois non fusionnés,
>    enfants ancrés au mauvais message. Attribué par bisect (le bridge d'avant passe ;
>    le lot échoue ; retirer LA SEULE souscription, tout le reste en place, fait
>    repasser). Le canal `sessions` pousse `sessions.changed` / `session.message` /
>    `session.tool` dans le même consommateur, et ce sont les trames du tour qui se
>    perdent. **Un diagnostic ne doit jamais coûter la conversation.** La moitié
>    restante de G-09 (le `reason` de `session.operation`) exige une connexion DÉDIÉE
>    dont les trames n'atteignent jamais `RunManager.feed` — chantier à part, pas
>    passé en fraude sur le chemin du tour. Le lecteur (`handleSessionOperation`) reste
>    en place, testé, NON alimenté, et son commentaire le dit.
> 2. **Le déploiement Convex local était périmé depuis des jours.** `convex dev`
>    refusait de pousser à cause d'une seule erreur `tsc` dans
>    `convex/authDomains.test.ts:64` (un littéral d'objet avec des propriétés en trop),
>    invisible pour `npm run typecheck` et pour vitest — et SIX `convex dev` concurrents
>    (le plus vieux, 12 jours) se disputaient le backend. Conséquence directe : un banc
>    « GO » validait un bridge neuf contre un Convex ancien. La leçon de méthode :
>    **avant de croire un banc, prouver que le déploiement est celui du code** (une
>    fonction sonde jetable suffit). Corrigé, puis banc rejoué : **GO 11/11** avec les
>    deux moitiés réellement en place, et la garde prouvée vivante sur le fil
>    (`presendAction:"send"`, `presendFillPct:8`, `presendFillSource:"counter"`).
>    À noter : en local le gateway ne fournit PAS `estimatedPromptTokens` — la source
>    primaire manque et le repli compteur prend le relais, exactement comme prévu.
>
> Les leviers **opérateur** (G-05, G-06) restent à poser côté gateway : ils ne sont
> pas du code Atrium. Voir la fin de cette section.


**Lacunes** : G-04, G-05, G-06, G-07, G-09, G-10, G-11 (+ G-08 consommé par W5).
**Dépend de** : W1 (armer une garde sur une mesure fausse produirait des blocages
d'envoi injustifiés — le pire résultat possible).
**Objectif observable** : un débordement ne coûte plus un tour ; quand il survient
malgré tout, la carte d'erreur porte **deux actions câblées** au lieu d'un conseil.

**Pourquoi c'est nécessaire à la 1.0.0** : c'est la **seule** classe de défaut
encore active et non corrigée, avec quatre occurrences en trois jours, toutes
soldées par une réinitialisation manuelle (`10-registre-prod.md:31-36`). Elle
frappe en plein travail utile (compte rendu de réunion, comparateur d'achat).

**Contenu**
1. **Garde graduée pré-envoi**, greffée sur le `sessions.describe` existant
   (`server.ts:828-859`) : <70 % rien ; 70-85 % information UI ; 85-95 %
   `sessions.compact` **préventif** puis re-describe puis envoi ; >95 % ou
   `overflowTokens > 0` compaction obligatoire et, si elle échoue
   (`already_compacted_recently` / `deferred_background` / `below_threshold`),
   **ne pas envoyer** et finaliser en `context_length` **avant** toute dépense
   provider. Les RPC de remédiation sont déjà câblées (`server.ts:1167-1174`,
   `:1155-1159`).
   Deux invariants **obligatoires** : au plus **une** tentative par tour
   (marqueur `preflightCompacted`) ; et **toute** erreur de la garde ⇒ on envoie
   quand même (P6 — la garde ne peut jamais faire perdre un tour qui serait
   passé).
   Journalisation SOC2 : `{fillPct, source, action, compactReasonClass}` (P3).
2. **Sortie câblée sur la carte `context_length`** : « Compacter et réessayer » et
   « Nouvelle session à partir d'ici », branchées sur les mutations existantes
   (`src/chat/SessionPanel.tsx:152-153`). Réécrire le libellé pour ne plus citer
   `/reset`, qui n'existe pas dans Atrium (P4).
3. Code `context_length_compacted` retryable **une** fois, sous les mêmes portes
   zéro-contenu que `provider_internal` (`convex/turnRetry.ts:108-116`), armé
   **seulement** si une compaction a réussi entre-temps. La règle générale reste :
   rejouer à l'identique échouerait à l'identique.
4. **Plafond en tokens** sur la rehydratation composée (`history` + séparateur +
   texte utilisateur), évalué contre la fenêtre **live**, en retenant le **plus
   petit** `contextTokens` en cas de bascule d'agent ; et **aucune** rehydratation
   au-delà de 70 % de remplissage (le gateway a déjà l'historique).
5. `subAgents.errorCode` (optionnel, allowlisté) alimenté par le classifieur
   partagé, rendu dans `errorDetailView` et inclus dans `/api/v1/chat-state` +
   obs MCP (P9).
6. **Cause de compaction** : s'abonner à `sessions.subscribe` pour recevoir
   `session.operation` (qui porte `operationId` + `reason` + `completed`) et faire
   de ce signal explicite la source primaire, l'heuristique de rotation de
   `sessionId` devenant un fallback — exactement le patron déjà appliqué avec
   succès aux signaux explicites de compaction. Tant que ce n'est pas fait, la
   trace doit dire que la cause est **INCONNUE** plutôt que laisser croire à une
   compaction de seuil.

**Frontière explicite (P10) — prérequis OPÉRATEUR, hors code Atrium**
- `agents.defaults.compaction.midTurnPrecheck.enabled = true` (G-06). L'aide de
  config amont décrit littéralement le symptôme prod
  (`$UP/src/config/schema.help.ts:1531-1532`).
- Faire déclarer au plugin LCM `promptAuthority: "preassembly_may_overflow"`
  (G-05) : cela ré-arme le precheck générique **et** réalimente
  `contextBudgetStatus`, donc rend W1 pleinement fidèle.
- Les injections `knowledge` hors sujet (~4k/tour) et le timeout de 15 s de
  `before_prompt_build` (`10-registre-prod.md:63-68`) alimentent directement le
  débordement et **doivent** remonter à l'opérateur : Atrium ne peut ni ne doit
  les absorber.

**Risque de régression et confinement** : le risque majeur est de **bloquer un
envoi qui aurait réussi**. Confinement : la garde ne bloque qu'au-delà de 95 % **et
seulement après** l'échec d'une compaction, elle est fail-open sur exception (P6),
et elle est bornée à une tentative par tour. La compaction préventive est
idempotente côté gateway (classification de refus déjà disponible).

**Vérification**
- Intégration bridge avec faux gateway : (a) describe à 97 % ⇒ `sessions.compact`
  appelé **avant** `chat.send` ; (b) compact refusé ⇒ **aucun** `chat.send` et
  message finalisé `context_length` ; (c) la garde jette ⇒ `chat.send` a **quand
  même** lieu ; (d) un second describe en échec ne relance pas de compact.
- `turnRetry` : `context_length` non retryable ; `context_length_compacted`
  retryable une seule fois et seulement à contenu nul.
- Tests purs rehydratation : contenu dense ⇒ budget réduit ; deux fenêtres ⇒ la
  plus petite gagne ; remplissage > 70 % ⇒ aucune rehydratation.
- Convex : un `subAgent` en erreur dont le texte est un overflow ⇒
  `errorCode = context_length` et apparition dans la projection `chat-state`.
- Banc live : session gonflée à 90 %, prouver le compact préventif et l'absence
  d'overflow ; puis provoquer un overflow réel et cliquer « Compacter et
  réessayer » — le tour doit aboutir **sans** intervention manuelle sur le
  panneau de session.
- **KPI de sortie** : débordements terminaux / 1000 tours sur 7 jours, avant/après.

---

### W3 — Détection de perte de trames et fin de connexion nommée — effort M

> **LIVRÉ (lots 4 et 6)** — fin de connexion NOMMÉE et détection de perte de trames.
> Vérifié dans le code le 27/07 : `noteFrameGap` (convex-writer + turn-sink),
> `GATEWAY_RESTARTING` / `CONNECTION_SATURATED` dans `dispatch-errors.ts`, et les deux
> suites `connection-end*.test.ts`.

**Lacunes** : G-23, G-24, G-25, G-26.
**Objectif observable** : une trame perdue par le gateway devient une **anomalie
visible** et déclenche une resynchronisation par snapshot ; un redémarrage annoncé
du gateway produit une cause de fin **nommée** au lieu d'un timeout générique.

**Pourquoi c'est nécessaire à la 1.0.0** : c'est la réponse directe à la plainte
client « trames dans le désordre / conflits de trames », et au constat que **les
quatre défauts de trames de juillet ont été découverts par l'utilisateur**
(`10-registre-prod.md:44-48`). Le gateway nous **dit** qu'il a perdu une trame ;
nous jetons le message. Coût de la mesure : quasi nul.

**Contenu**
1. Lire `EventFrame.seq` de l'enveloppe dans `openclaw-client.ts`, compteur
   attendu **par connexion** ; un trou ⇒ trace `chat.frame_gap {expected,
   received, missing}` + anomalie + **resynchronisation snapshot** du tour en
   cours. Piège **prouvé** : les broadcasts **ciblés** n'ont pas de `seq`
   (`$UP/src/gateway/server-broadcast.ts:189-192`) — l'absence de `seq` ne doit
   **jamais** compter comme un trou.
2. Branche `stream === "error"` dans `handleAgent` : `data.reason === "seq gap"`
   ⇒ trace `chat.gateway_seq_gap {expected, received}` + resynchronisation.
   **Jamais** une erreur de tour (la trame est un diagnostic, pas un échec).
3. Consommer `shutdown` (`{reason, restartExpectedMs}`) au niveau session :
   marquer « arrêt annoncé », raccourcir les grâces de silence en cours,
   attribuer la cause stable `gateway_shutdown` / `gateway_restarting`, et
   calibrer le budget de l'orphan recovery sur `restartExpectedMs`. `reason` est
   un texte libre amont : ne journaliser que sa **présence** et un code dérivé
   (P3).
4. Distinguer le code de fermeture `1008 "slow consumer"` d'une perte générique.
5. Exposer `policy.maxBufferedBytes` du hello-ok (aujourd'hui seul `maxPayload`
   est capturé, `openclaw-client.ts:334-340`) et `inboundQueueLen` dans
   `bridge_status`, pour rendre la condition de drop **observable** avant qu'elle
   morde.

**Risque de régression et confinement** : purement additif et observe-only sur le
chemin de trame — aucune trame n'est rejetée ni mutée (invariant hérité de
`protocol-drift.ts:6-7`). Le seul comportement modifié est la resynchronisation
snapshot, qui emprunte un chemin **déjà existant et éprouvé** (history recovery).
Faux positif à éviter absolument : compter un broadcast ciblé comme un trou —
d'où le test dédié.

**Vérification**
- Unitaire client : séquence `seq` 1,2,4 ⇒ anomalie avec `expected = 3` ;
  séquence 1,2,(sans seq),3 ⇒ **aucune** anomalie. Le second test **ÉCHOUE** si
  l'on compte naïvement.
- Unitaire normalizer : la trame `seq gap` **verbatim** de
  `$UP/src/gateway/server-chat.agent-events.test.ts:4655`, promue en fixture dans
  `bridge/test/upstream-frames.test.ts` ⇒ une trace est émise et le tour n'est
  **pas** mis en erreur (aujourd'hui : `[]`, prouvé par `probe2.mjs` cas B).
- Unitaire session : un `shutdown` suivi d'une fermeture ⇒ code
  `gateway_restarting`, **pas** `connection_lost`.
- Banc live : saturer volontairement le socket (`bufferedAmount` > 50 MiB) pendant
  un tour verbeux et vérifier que le trou est détecté et tracé ; puis redémarrer
  le gateway en plein tour et vérifier la cause de fin persistée.
- **Note d'instrumentation (P7)** : ce lot corrige un défaut (cause de fin fausse
  sur `shutdown`), donc il peut voyager en release. La partie purement mesure
  (`frame_gap`) ne justifierait pas une release à elle seule.

---

### W4 — Intégrité de la réponse (OpenClaw) : rien ne rétrécit, rien ne disparaît, rien d'étranger n'entre — effort M

> **LIVRÉ (lot 11)** — rien ne rétrécit, rien ne disparaît, rien d'étranger n'entre.
> Vérifié dans le code le 27/07 : `refusedText` (schéma + `stream.finalize`) et
> `providers/openclaw/run-families.ts` (familles de runs initiés par le gateway).

**Lacunes** : G-12, G-13, G-14, G-15, G-16, G-17, G-18.
**Objectif observable** : la réponse affichée est celle de **ce** tour, complète,
et elle ne rétrécit jamais en cours de route.

**Pourquoi c'est nécessaire à la 1.0.0** : c'est le paquet de défauts qui produit
le symptôme le plus destructeur de confiance — « le bot répond à côté », « la
réponse a été coupée ». G-12 est **prouvé par exécution** (un `chat:final` d'un
autre run devient la réponse de l'utilisateur et clôt son tour) et G-13 est un
chemin de troncature à 8 000 caractères que rien ne détecte.

**Contenu**
1. **Politique d'admission stricte des runs** (G-12) : pendant `compactionPending`
   (900 s !), n'admettre un `runId` inconnu que sur preuve **positive** de
   filiation — même `sessionId` après rotation, ou famille gateway-initiée
   reconnue par `announceRunIdFor`, ou seulement après
   `{stream:"compaction", phase:"end", willRetry:true}`. Ne **jamais** adopter un
   run `isHeartbeat:true` (discriminant disponible et aujourd'hui non lu). Un run
   adopté est **additif seulement** : interdiction de snapshot raccourcissant, de
   snapshot vide de compaction et de finalisation. Tout refus est compté
   (`chat.foreign_run_rejected {reason, grace}`) — ce compteur est aussi
   l'instrument qui mesurera l'exposition réelle.
   La grâce courte `lifecycle_end` (10 s) peut garder sa règle actuelle, mais doit
   exiger que le run adopté n'appartienne à **aucune** famille gateway-initiée
   (ce qui ferme aussi le cas `chat.inject`, dont le `runId` est synthétique).
2. **Garde anti-régression de snapshot** (G-14), côté Convex : n'accepter un
   snapshot que s'il **étend** le texte courant ; refuser et tracer
   `stream.snapshot_regression {oldLen, newLen}` sinon, sauf `replace:true`
   explicite ou compaction explicite. **C'est le seul verrou qui rend l'affichage
   insensible à un désordre résiduel** — il vaut à lui seul plusieurs correctifs
   en amont.
3. **Troncature 8k** (G-13) : détecter le suffixe `\n...(truncated)...` sur un
   `chat` final/aborted et, au lieu de le persister, déclencher la récupération
   `sessions.get` (non tronquée). Tracer `chat.final_truncated` (compteur +
   longueur, jamais le texte). À remonter **aussi** à l'amont : `broadcastChatFinal`
   réutilise une constante d'**historique** sur un événement **live** — mais la
   garde Atrium doit exister quelle que soit la version du gateway.
4. **Déduplication à mémoire** (G-15) : remplacer le slot scalaire par un ensemble
   borné (LRU ~64) des clés vues dans le tour.
5. **Perte de contenu muette** (G-16) : un `args` de message-tool illisible ne doit
   plus produire `""` en silence — compteur nommé `msgtool_args_unparsable` +
   diagnostic, et le tour ne doit pas finir « vide » sans dire pourquoi (P8).
6. **Flux assistant** (G-17) : router par `data.phase` — le `commentary` va sur un
   canal distinct (raisonnement / phase UI), jamais dans le buffer de réponse ;
   séparer les items par `data.itemId` ; honorer `data.replace` sur le chemin
   delta comme le fait déjà le chemin chat (`normalizer.ts:1003-1007`).
7. **`chat.side_result`** (G-18) : capturer d'abord
   (`BRIDGE_FRAME_DUMP=side_result` sur un tour commande) pour trancher
   l'atteignabilité ; si confirmé, l'admettre comme source de texte visible sous
   la **même** barrière `sessionKey` que `chat` ; sinon le déclarer `ignored` avec
   raison au manifeste. Dans les deux cas, il cesse de disparaître en silence.

**Risque de régression et confinement** : le point sensible est (1) — une
admission **trop** stricte casserait la fusion announce « une bulle » et les
replays légitimes post-compaction, deux comportements durement acquis. Confinement
obligatoire : le lot n'est livrable qu'avec un test qui prouve que le **replay
légitime** est toujours adopté (même `sessionId` post-rotation après
`compaction end willRetry:true`), en plus du test qui prouve que l'étranger est
rejeté. Les scénarios de banc `spawn-announce-merge`, `spawn-chain-merge`,
`spawn-parallel-merge` sont le filet de sécurité et doivent tous rester GO.

**Vérification**
- Le cas E de `probe2.mjs` devient un test qui asserte `[]` (frame étrangère
  rejetée) ; un second test asserte l'adoption du replay légitime ; un troisième
  asserte qu'un run `isHeartbeat:true` n'est **jamais** adopté (`ownRunIds`
  inchangé, zéro événement).
- Convex : `setSnapshot(long)` puis `setSnapshot(court)` sans `replace` ⇒
  `liveText` **inchangé** + trace de régression émise.
- Unitaire : un `chat` final finissant par `...(truncated)...` ne devient **pas**
  le texte final et déclenche `wantsHistoryRecovery`.
- Unitaire : séquence `final(A) → final(B) → final(A)` ⇒ texte final = B et une
  seule finalisation.
- Fixture à capturer (`BRIDGE_FRAME_DUMP=commentary`) sur un tour à préambule
  (GPT-5) puis test : `commentary(text, replace)` suivi de deltas de réponse ⇒ le
  texte final est **la réponse**, pas le commentaire.
- Banc live : les trois scénarios de fusion announce restent GO ; prompt > 8 000
  caractères livré par message-tool ⇒ comparer le texte persisté à `sessions.get`.

---

### W5 — Vocabulaire `agent.data` correctement interprété — effort S

> **LIVRÉ (lot 12)** — terminal différé, verdict de compaction, approbations, plan natif.
> Vérifié dans le code le 27/07 : `LIFECYCLE_FINISHING_GRACE` / `APPROVAL_WAIT` dans le
> normalizer, plus `core/plan-part.ts` et `core/compaction-verdict.ts`.

> **CORRECTION (constatée en ouvrant le lot 12, 2026-07-26).** Deux des cinq
> lacunes étaient déjà traitées, et le contenu ci-dessous les décrivait comme à
> faire :
>
> - **G-19 est LIVRÉ depuis le lot 1** : `TOOL_PROGRESS_PHASES`
>   (`update`/`chunk`/`delta`) est une allowlist de NON-terminaux — choisie ainsi
>   plutôt qu'une allowlist de terminaux pour la sûreté multi-version — et le
>   point 1 ci-dessous est donc sans objet, y compris l'effet de bord sur le gate
>   `spawnCalledThisTurn`/`yieldCalledThisTurn`, réparé avec.
> - **G-08 était à moitié livré** : `completed:false && willRetry!==true` émettait
>   déjà `context.compaction phase:"failed"`, et `chat.gateway_pressure` portait
>   déjà la phase. Seul l'état `sessionOverfull` du point 3 restait à faire — et
>   c'est lui qui a coûté l'essentiel du lot (un état CHAT-scoped qui survit au
>   tour se défend à chaque porte : fork, reset, session fraîche gateway,
>   réordonnancement des verdicts, deux horloges de machines différentes).
>
> Le lot 12 a donc livré **G-20, G-08bis, G-21, G-22** + le filet anti-spinner du
> confinement. Vérifié en lisant le code, pas le doc.

**Lacunes** : G-19 *(déjà livré)*, G-20, G-21, G-22, G-08 *(moitié déjà livrée)*.
**Objectif observable** : une carte d'outil ne s'affiche « terminée » que quand
l'outil l'est ; un tour qui attend une approbation le **dit** au lieu d'expirer à
240 s ; une compaction échouée laisse un marqueur.

**Pourquoi c'est nécessaire à la 1.0.0** : ce sont cinq mauvaises lectures d'un
vocabulaire que l'amont émet déjà, dont trois sont **prouvées par exécution**
(`probe-tool-update.mjs`, `probe2.mjs` cas A, C, D). Coût unitaire minuscule,
gain de justesse immédiat. C'est le meilleur rapport valeur/risque du programme.

**Contenu**
1. **Phases de tool** (G-19) : allowlister les phases **terminales** (`result`,
   `end`). `update` / `delta` deviennent des keep-alive : ne **pas** supprimer
   `toolArgs`, ne **pas** incrémenter `toolCallCount`, optionnellement émettre un
   `tool.status phase:"running"`. Toute phase inconnue tombe dans un compteur de
   diagnostic, **jamais** dans le chemin terminal. Effet de bord réparé : le gate
   `spawnCalledThisTurn` / `yieldCalledThisTurn` (`turn-sink.ts:692-720`) retrouve
   son invariant.
2. **Terminal lifecycle** (G-20) : `phase:"finishing"` devient un **pré-terminal**
   (arme la grâce, phase UI `post_processing`) au lieu de 240 s de silence ;
   `data.stopReason`, `data.aborted`, `data.timeoutPhase`, `data.providerStarted`
   entrent dans les diagnostics de finalize ; `data.yielded` devient le signal
   **primaire** du hand-off, l'heuristique `sessions_yield` passant en fallback
   multi-version (même patron que la compaction explicite vis-à-vis de
   `livenessState:"abandoned"`).
3. **Compaction échouée** (G-08) : lire `data.completed` ; `false` + `willRetry
   false` ⇒ `context.compaction phase:"failed"` + marqueur dans
   `chat.gateway_pressure` + état `sessionOverfull` qui **pré-annonce** l'overflow
   du tour suivant (affichage actionnable plutôt qu'une erreur brute).
4. **Approbations** (G-21), minimum viable et honnête : `stream:"approval"`
   `phase:"requested"` ⇒ (a) suspendre le budget de silence comme le fait la
   compaction, (b) poser une phase UI `awaiting_approval`, (c) lever une anomalie
   qui **nomme** l'attente. **Ne pas** inventer d'approbation automatique. Le
   chemin de résolution (`exec.approval.resolve` + surface UI) est un lot produit
   séparé, déclaré `gap` explicite au manifeste tant qu'il n'existe pas.
5. **Plan natif** (G-22) : branche `stream === "plan"` mappant `data.steps[]` /
   `data.explanation` vers la `PlanPart` existante
   (`bridge/src/core/plan-part.ts:14-19`), en **partageant** le normaliseur de
   statut d'étape avec le chemin tool pour qu'ils ne divergent jamais.

**Risque de régression et confinement** : (1) et (2) changent la classification de
trames aujourd'hui mal lues — le risque est de fermer une carte **trop tard** si un
gateway n'émet jamais `result`. Confinement : le flush des outils ouverts au
terminal du tour existe déjà côté Hermes (`hermes/ws-turn.ts:227-242`) et doit être
la garantie de dernier recours ici aussi (voir W7 pour sa généralisation) — aucun
spinner éternel ne doit être possible.

**Vérification**
- Séquence `start` / `update` / `result` ⇒ **aucun** `completed` avant `result`,
  et le `completed` final porte bien `input` ; `toolCallCount === 1`. Le probe
  `probe-tool-update.mjs` sert de test de régression immédiat.
- `lifecycle finishing` ⇒ une deadline **< 240 s** est armée (aujourd'hui `[]`) ;
  un `lifecycle end` portant `yielded:true` exempte la garde `empty_response`
  **même sans** tool `sessions_yield` ; un `timeoutPhase` apparaît dans la trace.
- `{phase:"end", willRetry:false, completed:false}` ⇒ un événement de compaction
  `failed` (aujourd'hui `[]`).
- `stream:"approval" phase:"requested"` ⇒ budget recv élargi + phase
  `awaiting_approval` (aujourd'hui `[]`).
- `stream:"plan"` ⇒ une `PlanPart` **identique** à celle produite par le chemin
  tool `update_plan` équivalent.
- Fixtures amont à figer sous `bridge/test/fixtures` depuis
  `$UP/…/handlers.lifecycle.ts:198-215` et `$UP/…/handlers.compaction.ts:152-160`.

---

### W6 — Tours Hermes bornés et honnêtes (fin des bulles figées) — effort L

> **NON LIVRÉ — reporté SCIEMMENT.** Mesure du 26/07 (`GET /compat` en prod) : les deux
> instances sont OpenClaw. La vague 3 (W6/W7/W12) corrige un provider **sans exposition
> production**. À reprendre le jour où une instance Hermes sert un client.

> **MESURE (2026-07-26, avant d'ouvrir le lot suivant).** `GET /compat` en
> **production** ne retourne **aucune instance Hermes** : les deux instances
> servies (`client-1`, `client-2`) sont `provider: "openclaw"`, gateway 2026.7.1.
> Conséquences pour l'ordre du programme :
>
> - la vague 3 (W6/W7/W12) corrige un provider **sans exposition production
>   actuelle** ; elle reste nécessaire au titre de P5 (Hermes est supporté), mais
>   elle ne précède plus W2, qui est la seule classe de défaut encore ACTIVE en
>   prod (4 occurrences en 3 jours, toutes soldées par un reset manuel) ;
> - **D3 est répondu par la mesure** : le transport REST n'est utilisé par aucune
>   instance de production (`transport` vaut `"ws"` par défaut, et aucune instance
>   Hermes n'existe). Le retirer ne casse donc aucun usage prod connu — reste à
>   confirmer les déploiements tiers avant de le faire.
>
> Ordre retenu : **W2 d'abord**, puis la vague 3.

**Lacunes** : G-36, G-37, G-38, G-39, G-40, G-41, G-42.
**Objectif observable** : sur Hermes, **aucune** bulle ne peut rester vivante sans
fin ; un message n'est jamais envoyé à l'aveugle sur une session occupée ; le
gateway n'attend **jamais** une réponse qu'Atrium ne peut pas donner.

**Pourquoi c'est nécessaire à la 1.0.0** : Hermes est le second provider supporté
(P5) et il concentre **trois** causes critiques et structurelles de gel, dont une
qui livre la réponse du tour N au message N+1 (G-36) — le symptôme le plus proche
de « conflits de trames ». Les défauts sont dans le **transport**, pas dans un
détail d'affichage.

**Contenu**
1. **Lire le `status` de l'ACK `prompt.submit`** (G-36) : `streaming` = seul cas
   qui ouvre un tour ; `queued` = phase honnête (« en file derrière un tour en
   cours ») + attente **bornée** explicite, sans laisser le watchdog générique
   gérer ; `steered` = refus de dispatch, **pas** de ligne fantôme (le texte est
   injecté dans le tour vivant, aucun terminal ne viendra jamais). En amont de
   tout : lire `running` / `status` du `session.resume` pour ne pas soumettre à
   l'aveugle. Et faire de `subscribeWsSession` une opération qui **refuse** si une
   voie existe déjà pour la même clé, au lieu d'écraser silencieusement
   (`hermes/dispatch.ts:157-169`).
2. **Deadlines absolues + ping applicatif** (G-37), symétriques à OpenClaw :
   budget de silence (~240 s), budget élargi quand une compaction est en vol
   (~900 s), budget « accepté mais muet » (aucun événement après l'ACK — le cas
   amont `$HE/…/server.py:9494-9508` où **aucun** terminal n'est émis, G-40). À
   expiration : finaliser avec un code stable dédié (`hermes_recv_timeout`,
   `hermes_compaction_timeout`), **désabonner** la voie et purger l'entrée du
   registre. Ping WS 30 s + `onClose` synthétique si pas de pong. Garantir que
   `unsubscribe` et `deleteWsTurnIf` s'exécutent sur **toute** sortie (le `finally`
   actuel n'est atteint que si `turnDone` résout).
3. **Répondre immédiatement aux quatre prompts bloquants** (G-38) : `clarify`,
   `secret`, `sudo`, `terminal.read` — refus explicite via les répondeurs
   existants (`$HE/…/server.py:11276-11292`) + marqueur in-thread qui **nomme** la
   demande. Un refus immédiat vaut infiniment mieux qu'un gel de 30 s à 5 min
   suivi d'une réponse vide. Corollaire P4 : la vraie correction est de rendre
   l'attente **impossible** côté gateway (politique d'approbation/secret sur les
   instances servies par Atrium) — pas de conseil de contournement à l'utilisateur.
4. **`approval.request`** (G-39) : envoyer `approval.respond {deny}` (et
   `session.interrupt` si l'intention est d'abandonner) **avant** de settler, pour
   que la session redevienne idle immédiatement et qu'**aucune** réponse fantôme
   ne soit persistée côté gateway.
5. **`abort` REST** (G-41) : deux options **exclusives**, à trancher —
   (a) retirer `abort` du jeu REST dans `compat.ts` et **griser** le bouton Stop
   (garde serveur **et** UI, conformément à P4) ; (b) obtenir en amont
   l'enregistrement du `run_id` du flux SSE. Dans les deux cas : **arrêter
   d'avaler le 404 en silence** (`hermes/dispatch.ts:524-529`).
6. **Classifieur transitoire** (G-42) : étendre la promotion de prose au format
   `^Error:\s` (les **deux** sites amont l'utilisent) et faire passer
   `classifyProviderInternal` sur le **texte** quand aucun champ d'erreur
   structuré n'est fourni. Posture fail-safe conservée : ambigu ⇒ pas de
   classification, pas de retry.

**Risque de régression et confinement** : introduire des deadlines là où il n'y en
avait aucune peut **tuer** un tour légitimement long. Confinement : les budgets
sont calqués sur ceux d'OpenClaw, éprouvés en production
(`normalizer.ts:80-81`), le heartbeat existant (`hermes/ws-turn.ts:327-334`) doit
continuer à repousser l'échéance, et l'horloge doit être **injectée** pour être
testable — jamais `Date.now()` en dur. Le point (1) est le plus délicat : un `queued`
mal géré transformerait un tour qui aurait abouti en refus. D'où l'exigence d'une
attente bornée **avant** tout refus.

**Vérification**
- Trois tests d'ACK avec client WS mocké : `queued` ⇒ **aucun** `beginTurn` +
  pas de finalize prématuré ; `steered` ⇒ pas de ligne orpheline, une erreur
  actionnable unique ; `streaming` ⇒ inchangé.
- Deux `runHermesWsTurn` sur le même `runtimeSessionId` ⇒ le second **échoue** et
  le premier reçoit toujours son `message.complete`.
- Horloge injectée : un tour ACKé qui ne reçoit **aucun** événement finalise au
  budget avec un code dédié **et** libère l'abonné (`wsSubscribers.size === 0`,
  `wsTurns` vide). Idem sur socket half-open (aucun `close` émis).
- Un test **par** prompt bloquant : un `*.respond` part dans le **même tick**, un
  marqueur in-thread est écrit, le tour ne reste pas bloqué. Le test **ÉCHOUE** si
  l'événement retombe dans le `default:`.
- `approval.request` ⇒ `approval.respond {deny}` avant le settle ; via
  `session.status`, la session redevient idle en < 2 s.
- Table-driven sur les formes amont exactes : `{status:"error", text:"Error: 503
  Service Unavailable"}` ⇒ `errorKind = provider_internal`, texte de réponse vidé,
  **et** auto-retry Convex déclenché ; `{… "Error: invalid api key"}` ⇒ **aucune**
  classification.
- Test de manifeste : `hermesCapabilitiesFor("rest")` ne contient plus `abort`
  (ou porte un marqueur dégradé) ; stub HTTP 404 ⇒ `performHermesAbort` ne
  rapporte **pas** un succès silencieux.
- Banc live : `display.busy_input_mode: steer` forcé sur le gateway de dev, deux
  messages coup sur coup ⇒ aucune bulle figée ; puis `SIGSTOP` du gateway en plein
  tour ⇒ finalisation bornée.

---

### W7 — Contenu et continuité de session Hermes — effort M

> **NON LIVRÉ — reporté SCIEMMENT** (même raison que W6 : aucune instance Hermes en
> production au 26/07).

**Lacunes** : G-43, G-44, G-45, G-46, G-47, G-48, G-49, G-50 (part SSE), G-51, G-52.
**Objectif observable** : ce que l'agent Hermes a dit reste dans le fil ; une
réponse interrompue est **marquée** comme telle ; les fichiers livrés arrivent ; et
l'agent n'« oublie » plus la conversation après une compaction.

**Pourquoi c'est nécessaire à la 1.0.0** : G-46 est la cause Hermes du symptôme
« il a oublié ce qu'on vient de dire / contexte dépassé » — le pendant exact du
lot W1/W2 côté OpenClaw. G-43 est documenté **par l'amont lui-même** comme un
risque de perte (« instead of losing it when `message.complete` replaces the
streaming buffer »).

**Contenu**
1. **`message.interim`** (G-43) : `already_streamed:false` ⇒ ajouter le segment au
   fil comme part propre ; `true` ⇒ **ancrer** le segment déjà streamé pour qu'il
   survive au remplacement par `message.complete`. Gated derrière la présence du
   champ pour rester compatible 0.18.2.
2. **Statuts honnêtes** (G-44) : `interrupted` ⇒ `run.status "aborted"` avec le
   texte partiel conservé ; **tout statut inconnu futur** traité comme
   non-complete (fail-safe), jamais comme un succès. Idem sur SSE en lisant
   `interrupted` / `partial` d'`assistant.completed`.
3. **`warning`** (G-45) : surfacé comme anomalie in-thread nommée (« le gateway n'a
   pas persisté cette réponse dans sa session ») — code stable seulement (P3).
4. **Rotation de session** (G-46) : REST — lire `session_id` sur
   `assistant.completed` et `run.completed` et, s'il diffère, appeler
   `bindProviderChat` (avec le même garde-fou d'epoch de reset que le bind
   post-ACK) ; WS — re-lier `stored_session_id` retourné par `session.resume`
   quand il diffère, et le consommer sur `session.info` comme signal de rotation
   mi-tour. **Cesser de dépendre** de la chaîne de continuation DB du gateway, qui
   n'est ni contractualisée ni testée.
5. **Récupération mi-tour** (G-47) : au `session.resume`, si `inflight` porte du
   texte assistant, **reprendre** le tour (réattacher la ligne streaming sur le
   texte partiel) au lieu d'en ouvrir un nouveau ; si `queued` est présent, savoir
   que le message précédent est encore en file. Sur perte de socket, tenter un
   `session.resume` de reprise **avant** de finaliser en erreur.
6. **`cwd`** (G-48) : remplacer l'appel mort `session.status` par une source qui
   porte réellement le `cwd` (`session.resume` → `info.cwd`, ou
   `session.active_list`), et rendre l'échec **bruyant** : un `cwd` inconnu alors
   qu'une livraison est attendue se trace avec un code stable, jamais un `return`
   muet (P8).
7. **Flush des outils SSE + `tool.failed`** (G-49) : porter `closeOpenTools` du
   chemin WS vers `HermesNormalizer.finalize` / `abortTurn` / `endTurn` ; ajouter
   `tool.failed` à `HERMES_EVENT_NAMES`, mappé en completed **en échec** (ce qui
   ferme aussi la FIFO `openTools` et évite un décalage d'appariement des appels
   suivants du même nom).
8. **`tool.output_risk`** (G-51) : tracer niveau de risque + nombre de findings +
   `redacted` + nom d'outil — payload **déjà** content-free.
9. **Sous-agents** (G-52) : rollups (tokens, `api_calls`, durée, coût, **compteurs**
   de fichiers) et cinq statuts distincts au lieu de deux.

**Risque de régression et confinement** : le point (4) touche le **binding** de
session — une erreur ici ferait écrire un tour dans la mauvaise session. Confinement
non négociable : réutiliser le garde-fou d'epoch de reset **existant** du bind
post-ACK, et ne jamais re-lier sur un événement dont la provenance n'est pas
vérifiée. Le point (1) risque une **duplication** de texte : d'où le test explicite
sur `already_streamed:true`.

**Vérification**
- Fixture WS enrichie (`bridge/test/fixtures/hermes/`) reproduisant la séquence
  live : deltas → `message.interim{already_streamed:true}` → `tool.start/complete`
  → deltas → `message.complete` ⇒ le texte final contient **aussi** le segment
  intermédiaire, et **pas** en double.
- `message.complete{status:"interrupted"}` ⇒ `run.status aborted` + texte conservé ;
  statut `"foo"` ⇒ **pas** de complete. Le test **ÉCHOUE** si le mapping redevient
  binaire.
- Fixture SSE : `run.completed` avec `session_id` différent de celui posté ⇒
  `bindProviderChat` appelé avec le nouvel id ; fixture WS : `session.resume`
  retournant un `stored_session_id` différent ⇒ même assertion.
- `session.resume` retournant `{running:true, inflight:{assistant:"abc",
  streaming:true}}` ⇒ **aucun** nouveau `prompt.submit`, ligne rattachée sur `abc`.
- Client mocké dont `session.status` renvoie `{output:"…"}` et `session.resume`
  `{info:{cwd:"/x"}}` ⇒ le scan de livraison s'exécute sur `/x` ; un `cwd`
  introuvable produit une trace de code stable (le test **ÉCHOUE** si le `return`
  redevient muet).
- Portage du test `bridge/test/hermes-ws-turn.test.ts:495` vers le normalizer SSE :
  `tool.started` puis frame `error` ⇒ un `tool.status completed` est émis pour cet
  id ; puis `tool.started` + `tool.failed` ⇒ même assertion.
- Anti-régression SOC2 : `tool.output_risk{risk:"high", findings:["a","b"],
  redacted:true}` ⇒ trace contenant le niveau et les compteurs, et **grep** sur le
  payload de trace prouvant qu'aucun champ de contenu n'y figure.
- Banc live : couper le WS en plein tour ⇒ la réponse est **récupérée** au lieu
  d'une bulle d'erreur ; forcer une auto-compaction puis vérifier au tour suivant
  que l'agent connaît les tours post-compaction.

---

### W8 — Sérialisation interne et écritures robustes — effort L

> **LIVRÉ (lots 7 à 10)** — chaîne d'application unique, collections bornées, gardes
> d'époque. Vérifié dans le code le 27/07 : `applyOrdered` (9 sites dans le
> run-manager) et les plafonds `capReached` / `MAX_SPAWNED_CHILDREN` du turn-sink.

**Lacunes** : G-28, G-29, G-30, G-31, G-32, G-34, G-35, G-27, G-15b, G-15c, G-33 (part bridge).
**Objectif observable** : aucune tâche interne ne peut écrire dans un tour qu'elle
n'a pas ouvert ; aucun blocage n'est illimité ; aucune troncature n'est silencieuse.

**Pourquoi c'est nécessaire à la 1.0.0** : ce sont les défauts d'ordre **réels**
d'Atrium — ceux qui ne viennent pas du gateway. G-28 écrit la réponse du tour N sur
le tour N+1 **et le finalise** ; G-30 et G-31 produisent des « Generation… » de
12 minutes sur des réponses complètes. Le patron de correction existe déjà **dans
le dépôt**, côté Hermes.

**Contenu**
1. **Chaîne d'application unique** (G-29, G-28) : `applyChain = applyChain.then(…)`
   dans `RunManager`, traversée par **tous** les producteurs (`feed`, `tick`, rejeu
   pré-ack, `flushPendingAnnounce`, `recoverVisibleText`, `endTurn`), avec le
   **contrôle d'époque à l'intérieur** de la chaîne. Patron déjà validé
   (`hermes/ws-turn.ts:259-265`). En attendant / en complément, garde d'époque
   explicite dans `RunManager.recoverVisibleText(text, now, expectedEpoch)` — de
   sorte qu'**aucun** appelant transverse ne puisse toucher un tour qu'il n'a pas
   ouvert (contraste probant : `scheduleOrphanRecovery` capture déjà `boundEpoch`,
   `session.ts:699`, `:737-741`).
2. **Finalize rejouable** (G-30) : retry borné avec backoff dans `doPost` pour les
   ops **idempotentes** (finalize l'est : Convex est first-terminal-wins) ;
   conserver le triplet (`messageId`, statut, texte, erreur, `errorKind`) dans une
   file de finalisations en attente repoussée sur la boucle de consommation ;
   remonter l'échec comme **anomalie** observable au lieu d'un `console.error`.
3. **Upload média borné** (G-31) : `AbortController` + deadline dans
   `streamToUploadUrl` (aligné sur `WRITE_TIMEOUT_MS` ou un budget proportionnel à
   la taille) ; `Promise.race` sur `await this.mediaChain` — au-delà, **finaliser le
   texte** et laisser la pièce jointe manquante produire un diagnostic média ;
   borner `finalizeInFlight` dans le temps pour que le flush des announces reprenne.
4. **Ne plus jeter la fin d'un lot** (G-32) : `continue` + log au lieu de `return`.
5. **Bornes et logs** (G-34, P8) : cap explicite + un log unique par épisode sur
   `toolArgs`, `mediaPaths`, `observedChildKeys`, `hostedThisTurn`,
   `spawnedChildKeysThisTurn`, et log de troncature sur `deferredEvents`, sur le
   modèle de `stashAnnounceFrame` (`run-manager.ts:658-673`).
6. **Horloge d'arrivée** (G-35) : passer `entry.now` (borné à `now`).
7. **File entrante bornée** (G-27) : plafond ; au dépassement, **fermer** la
   connexion avec un code stable (`inbound_overflow`) — la reprise par transcript
   recovery existe déjà et est le chemin sûr. Publier `inboundQueueLen`.
8. **Honnêteté documentaire** (G-15b, G-15c) : documenter que la garantie
   anti-duplicat des announces est **Convex**, pas le `Set` de 100 ; faire porter
   au bridge un `observedAt` d'**événement** et trier les ancres de sous-agents
   dessus.

**Risque de régression et confinement** : la chaîne d'application unique touche le
cœur du chemin d'écriture — c'est le lot le plus risqué du programme après W2.
Confinement : (a) la chaîne ne change **pas** l'ordre nominal (elle le garantit),
donc tous les tests d'ordre existants doivent rester verts sans modification ;
(b) livrer d'abord la garde d'époque de `recoverVisibleText` (correctif S,
autonome, immédiatement déployable) et **seulement ensuite** la chaîne ; (c) le
retry de finalize doit être strictement limité aux ops idempotentes — un retry sur
une op non idempotente dupliquerait du contenu.

**Vérification**
- Ouvrir le tour A (item message-tool + final ack privé), déclencher la
  récupération avec un fetcher qui résout **après** un `beginTurn` du tour B ⇒ le
  message de B ne reçoit ni `setSnapshot` ni `finalize`. (Aucun test existant ne
  couvre ce cas : `bridge/test/history-recovery.test.ts:171` ne teste que le tour
  finalisé non rouvert.)
- `beginTurn` avec un tampon pré-ack de 3 snapshots dont `sink.apply` est ralenti,
  plus un `feed` live injecté en parallèle ⇒ la séquence de `setSnapshot` vue par
  un writer factice est **strictement** l'ordre d'arrivée.
- Writer dont `finalize` échoue une fois puis réussit ⇒ le message finit finalisé ;
  un `throw` dans `feed()` lève une anomalie **observable** (aujourd'hui : un log).
- `writer.addMedia` qui ne résout jamais ⇒ `flushFinal` se termine quand même, le
  message est finalisé, et `pendingAnnounce` est vide après ce finalize.
- 2000 `tool:start` sans résultat dans un tour ⇒ `toolArgs` reste à son cap et
  produit **exactement un** log ; 600 événements différés ⇒ un log de troncature.
- Stash à t=10 et t=20, flush à t=200 ⇒ les échéances armées dérivent de 10/20.
- `cap + 1` trames avec consommateur bloqué ⇒ fermeture avec le code stable, pas
  de croissance.
- Banc live : couper l'ingest Convex 2 s pendant un finalize ⇒ le message se ferme
  **sans** attendre le watchdog ; fetcher média pointant sur un endpoint qui pend.

---

### W9 — Auto-découverte des trames non traitées (« Frame Shape Registry ») — effort L

> **TRANCHE 1 LIVRÉE — lot 23 (2026-07-27).** Les points **6** (dérivation de
> `KNOWN_AGENT_FIELDS`, G-68) et **8** (drift durci, G-66) sont faits ; le reste de la
> vague est la tranche 2. À ne pas confondre avec le détecteur de dérive existant
> (`protocol-drift.ts`) : celui-ci compte des NOMS DE CHAMPS inconnus sur les événements
> chat/agent, en mémoire. W9 demande en plus une signature STRUCTURELLE (chemins typés
> bornés), six capteurs, une table `protocolShapes` et un pont vers les anomalies. Le
> détecteur en est l'embryon — c'est lui qui a signalé `agent.lastTo` ×24 en prod le 26/07.
>
> **Livré (tranche 1)**
> - **Point 6 — fin du cycle « badge prod → patch ».** `KNOWN_AGENT_FIELDS` est DÉRIVÉ de
>   trois sources énumérables : la forme de retour de `buildSessionEventSnapshot` extraite
>   de la source amont **au moment du vendoring** (`bridge/scripts/lib/derive-snapshot.mjs`,
>   sur le parseur TypeScript — un scanner d'accolades écrit à la main avait accumulé 14
>   défauts : accolades dans les chaînes, littéraux de regex, `return {` en commentaire),
>   les champs de `AgentEventSchema`, et l'enveloppe de routage déclarée explicitement.
>   Artefact vendoré `session-event-snapshot.json` (52 champs) + bloc `derived` dans
>   `PROVENANCE.json` ; `vendor-integrity.test.ts` **re-dérive** et compare élément par
>   élément (comparer les seuls cardinaux laissait passer une fabrication de même
>   longueur). Preuve du besoin : 14 champs que l'amont émet manquaient, dont `lastTo`,
>   signalé ×24 en prod le 19/07 et jamais ajouté.
> - **Point 8 — drift par ÉTAT** (`KNOWN_CHAT_FIELDS_BY_STATE`) au lieu de l'union : un
>   `aborted` portant `deltaText` était compté 0. Un état non reconnu est reporté sous
>   `chat.«unknown-state».<digest>` : **le point 1 du contenu ci-dessous, qui autorise cinq
>   discriminants à porter une valeur littérale filtrée par charset, est ERRONÉ et
>   contredit le principe directeur de la vague** — un filtre de charset est procédural,
>   pas structurel (`AliceMartin` le passe), et cette forme est stockée et affichée. Un
>   digest à sens unique garde tout ce dont un opérateur a besoin (stable entre trames,
>   comparable entre bridges, un identifiant par état distinct) sans porter la valeur. Le
>   nom se retrouve là où il appartient : le diff de schéma vendoré de la version qui
>   l'introduit. **La tranche 2 doit appliquer la même règle aux quatre autres
>   discriminants.** `Object.hasOwn`, pas
>   d'indexation nue : `state: "toString"` renvoyait une FONCTION du prototype, `has`
>   jetait, et le catch observe-only avalait tout — un détecteur qu'on peut faire taire
>   avec la valeur qu'il inspecte.
> - **Point 8 — débordement inclus dans le flush**, des deux côtés et bout en bout :
>   `driftOverflow` (ce que le BRIDGE n'a pas pu nommer) et `driftTruncated` (ce que la
>   frontière Convex a refusé de stocker) sont portés, re-plafonnés, sommés et rendus dans
>   `BridgeTab`. Le pli multi-bridges est un point d'entrée UNIQUE (`foldProtocolInfo`) qui
>   borne une seule fois : tronquer à chaque étape rendait le pli non associatif — une
>   forme petite sur un bridge revenait sur un autre avec un compte amputé. Les compteurs
>   exigent un ENTIER ; un fractionnaire était planché en « × 0 », c'est-à-dire présenté
>   comme une forme observée jamais.
> - **Point 8 — auto-échec du détecteur.** Le `catch` observe-only ne se tait plus : la
>   défaillance est comptée comme une forme à part (`«detector-failure».<Classe>`), donc
>   elle emprunte la conduite déjà bornée, reportée et rendue. Classe d'erreur seule,
>   jamais `err.message` (SOC2).
>
> **Reste (tranche 2)** : signature structurelle (point 1) ; les six capteurs, dont C4
> exception (point 2) — l'auto-échec ci-dessus n'en est que le cas dégénéré, le capteur
> général reste à écrire ; axes manquants (3) ; table `protocolShapes` + cron horaire (4) ;
> découverte proactive au hello-ok (5, G-70) ; manifeste `agent.data` (7) ; MCP
> `list_protocol_shapes` (9) ; boucle `shape-to-fixture` (10).
>
> **Décidé de ne PAS faire** : `outboundDrift` symétrique (point 8) — le sortant est déjà
> sous cliquet par G2 (W10 : 26 méthodes validées contre le schéma amont à l'émission).
> Observer une dérive sortante ferait double emploi avec un cliquet qui la rend impossible ;
> à rouvrir seulement si le cliquet devait être desserré.

> **TRANCHE 2a LIVRÉE — lot 28 (2026-07-28). Le capteur C4, et ce qu'il a fait tomber.**
>
> - **Le capteur prioritaire est posé, et il est posé sur le LECTEUR.** Une trame que le
>   code ne sait pas lire du tout était un `console.error` dans stdout : absente de tout
>   rapport, invisible pour l'opérateur dont la conversation venait de casser. Elle est
>   maintenant comptée comme `«exception».<Classe>@<site>.<forme>` sur la conduite déjà
>   bornée du lot 23. **Placer le capteur a été plus dur que l'écrire** : le programme
>   nommait deux sites de catch, le fichier en avait trois, et deux lecteurs contournaient
>   entièrement cette boucle (rejeu pré-ack, relais vocal). D'où le déplacement sur
>   `RunManager.feed`, qui couvre tout appelant présent et futur.
> - **UN décodeur pour tous les transports.** `JSON.parse("null")` réussit et un cast ne
>   valide rien à l'exécution : le `null` atteignait le premier accès de propriété et
>   levait une TypeError HORS de tout garde, dans un callback de socket. Corrigé côté
>   Hermes d'abord, la revue a trouvé **le même défaut sur la socket opérateur OpenClaw —
>   la connexion PARTAGÉE que toutes les conversations empruntent** : une seule trame
>   illisible pouvait emporter le bridge. `decodeInboundFrame` est désormais l'unique
>   décodeur, et un lint interdit à tout module de transport de faire son propre
>   `JSON.parse` — la classe, pas les deux instances.
> - **Une réponse perdue ne porte plus un badge de succès.** Le normalizer SSE Hermes
>   avalait un corps non-JSON et continuait avec `{}` : sur `run.completed`, le tour
>   finalisait en **succès vide**. La dégradation est faite dans `finalize` — un seul
>   endroit, donc un chemin `complete` ajouté plus tard ne peut pas l'oublier — et la
>   corruption est mémorisée pour TOUT le tour, parce que ne garder que le terminal
>   laissait le même trou une branche plus loin (un `assistant.delta` illisible suivi d'un
>   `done` propre).
> - **Budget réservé aux formes de capteur, et priorité RÉAFFIRMÉE à chaque borne.** Une
>   rafale de champs inconnus saturait le registre et réduisait une exception de lecture à
>   un tick d'overflow anonyme. Le budget séparé ne suffisait pas : la frontière Convex
>   garde un PRÉFIXE, et le fold retriait par compte — trois endroits décident d'un ordre,
>   les trois portent la règle. La borne BRUTE reste un préfixe simple, décision écrite et
>   épinglée : la rescaper obligeait à parcourir tout le tableau, ce qui casse une garde
>   anti-déni de service réelle, et contre un bridge assez divergent pour enterrer sa
>   propre exception la priorité n'achète rien — il lui suffit de l'omettre.
>
> **Boucle Codex : 9 passes, 9 défauts réels, tous dans MA correction.** Motif : à chaque
> fois que je fermais un chemin, le lint qui devait prouver la fermeture était vert pour
> une mauvaise raison — il lisait le fichier REST alors que le WS est le transport par
> défaut ; il comptait un motif d'appel qu'un reformatage suffisait à masquer ; il comptait
> le mot `feed` dans la prose ; il ignorait les sites câblés via le décodeur partagé.
>
> **NON FAIT, et pourquoi.** Le parcours de chemins typés et sa signature (point 1) : il
> émettrait des noms de clés venant de régions libres (`args` d'outil, métadonnées), donc
> du contenu potentiellement rédigé par l'utilisateur — la conception de confinement est
> load-bearing et n'est pas un ajout ; et les chemins n'ont de toute façon nulle part où
> vivre avant la table du point 4. Manifeste `agent.data` (point 7) : **bloqué**, l'amont
> déclare `stream: NonEmptyString`, donc le vocabulaire n'est pas dérivable du schéma
> vendoré — il faut une dérivation depuis les sites d'émission, comme au lot 23. Table
> `protocolShapes` + cron (4), hello-ok (5), MCP (9), boucle shape-to-fixture (10).
> **Reporté au lot suivant, avec sa preuve** : une trame WS Hermes illisible est signalée
> puis ignorée sans notifier les tours abonnés — si c'était le terminal d'un tour, celui-ci
> reste en streaming jusqu'au watchdog. C'est un défaut de VIVACITÉ, pas de silence, et sa
> correction change un comportement de connexion sur le transport par défaut : elle mérite
> son propre lot et sa propre validation live.

> **LOT 29 (2026-07-28) — le report du lot 28, et ce qu'il cachait.**
>
> - **Le tour WS Hermes n'avait AUCUNE échéance.** `await turnDone` attendait un terminal
>   ou la mort de la socket, sans borne : une trame perdue ou un gateway silencieux
>   laissait la ligne en `streaming` jusqu'au watchdog Convex — `STALE_STREAM_MS`, soit
>   **douze minutes de « Réflexion… »** pour quelqu'un qui attend une réponse déjà perdue.
>   Le chemin OpenClaw arme une échéance de réception depuis l'écriture de son normalizer ;
>   ce transport n'en avait simplement jamais eu. Budget aligné sur celui d'OpenClaw
>   (240 s) et très en deçà du watchdog, qui redevient le filet qu'il devait être.
>   Ré-armé par TOUT événement de la session, monitoring compris : une délégation qui
>   rapporte encore n'est pas un fournisseur bloqué.
> - **Ce qui est attribuable l'est.** Quand l'enveloppe est lisible mais pas la charge, la
>   trame dit encore de QUI elle est : sur un terminal, ce tour reçoit une erreur nommée au
>   lieu d'attendre un terminal déjà arrivé cassé. Sur un non-terminal, c'est un delta
>   perdu — rapporté, rien de plus : terminer un tour pour un delta échangerait un défaut
>   visible contre un pire. Le vocabulaire terminal est LU dans le switch du lecteur (les
>   trois cas qui appellent `settle()`), jamais deviné.
> - **`payload: null` reste inchangé, délibérément.** Le refuser risquait de faire tomber
>   un événement légitime et donc de figer un tour ; l'échéance rend désormais ce risque
>   borné dans les deux sens, et le cas est visible en C4 depuis le lot 28. La décision se
>   prendra sur des mesures, pas sur une intuition.
>
> - **« Accepté » est devenu porteur, et ma première réponse était mauvaise.** L'ACK de
>   `prompt.submit` n'était pas validé contre son contrat déclaré. Refuser d'armer sur un
>   ACK non conforme laissait le tour sans AUCUNE borne, `finally` jamais exécuté, donc
>   abonnement vivant et run retenu par conversation. Corrigé : **borner dans tous les
>   cas** ; l'ACK ne décide plus que de la LIAISON de session, en étendant la règle déjà
>   écrite pour l'échec d'envoi. Et l'échéance appelle `session.interrupt` au mieux : le
>   silence ne prouve pas que le run s'est arrêté.
>
> **Reporté au lot 30, avec sa preuve et son cadrage honnête** : à l'échéance, la session
> STOCKÉE reste liée, donc un renvoi peut reprendre la même session pendant que
> `session.interrupt` est encore en vol ou après son échec. Ce risque n'est PAS créé par ce
> lot — il existait à l'identique, la conversation restant simplement occupée jusqu'au
> watchdog : le renvoi devenait possible à 12 minutes au lieu de 4. Ce lot le rend donc
> atteignable plus tôt tout en ajoutant l'interruption qui n'existait pas. Le fermer exige
> d'invalider la liaison, ce qui traverse la logique d'époque de reset (`generationOf` +
> `bindProviderChat` atomique, zone à historique P1) et demande sa propre validation live.
>
> **Validation live** : le banc ne peut pas produire ce cas. Exercé en gelant le conteneur
> Hermes (`docker pause`) EN PLEIN TOUR, socket ouverte donc sans `onClose` : le tour reste
> `streaming` à zéro caractère, puis se règle seul à l'échéance avec `response_timeout`.
> Un tour normal, lui, traverse intact la nouvelle enveloppe de ré-armement.

> **LOT 30 (2026-07-28) — la session non fiable, et la moitié REST du lot 29.**
>
> Les deux moitiés sont prises ENSEMBLE, parce que les séparer est le piège déjà payé deux
> fois en trois lots (lot 28 : Hermes corrigé et OpenClaw laissé ouvert ; puis REST corrigé
> et WS laissé ouvert).
>
> - **Une session dont on ignore si le run vit encore n'est plus reprise.** L'interruption
>   posée au lot 29 est au mieux : elle peut être en vol ou échouer, donc le prochain envoi
>   ne doit pas pouvoir reprendre cette session. Le trio est celui que `/reset` exécute
>   déjà — interrompre, oublier en mémoire, effacer la liaison persistée. **L'ORDRE est la
>   garantie** : l'effacement est attendu AVANT le règlement, tant que la conversation est
>   encore occupée, donc aucun tour ultérieur n'existe sous la liaison duquel le bump
>   d'époque pourrait atterrir. Et la garde de génération couvre MOINS qu'elle n'en a l'air
>   (`generationOf` ne bouge que sur `/reset`) — écrit tel quel dans le code.
>   **Seulement sur le silence** : une erreur livrée dit que le run est fini.
> - **Le chemin REST n'avait pas de borne non plus.** Le corps du flux était
>   « délibérément non borné », décision antérieure au raisonnement du lot 29 : un
>   fournisseur muet y laissait le tour attendre douze minutes. Même budget, désormais
>   PARTAGÉ (`RECV_SILENCE_MS`, à côté du budget d'avant-envoi qu'il complète), même cause
>   nommée, même invalidation. La raison d'abort distingue le renoncement du tour d'un Stop
>   utilisateur — sans quoi les deux ne sont qu'un même `AbortError`.
> - **Six défauts trouvés en revue, tous nés des choix de ce lot** : le REST n'arrêtait pas
>   le run côté serveur ; l'invalidation échouait en silence ; un Stop concurrent cassait
>   l'ordre ; ma relance ne relançait rien (la garde de génération la neutralisait) ;
>   l'oubli mémoire ne suffisait pas (le chemin d'envoi préfère la valeur persistée) ; et
>   la quarantaine ne couvrait que le REST alors que **le WS est le transport par défaut**
>   — troisième occurrence du même angle mort. Leçon retenue : **un test qui pilote une
>   fonction ne prouve pas que l'appelant l'utilise** ; un lint de source vise désormais le
>   câblage.
> - **Reporté, avec son périmètre exact** : la quarantaine est en mémoire. Si le clear
>   échoue deux fois ET que le bridge redémarre avant un clear ultérieur, l'identifiant
>   persisté redevient sélectionnable. Fermer exige un état DURABLE au dispatch (schéma +
>   mutation) et sa propre validation. Résidu strictement plus étroit qu'avant ce lot.
> - **OpenClaw est un NON-CAS, avec preuve** : clé de session stable, donc un renvoi vise
>   la même session, mais un run vivant y produit un `session_init_conflict` — un échec
>   nommé et traité, pas un double run silencieux. Rien à invalider ; dit explicitement.

> **LOT 31 (2026-07-28) — supprimer le mode de panne au lieu de le compenser.**
>
> - **L'invalidation de session rejoint le `finalize`** (`clearProviderSession`, aux côtés
>   de `discardStreamText` et `gatewayPreempted`, tous « atomic with the finalize by
>   design »). Deux issues seulement, aucune mauvaise : le finalize atterrit et la session
>   est effacée, ou il n'atterrit pas et le tour n'est pas réglé — donc la conversation
>   n'est jamais libérée et rien ne reprend. Le drapeau hérite en prime de la relance des
>   ops idempotentes.
> - **Le gain est une SUPPRESSION** : quarantaine, `releaseQuarantine`, `sessionForgotten`,
>   `invalidateSession` et ses relances, les deux callbacks `onSessionUntrusted`. Garder
>   les deux mécanismes aurait été la demi-migration qui a produit trois des six constats
>   du lot 30.
> - **Le cas sans finalize est couvert ailleurs** : un reap du watchdog signifie « personne
>   n'a réglé ce tour », la même ignorance — il efface donc aussi, borné par la garde de
>   FORME partagée et non par le site d'appel.
> - **Un finalize sauté saute l'effacement, et c'est voulu** : la bulle appartient alors à
>   un run announce VIVANT sur cette session.
> - **La faille de test annoncée par l'avis s'est trouvée à sa place** : entre
>   `writer.finalize` et la charge d'op postée. Les tests de tour espionnaient le writer,
>   les tests Convex appelaient la mutation — retirer la ligne du writer les laissait TOUS
>   verts. Un test vise désormais le fil. **Puis la revue en a trouvé un CINQUIÈME saut** :
>   `/bridge/ingest` ne déclarait ni ne relayait le champ, donc en production la session
>   n'était JAMAIS effacée pendant que tous les tests étaient verts, chacun s'arrêtant
>   d'un côté ou de l'autre du trou. Règle : compter les sauts d'un drapeau et couvrir le
>   plus long segment non testé, pas les extrémités.
> - **Le fil porte l'IDENTIFIANT de session, pas un booléen** : un saut qui le perd échoue
>   alors FERMÉ (coût, une réhydratation) au lieu d'effacer une liaison peut-être plus
>   récente. Le changement de type fait lever le compilateur sur les cinq sauts.
>   `v.boolean()` reste accepté une release, sans quoi un vieux bridge en déploiement
>   roulant verrait son finalize rejeté et son tour coincé en `streaming`.
> - **Trois chemins de plus, tous « on ne sait pas si le run vit encore »** : la socket
>   morte (qui finalisait via un `error` injecté — la branche « le gateway a livré un
>   échec » — et gardait sa session, alors qu'il n'y a même pas d'`interrupt` à envoyer),
>   le flux SSE qui finit sans trame terminale ou casse en lecture, et la sortie
>   « déjà terminal » de `finalize` (un Stop utilisateur finalise la bulle pendant que le
>   terminal de silence est en vol, et sur un Stop le bridge n'écrit AUCUN terminal).
> - **Partage propriétaire / tardif** : un finalize qui transitionne possède le tour et
>   peut bumper un slot vide (sa propre liaison peut être en vol) ; un finalize tardif ne
>   retire qu'une correspondance EXACTE. La proposition « correspondance exacte partout »
>   a été REFUSÉE : elle fermait un défaut mineur en rouvrant le principal.
> - **REPORTÉ, cadré** : le drain peut remettre en circulation une session qu'un terminal
>   en vol va déclarer non fiable — `selectPriorSession` préfère l'`openclawChatId` que
>   Convex a mis dans le corps de dispatch, lu avant que l'effacement n'atterrisse.
>   Fenêtre = vol du POST **et** Stop utilisateur pendant ce vol **et** message en file ;
>   vaut pour les trois chemins. Aucun état côté bridge ne la ferme (ce serait la
>   quarantaine et son trou au redémarrage) : il faut un état durable lu AU DRAIN, donc
>   schéma + mutation + validation propre. **Strictement plus étroit qu'avant le lot.**

**Lacunes** : G-33, G-66, G-67, G-68, G-69, G-70, G-53, G-71.
**Dépend de** : rien pour le socle ; W10 pour que la découverte se **referme** en
ratchet (étape 4 de la boucle).
**Objectif observable** : le système se plaint **avant** l'utilisateur. Un
opérateur peut répondre à « cette version de gateway émet-elle quelque chose que
nous ne traitons pas ? » sans attendre un incident client.

**Pourquoi c'est nécessaire à la 1.0.0** : c'est l'antidote direct au constat
central du registre prod — quatre classes de défauts en cinq jours, **toutes**
découvertes par l'utilisateur (`10-registre-prod.md:44-48`). Et c'est structurellement
la **seule** couverture possible, puisque le schéma amont n'est pas autoritaire sur
l'émission (`$UP/…/schema/agent.ts:57-67` déclare `additionalProperties:false`,
`$UP/src/gateway/server-broadcast.ts:189-197` diffuse sans validation).

**Principe directeur, non négociable** : *on ne capture jamais une trame ; on
capture sa **FORME*** — une liste de chemins **typés** obtenue par un parcours qui
ne lit jamais une valeur scalaire, seulement son `typeof`. La non-fuite est
**structurelle**, pas procédurale (P3).

**Contenu**
1. **Signature structurelle** : chemins typés bornés (profondeur ≤ 6, ≤ 64 clés par
   objet, ≤ 256 chemins, tableaux fusionnés en `[]`), clé = `sha256(provider |
   gatewayVersion | discriminants | chemins triés)` tronquée à 16 hex —
   déterministe donc dédupliquable côté serveur. **Cinq discriminants seulement**
   peuvent porter une valeur littérale (`frame.event`, `payload.stream`,
   `payload.state`, `data.kind`, `data.phase`), chacun filtré par
   `^[a-zA-Z][a-zA-Z0-9._-]{0,47}$` **côté bridge ET côté Convex** (double
   barrière). Ni longueur de chaîne, ni préfixe, ni hash de valeur.
2. **Six capteurs, tous observe-only** : C1 event de type inconnu
   (`normalizer.ts:697-702`), C2 `stream` inconnu (sortie de `handleAgent`), C3
   champ inconnu **élargi aux chemins `data.*`**, **C4 exception**
   (`session.ts:547-551` — le capteur **prioritaire** : une exception est une trame
   que le code n'a pas su lire du tout, et c'est aujourd'hui un `console.error`
   dans stdout), C5 trou de `seq` d'enveloppe (fourni par W3), C6 compteurs de
   perte de contenu nommés (`msgtool_args_unparsable`, `pending_overflow`,
   `announce_stale_drop`). Mêmes capteurs côté Hermes (P5), registre **partagé**,
   seul le champ `provider` diffère.
3. **Axes manquants** : `provider`, `gatewayVersion`, `instanceName`,
   `bridgeVersion`, `vendoredVersion` — renseignés par le bridge, **jamais** par la
   trame. `instanceName` est nécessaire **en plus** de `gatewayVersion` car deux
   gateways de même version divergent légitimement selon la config admin
   (précédent documenté `protocol-drift.ts:84-90`).
4. **Table dédiée `protocolShapes`**, upsert par `by_shape`, avec un **pont** vers
   `anomalies` : un cron horaire ouvre **UNE** ligne `protocol.unknown_shapes` via
   `upsertDetectorAnomaly`. **Contrainte de conception ferme** : ne **pas** insérer
   dans `anomalies` par forme — `reportAnomalyInternal` n'a aucun dédoublonnage et
   notifie les admins à **chaque** insertion (`convex/anomalies.ts:741-791`,
   `:780-788`) ; une remontée naïve noierait les admins.
5. **Découverte proactive** (G-70, gain immédiat) : au hello-ok, comparer
   `features.events` / `features.methods` à la surface connue du build et écrire une
   ligne `capture:"undeclared_event"` par écart. On sait alors **au démarrage**, pas
   au premier incident. Idem Hermes via `GET /v1/capabilities`, déjà appelé.
6. **Dérivation de `KNOWN_AGENT_FIELDS`** (G-68) : extraire au moment du vendoring
   la forme de retour de `buildSessionEventSnapshot`
   (`$UP/src/gateway/server-chat.ts:466-519`) dans un fichier vendored dédié et
   **dériver** la liste (snapshot ∪ champs `AgentEventSchema` ∪ enveloppe de
   routage) au lieu de l'entretenir à la main. Fin du cycle « badge prod → patch ».
7. **Manifeste de vocabulaire `agent.data`** (G-67) : énumérer streams connus,
   phases connues **par** stream, verdict `handled`/`ignored`/`gap` avec la ligne
   d'émission amont en preuve ; toute valeur hors manifeste comptée dans le drift.
   Corriger le verdict `AgentEvent.seq`, aujourd'hui `handled` avec une preuve
   fausse — il doit être `gap` déclaré jusqu'à ce que W3 livre la détection.
8. **Drift durci** (G-66) : par **état** au lieu de l'union
   (`delta`/`final`/`aborted`/`error`), `outboundDrift` symétrique, débordement de
   borne **inclus dans le flush** (corrige la double perte silencieuse
   bridge + `convex/lib/compat.ts:263-264`), compteur d'auto-échec du détecteur.
9. **Restitution** (P9) : MCP `list_protocol_shapes` / `get_protocol_shape` ;
   tableau **par version de gateway** dans `BridgeTab` avec le détail des chemins
   typés (c'est précisément ce qu'il faut pour écrire le correctif sans accès au
   gateway) ; message opérateur « cette version émet une trame que nous ne traitons
   pas » + bouton « Générer la fixture » — jamais « ignorez-la » (P4).
10. **Boucle de fermeture** : `shape-to-fixture` génère une trame **synthétique**
    (valeurs neutres — aucun contenu réel n'existe dans la base) ; un test paramétré
    parcourt `fixtures/discovered/**` et asserte que le normalizer **ne jette pas**
    et **classe comme déclaré** ; le ratchet **ÉCHOUE** si une fixture existe sans
    entrée dans `coverage.json`. Limite assumée : une fixture synthétique prouve
    « on ne casse pas, on classe » — **pas** la sémantique. Pour la sémantique,
    plan 2 **strictement local** (`BRIDGE_FRAME_DUMP` existe déjà, opt-in, logs
    bridge seulement), jamais en base.

**Risque de régression et confinement** : c'est de l'instrumentation observe-only —
aucune trame n'est rejetée ni mutée. Les deux risques réels sont (a) la **fuite de
contenu**, écartée par construction (B1-B7 du rapport 08) et prouvée par un test
adverse ; (b) la **tempête d'écritures**, bornée par déduplication par forme,
512 formes/instance-version en LRU, flush 60 s, ≤ 1 flush/10 s, ≤ 64 formes par
flush, plus un re-filtrage côté Convex (le bridge n'est pas de confiance). Volume
attendu : quelques centaines de lignes, ~100 Ko en régime normal.
**Contrainte P7** : ce lot ne justifie **pas** une release à lui seul — il voyage
avec W3, W4 ou W5.

**Vérification**
- **Test adverse SOC2** : injecter du contenu conversationnel dans **chaque**
  position (clé, valeur, `stream`, `event`, message d'erreur) et asserter qu'aucun
  octet ne ressort. Précédent à étendre : `bridge/test/protocol-drift.test.ts:46-48`
  (une valeur `"secret content"` injectée, seul le nom ressort). `errorClass` =
  `err.constructor.name`, **jamais** `err.message`.
- Un capteur = un test : event inconnu, `stream` inconnu, champ `data.*` inconnu,
  **exception** (une trame qui fait jeter `feed` ⇒ une ligne `capture:"exception"`
  avec `errorClass` + `errorSite`), `seq_gap`, compteurs de perte de contenu.
  Chacun **ÉCHOUE** si le capteur est retiré.
- Déterminisme : la même trame produit deux fois la même `shapeKey`, entre deux
  processus.
- Bornes : 600 formes distinctes ⇒ 512 conservées + `overflowCount` **dans le
  flush** (aujourd'hui : un `console.error` invisible).
- Ratchet : ajouter une fixture `discovered/` sans entrée `coverage.json` ⇒ CI
  **ROUGE**. Bijection `KNOWN_AGENT_FIELDS` === (snapshot vendored ∪
  `AgentEventSchema` ∪ enveloppe) ⇒ **ROUGE** si l'un des 12 champs manquants est
  retiré du fichier vendored.
- Drift par état : une trame `aborted` portant un champ inconnu d'un **seul** état
  est comptée (aujourd'hui : 0, masquée par l'union).
- Live dev : après démarrage, `list_protocol_shapes` doit lister les écarts
  `undeclared_event` déduits du hello-ok, **sans** attendre aucun incident.

---

### W10 — Ratchet de version et refus d'échouer ouvert — effort L

> **PARTIELLEMENT LIVRÉ (lot 14, 2026-07-26)** — la MACHINE est en place ; la
> classification des modules restants est du travail humain, scopé à part.
>
> **Livré** : G0 (script de vendorisation + `PROVENANCE.json` + porte d'intégrité),
> G1 (cliquet multi-versions, manifestes `coverage/<version>.json`), Q21
> (`maxValidated` sans répertoire vendoré = ROUGE), Q24 (les trois affirmations
> fausses corrigées), la dérivation mécanique du périmètre RPC, et **la porte qui
> manquait le plus** : `tsc --noEmit -p convex` dans le CI et dans `npm run typecheck`.
>
> **Ce que le lot a appris et qui corrige ce document :**
>
> - **Le compte de « 5 additions 7.1 » était faux : il y en a 3.** Vendoriser 2026.7.1
>   a fait sortir `ChatAbortedEvent.errorMessage`,
>   `ChatSendParams.expectedSessionRoutingContract` et
>   `ChatAbortParams.preserveSideRuns`. Les deux autres attendues
>   (`ChatHistoryParams.offset`, `AgentParams.cwd`) vivent dans des schémas classés
>   **ignored en entier** — un nouveau champ dans un schéma ignoré ne change rien pour
>   nous, et c'est correct. Le commentaire de `DRIFT_VENDORED_VERSION` affirmait, lui,
>   que « 6.11 + un champ EST la surface 7.1 » sur la foi d'un banc : **un banc observe
>   les champs qu'un scénario exerce, il n'énumère pas un contrat.** C'est exactement la
>   confusion que le cliquet existe pour rendre impossible.
> - **Les trois champs se classent honnêtement en `gap`, pas en `handled`.** Le premier
>   jet donnait `handled` à `ChatAbortedEvent.errorMessage` : faux — la branche
>   `aborted` finalise et RETOURNE avant la lecture qui sert `state === "error"`.
>   Conséquence réelle : une annulation décidée par un coordinateur ou un timeout est
>   indiscernable d'un Stop utilisateur. Les deux autres sont des champs SORTANTS que
>   le bridge n'envoie pas (`additionalProperties:false` ⇒ le gateway plancher les
>   rejetterait) ; l'un est le remède amont au mauvais routage, l'autre épargnerait un
>   run BTW du bouton Stop. Trois écarts VISIBLES dans la matrice opérateur là où il
>   n'y avait que des omissions.
> - **26 RPC appelées, une seule famille sous contrat.** La dérivation lit la SOURCE ;
>   elle a immédiatement trouvé un appel indirect (`tts.${method}`) qui ajoutait trois
>   RPC invisibles. Les ~24 méthodes sans schéma vendoré sont désormais une liste
>   ÉNUMÉRÉE gardée dans les deux sens : une nouvelle y apparaît, une vendorisée en
>   sort. `usage.status` n'a aucun paramètre amont — inobservable par construction, pas
>   par oubli.
> - **Douze passes Codex, et la leçon est le type de faille.** Presque aucune ne
>   portait sur un comportement : elles portaient sur des **portes qui passent à vide**
>   — un regex qui cesse de matcher (cinq formes d'appel manquées d'affilée : littéral
>   non-guillemets-doubles, appel optionnel, appel générique, générique à parenthèses,
>   accès crochet, alias déstructuré sous trois formes), une liste de modules figée à
>   trois fichiers, une assertion par sous-chaîne qui accepte `|| true` / `echo tsc` /
>   `if: false`, un `paths-ignore` en bloc que le regex inline ne lisait pas, un
>   répertoire vendoré VIDE avec un manifeste vide qui satisfait tout. La réponse
>   structurelle n'est pas d'élargir le regex une sixième fois : c'est de rendre le
>   balayage **FAIL-CLOSED** — tout jeton `.request` doit être un appel reconnu ou une
>   non-référence DÉCLARÉE.
> - **Écart DÉCIDÉ, pas oublié** : le CI ne clone pas le tag amont pour vérifier les
>   hachés. Ce programme empêche des changements de protocole d'atterrir INAPERÇUS ; ce
>   n'est pas un contrôle anti-sabotage interne, et faire dépendre chaque PR de la
>   disponibilité GitHub d'une autre organisation est un mauvais échange. La
>   provenance rend l'affirmation **falsifiable** (le haché des octets amont bruts),
>   le script refuse un arbre sale, un remote qui n'est pas EXACTEMENT
>   `openclaw/openclaw`, et un tag local dont le commit n'est pas celui que
>   `git ls-remote` annonce ; la vendorisation est prouvée **reproductible à l'octet**,
>   donc une commande documentée suffit à vérifier.
>
> **G7 LIVRÉ (2026-07-26)** — décision produit après mesure : **gel au dernier profil
> validé + bannière visible**. L'option « refuser les capacités d'ÉCRITURE » a été
> proposée puis **rejetée**, et les raisons valent d'être gardées :
>
> - **zéro exposition** en production (les deux instances sont exactement à
>   `maxValidated`, `versionBeyondValidated: false`) ;
> - le « fail-open » n'existait quasiment pas dans le code : `beyond || (version >= min)`
>   est un **no-op** tant que tous les seuils sont ≤ `maxValidated`, ce qui est le cas —
>   c'est précisément pour ça qu'il est passé inaperçu. La vraie question n'était pas de
>   retirer une dérogation mais de décider ce qu'on accorde à une version jamais exercée ;
> - **le numéro de version est un mauvais indicateur de « contrat connu »** : sur un
>   gateway `2026.7.1` entièrement validé, le fil porte `agent.lastTo` **24 fois**, un
>   champ que ni notre build, ni le manifeste, **ni le schéma publié de l'amont** ne
>   déclarent (mesuré en prod le 26/07 — à scoper) ;
> - ces drapeaux gouvernent des **affordances d'UI**, pas la sûreté : les couper ferait
>   disparaître des fonctions chez un client qui vient de mettre à jour son gateway.
>   Pour le client, c'est un bug de plus, pas une précaution ;
> - `additionalProperties:false` **rejette bruyamment** un changement de forme ; le
>   scénario protégé (sémantique changée à nom constant) n'est étayé par rien.
>
> Si l'on restreint un jour, ce sera **sur preuve** (dérive observée sur la surface
> d'écriture, que le détecteur sait déjà nommer), jamais sur un numéro de version.
>
> Le gel est prouvé **live** : `maxValidated` abaissé à 2026.6.11 face au gateway
> 2026.7.1 ⇒ `cronManage` et `talk` (seuils au-dessus du plafond) résolvent **false**,
> tout ce qui est au-dessous reste **true**, `versionBeyondValidated: true` — et le
> snapshot Convex stocke exactement cela. Plafond restauré, l'état se referme.
> Les deux implémentations (bridge + miroir Convex) sont désormais **épinglées par une
> table d'attentes partagée** ; leur commentaire « EXACT MIRROR » ne vérifiait rien.
> La bannière est scopée à la cible du **PROCHAIN envoi** (comme `availNext`), pas à la
> liaison du chat, et cède le pas à toute condition bloquante.
>
> **G0 étendu + G2 LIVRÉS (lots 16-17, 2026-07-27)**
>
> - **La famille `sessions.*` est sous contrat** : `schema/sessions.ts` (40 schémas) et
>   `schema/plugins.ts` (8, import transitif) vendorés pour les deux versions, **48
>   schémas classés à la main**. La matrice passe de 94 à 199 entrées, les écarts
>   déclarés de 3 à 12. Le cliquet a immédiatement attrapé une vraie différence entre
>   versions (`SessionWorktreeInfo` et `SessionsCreateResult` n'existent qu'en 7.1) —
>   la diff entre manifestes EST la checklist de migration, comme prévu.
> - **La classification a trouvé un défaut réel**, ce qui est tout l'intérêt de
>   l'exercice : `fetchCompactionHistory` passait le `reason` du checkpoint **en clair**
>   vers `/api/v1/compaction-history` et l'obs MCP — une surface metadata-only. Il est
>   désormais bucketé, comme `timeoutPhase` et le refus de la garde d'envoi.
> - **G2, le cliquet SORTANT** : chaque corps de paramètres que le bridge envoie est
>   validé hors réseau contre le schéma TypeBox de CHAQUE version vendorée. Les corps
>   ne sont pas recopiés à la main — ils sont **capturés** en pilotant le vrai chemin
>   d'envoi avec le faux gateway. Prouvé : ajouter
>   `expectedSessionRoutingContract` à `chat.send` fait échouer 2026.6.11 et **passer**
>   2026.7.1, exactement la discrimination par version qui fait la valeur de la porte.
>   Les deux autres sites `chat.send` (`/subagent-send`, `/lossless`) ont vu leur corps
>   extrait en **fonctions pures exportées** pour être validables, pièces jointes
>   comprises.
> - **Le plancher est INATTEIGNABLE, et c'est dit** : `supportedRange.min` vaut
>   2026.5.19, or ce tag n'a **aucun** `packages/gateway-protocol` — le paquet de
>   schémas n'existait pas encore (vérifié en clonant le tag). Le contrat le plus ancien
>   vérifiable est donc le plus ancien VENDORÉ ; un champ que 6.11 accepte et que 5.19
>   aurait refusé reste invisible. Limite **assertée** dans le test pour qu'elle ne
>   puisse pas se transformer en fausse couverture.
> - **Un piège latent balayé** : tous les garde-fous écrits les 26-27/07 triaient les
>   versions avec un `.sort()` **lexical** — `2026.10.1` aurait précédé `2026.6.11`, et
>   « le plus ancien contrat » serait silencieusement devenu le plus récent le jour d'une
>   release d'octobre. Un helper unique utilise désormais le `compareVersions` du bridge.
>
> **G0 étendu — `cron.*` et `tasks.*` (lot 18, 2026-07-27)**
>
> - `schema/cron.ts` et `schema/tasks.ts` vendorés pour les deux versions : la matrice
>   passe de 199 à **363 entrées** (107 traitées / 241 ignorées / **15 écarts**),
>   111 schémas sous contrat. Les onglets Crons et Tâches, jusque-là entièrement hors
>   cliquet, sont désormais gardés dans les deux sens.
> - Trois écarts nouveaux et NOMMÉS : `CronJobState.consecutiveErrors` (l'UI affiche
>   « en erreur » sans dire depuis combien d'exécutions), `CronRunLogEntry.usage`
>   (le coût d'un cron n'entre jamais dans la jauge d'usage), `TaskSummary.progressSummary`
>   (une tâche longue n'a pas de progression lisible).
> - **La porte de périmètre était un échantillon.** `MUST_BE_ENUMERATED` listait les
>   méthodes couvertes à la main : ajouter un appel à une méthode dont le schéma est
>   DÉJÀ vendoré (p. ex. `cron.status`) ne touchait ni `uncovered()`, ni le snapshot,
>   ni la liste — la nouvelle méthode entrait sous contrat sans que personne relise sa
>   classification. La liste est maintenant assertée **ÉGALE** à l'ensemble couvert.
>   Prouvé rouge en ajoutant l'appel.
>
> **G3 — diff amont durci (lot 19, 2026-07-27)**
>
> - **Une seule base.** Le diff partait de `maxValidated`, le cliquet compare des
>   répertoires vendorés : deux points de départ pour la même question. Le diff part
>   désormais du **contrat vendoré le plus récent**, demandé au dépôt
>   (`bridge/scripts/vendored-versions.mjs`, qui réutilise `compareVersions` — pas un
>   second comparateur).
> - **La watchlist des schémas est DÉRIVÉE de `PROVENANCE.json`**, qui enregistre
>   maintenant le `upstreamPath` de chaque fichier vendoré. Elle nommait 3 modules
>   quand le bridge en vendorait 3 ; les lots 16-18 l'ont porté à 9 sans que personne
>   pense à ce fichier. Effet immédiat : le premier run durci a vu bouger `agent.ts`,
>   `sessions.ts` et `cron.ts` entre 6.11 et 7.1 — trois modules invisibles jusque-là.
> - **`report.json` + sortie non nulle.** Un contrat qui bouge, une ancre qui tombe,
>   une surface amont nouvelle : le script sort 1 (`--report-only` pour l'exploratoire).
> - **La porte EN DÉPÔT** (`bridge/test/upstream-reference.test.ts`) : le tag des
>   fixtures rejouées, celui du document de comparaison et `maxValidated` doivent être
>   la MÊME version. Monter le plafond sans ré-extraire passe rouge en nommant les
>   deux fichiers. Le `upstreamPath` enregistré remplace aussi la **devinette** entre
>   deux emplacements possibles dans le test d'intégrité.
> - **Limite DÉCIDÉE et écrite** : ce test attrape un plafond monté *sans avoir
>   remarqué* les fixtures et le doc — la panne réelle. Il ne peut pas prouver la
>   ré-extraction : le prouver demande le tag, et le CI ne clone pas le GitHub d'une
>   autre organisation à chaque PR (décidé au lot 14). Un artefact « j'ai lancé le
>   diff » commité ne changerait rien : c'est une chaîne de plus à taper. La preuve
>   mécanique vit dans le script, là où le tag est disponible.
> - Une affirmation fausse corrigée au passage : le doc décrivait encore le détecteur
>   de dérive comme vendoré en `2026.6.11`. Le test refuse maintenant **aussi** que
>   `DRIFT_VENDORED_VERSION` s'écarte de `maxValidated`, sinon code et doc pouvaient
>   régresser ensemble en restant « cohérents ».
>
> **G0 étendu — `config.*`, `agents.*`, `models.list` (lot 20, 2026-07-27)**
>
> `schema/config.ts` et `schema/agents-models-skills.ts` vendorés : **475 entrées**
> classées (134 traitées / 326 ignorées / 15 écarts), 187 schémas. Le cliquet a
> immédiatement nommé une différence entre versions (`AgentSummary.workspaceGit` et les
> quatre `SkillsCurator*` n'existent qu'en 7.1).
>
> Le classement a trouvé **six défauts réels**, tous corrigés dans le lot, chacun prouvé
> par neutralisation — c'est le meilleur argument pour l'exercice :
>
> 1. **`ModelChoice.available` était jeté** : le sélecteur proposait tout modèle renvoyé,
>    y compris ceux que le gateway déclare indisponibles. L'utilisateur l'apprenait d'un
>    tour échoué au lieu d'une option absente. Filtré sur `=== false` (pas `!== true` :
>    le champ est optionnel amont, un garde ne doit pas coûter un choix qui marchait).
> 2. **`config.patch` partait SANS sa garde OCC** quand la lecture ne portait pas de
>    haché. **Correction après vérification du gateway DÉPLOYÉ** — ma première note
>    affirmait que le patch était alors appliqué inconditionnellement : c'est faux.
>    `requireConfigBaseHash` le REJETTE dès que le fichier de config existe, donc
>    l'omission achetait un `INVALID_REQUEST` confus. Le bridge refuse désormais
>    localement, avec **exactement la même exception que le gateway** : si le snapshot
>    dit `exists: false`, il n'y a aucune édition concurrente à perdre et le patch part
>    sans haché — sinon le garde coûterait une écriture de première installation qui
>    aurait réussi. Un haché VIDE compte comme absent (le schéma dit `NonEmptyString`,
>    et l'amont `trim()` la valeur).
> 3. **L'historique des révisions de fichiers d'agent enregistrait le contenu DEMANDÉ**
>    comme état d'après. Un gateway qui acquitte sans appliquer laissait une révision
>    affirmant un contenu qui n'a jamais existé. Le bridge renvoie sa relecture, et la
>    ligne dit si l'état d'après est **confirmé**, **inconfirmable** ou **absent** —
>    trois faits distincts.
> 4. **Deux écrivains de la même ligne, un seul agissait** : l'approbation de curation
>    se marquait « appliquée » (ce qui PURGE la proposition) sans consulter la
>    relecture ; l'éditeur, lui, répondait « enregistré » puis rechargeait l'ancien
>    contenu. Une dérivation unique (`afterStateFromSetResponse` + `writeLanded`), et un
>    balayage fail-closed sur TOUT `convex/` qui exige que chaque écrivain la consulte.
> 5. **Un fichier qui EXISTE mais qu'on n'a pas su lire** était présenté comme vide et
>    créable : sauvegarder par-dessus détruisait le contenu réel sous une CAS qui passe.
>    Refus 502 `UNREADABLE` sur la lecture ET l'écriture, sur **les deux providers**.
> 6. **Côté Hermes la garantie était entièrement à vide** : la réponse ne portait aucune
>    confirmation et affirmait `missing: false` quoi qu'il arrive. En plus, une réponse
>    200 malformée devenait `content: ""` — indiscernable d'un fichier vide — parce que
>    `Buffer.from` accepte du base64 invalide en silence et que `toString("utf8")`
>    remplace les octets illisibles par U+FFFD. Le lecteur valide maintenant le payload
>    et refuse un décodage **lossy** par aller-retour d'octets.
>
> Quatorze passes Codex. Comme aux lots précédents, la majorité des trouvailles portaient
> sur des **gardes qui passent à vide** : un balayage qui ne lisait que deux fichiers
> nommés, une extraction par regex ancrée sur l'indentation (elle comptait des appels
> qu'elle n'inspectait pas), une liste blanche d'orthographes qui cassait sur du code
> correct, et un compte d'appels que la **déclaration** de la fonction satisfaisait
> gratuitement.
>
> **G0 TERMINÉ — `channels.ts` / `talk.*` (lot 21, 2026-07-27)**
>
> Dernière famille RPC atteignable vendorisée. La surface passe à **596 entrées**
> (158 traitées / 420 ignorées / **18 écarts**). Toutes les familles que le bridge
> appelle sont sous contrat ; ce qui reste non couvert l'est **par construction**
> (`sessions.get`, `usage.status`, les trois `tts.*` — l'amont ne publie aucun schéma de
> paramètres). Le commentaire du périmètre le dit désormais pour qu'on ne lise pas cette
> liste comme un reste à faire.
>
> Deux défauts de cliquet trouvés sur mes propres portes, et ils valent plus que la
> vendorisation :
>
> - **`usage.status` échappait entièrement au cliquet.** Son espace de noms était mappé à
>   `null` (« pas de paramètres ») et `uncovered()` renvoyait « couvert » pour ce cas :
>   la méthode n'était donc ni dans la liste des non couvertes ni dans l'ensemble énuméré.
>   Invisible. Et le mapping `null` était lui-même une **affirmation infalsifiable** :
>   un test échoue maintenant si un module vendoré exporte le schéma de paramètres d'une
>   méthode déclarée sans paramètres.
> - **Un verdict « schéma entier » sautait le contrôle des champs**, et ma première
>   correction était **vide sur les unions** (`topLevelFields` ne lisait que
>   `properties`). Rendue consciente des unions, elle a fait tomber **six verdicts globaux
>   hérités des lots 18-20** — c'est ainsi que les ajouts 7.1 `CronSchedule.command`/`cwd`
>   et `CronPayload.toolsAllowIsDefault` sont devenus visibles. L'exemption des schémas
>   entièrement `ignored` est **conservée délibérément** (un schéma que personne ne lit ne
>   change rien en gagnant un champ) ; ce qui était faux, c'est de décrire le cliquet
>   comme « chaque nouveau champ est trié ». La limite est écrite dans le code.
>
> **Onze passes Codex, et un schéma d'erreur qui s'est répété trois fois** : une
> justification qui affirme une **sémantique serveur** que le dépôt n'établit pas
> (`baseHash` au lot 20, puis `sessionKey`, puis `idempotencyKey`). Règle retenue : une
> classification décrit ce que fait Atrium et ce que dit le schéma — jamais ce que fait le
> gateway, sauf lecture du dist déployé. Deux écarts nouveaux et user-facing en sont
> sortis : `TalkClientCreateResult.expiresAt` (personne ne lit la date d'expiration du
> credential, l'utilisateur l'apprend d'un 401) et `offerHeaders`, qui était classé
> `ignored` alors que sa propre note admettait que le handshake casserait — une
> justification qui nomme une casse est un **écart**.
>
> **W10 TERMINÉE — cliquet SORTANT sur toutes les voies (lot 22, 2026-07-27)**
>
> G2 ne validait que `chat.send`. Il valide désormais **26 méthodes**, avec quatre
> mécanismes de capture choisis selon ce que le code permettait déjà : le chemin d'envoi
> par le faux gateway ; les voies opérateur et `cron.*` par un requester **enregistreur**
> (leurs handlers prenaient déjà une connexion — zéro changement de production) ; les corps
> construits dans un handler HTTP extraits en constructeurs purs dans un module **neutre**
> `src/core/rpc-params.ts` (neutre parce que `session.ts` en envoie et ne peut pas importer
> `server.ts` sans cycle) ; et un **balayage de la source** reliant chaque site d'appel à
> son constructeur.
>
> Ne restent hors capture que `sessions.reset` et `sessions.compact`, réellement en ligne
> dans le chemin de tour — que cette vague ne modifie pas pour la commodité d'un test.
>
> **Huit passes Codex, treize trouvailles, UNE seule forme de défaut** : un garde qui
> inspecte un **échantillon** là où le contrat porte sur un **ensemble**. Dans l'ordre :
>
> 1. des méthodes simplement non capturées (`chat.abort`, `agents.list`, `models.list`,
>    puis `sessions.get`, les trois `tts.*`, `sessions.compaction.list`) pendant que
>    l'en-tête proclamait la complétude — **deux fois** ;
> 2. `sessions.compaction.list` rangé dans mes « absences déclarées » sans vérification :
>    `fetchCompactionHistory` n'est pas sur le chemin de tour. *Une absence déclarée par
>    habitude reste une absence que personne n'a vérifiée.* ;
> 3. une liste `checked` de quatre méthodes nommées — un échantillon, devenu un ensemble ;
> 4. le chemin d'envoi gardant sa **propre** boucle de validation, plus laxiste que celle
>    des voies opérateur : un schéma renommé y restait vert. Une seule règle désormais ;
> 5. des **variantes** d'une même méthode invisibles derrière une égalité de noms
>    (branches `cron.update`, `config.patch` sans haché, `talk.client.create` à un seul
>    optionnel, patches d'UNSET) — assertées maintenant par **ensembles de clés** ;
> 6. les constructeurs non reliés à leurs sites d'appel : un handler réécrit en ligne
>    aurait expédié un corps invalide pendant que le cliquet validait une fonction que
>    personne n'appelle ;
> 7. le site indirect inspecté par `.find()` — un seul sur plusieurs ; puis la regex
>    acceptant **n'importe quel** `*Params(` au lieu du bon.
>
> Leçon à garder : *quand un garde tombe six fois de la même manière, ce ne sont pas six
> oublis, c'est une granularité fausse.* Chacune de mes corrections traitait l'instance ;
> la forme revenait au tour suivant.
>
> Un faux positif instructif au passage : mon lecteur d'argument calculait l'offset du
> second argument depuis la longueur du premier **trimmé**, donc il atterrissait dans le
> premier dès qu'un retour à la ligne suivait `.request(`. Il a fait échouer une assertion
> **sur du code correct** — le même défaut aurait, dans l'autre sens, fait passer du code
> cassé.


**Lacunes** : G-59, G-60, G-61, G-62, G-73, G-74.
**Objectif observable** : une version de gateway ne peut plus entrer dans le
support sans qu'une machine ait présenté à un humain **chaque** changement de
contrat ; et un gateway au-delà du validé n'ouvre plus de capacités jamais
éprouvées.

**Pourquoi c'est nécessaire à la 1.0.0** : « zéro régression possible » est
l'exigence même de la 1.0.0, et aujourd'hui le seul gate bloquant est un banc
manuel. Cinq additions de contrat 7.1 sont passées sans contrôle, 15 des 20 RPC
appelées n'ont aucun garde-fou, et la politique au-delà de `maxValidated` est
**fail-open** dans le scénario opérationnel documenté par le dépôt lui-même.

**Contenu**
1. **G0 — Vendorisation obligatoire** : `bridge/scripts/vendor-protocol.mjs
   <version>` (clone shallow du tag, copie des modules, réécriture des imports,
   `PROVENANCE.json` avec SHA amont + sha256 par fichier). Périmètre **dérivé
   mécaniquement** des méthodes RPC réellement appelées — un test énumère les
   `conn.request` du bridge et **ÉCHOUE** si l'une n'est couverte par aucun module
   vendored classé. Départ : `logs-chat`, `agent`, `primitives`, **`frames`**
   (l'enveloppe, donc `seq` — prérequis du ratchet de W3), `sessions`, `cron`,
   `tasks`, `config`, `error-codes`, `snapshot`, `agents-models-skills` (restreint
   à `models.list`).
   Gates : `vendor-integrity.test.ts` recalcule les sha256 et **refuse** un
   répertoire édité à la main ; un test **refuse** que `maxValidated` désigne une
   version sans répertoire vendored.
2. **G1 — Ratchet multi-version** : `protocol-coverage.test.ts` boucle sur **tous**
   les répertoires de `bridge/protocol/openclaw/` (aujourd'hui version en dur
   `:23-27`) ; `coverage.json` devient `coverage/<version>.json`. La logique de
   refus d'orphelin existe déjà (`:94-144`) — il suffit de la nourrir. Le diff
   `coverage/<ancienne>.json → coverage/<nouvelle>.json` **EST** la checklist de
   migration (intention originelle, `docs/design/protocol-contract.md:65`).
3. **G2 — Ratchet SORTANT** (la porte la plus rentable en risque évité) : un test
   **hors réseau** valide chaque corps de paramètres construit par le bridge contre
   le schéma TypeBox vendored du **PLANCHER** et de `maxValidated` (les schémas
   TypeBox **sont** du JSON Schema ; `additionalProperties:false` fait le travail).
   ROUGE si le bridge émet un champ que le plancher rejette ⇒ soit relever le
   plancher, soit gater le champ par version comme le fait l'amont
   (`$UP/src/tui/gateway-chat.ts:237-247`).
4. **G7 — Fin du fail-open** : changer la politique de `resolveCapabilities`
   au-delà de `maxValidated`. Deux modes, **à trancher avec l'utilisateur** :
   (i) gel au dernier profil validé + bannière opérateur ; (ii) refus des capacités
   à risque en **écriture** (`knob*`, `configDefaults`, `cronManage`,
   `sessionCompact`) en conservant les lectures. Dans les deux cas,
   `versionBeyondValidated` doit remonter jusqu'à une **bannière visible**, pas
   seulement le badge admin.
5. **G3 — Diff amont durci** : base = la version **vendored** (et non
   `maxValidated`, ce qui supprime les deux points de départ divergents), watchlist
   étendue aux modules cron/sessions/tasks/config, sortie **machine**
   (`report.json`). Une zone CHANGED ou une ancre FAILED **bloque** tant que
   `docs/design/upstream-interpretation-comparison.md` n'a pas été mis à jour ET
   qu'un scénario de `openclaw_upstream_frames.json` de la zone n'a pas été
   **ré-extrait** (le test vérifie que `upstream_tag` == la version cible).
6. **Honnêteté documentaire** (G-74) — **FAIT** : les trois affirmations portent leur
   correction datée (26/07, puis lot 47 le 30/07 pour la section Hermes), laissée en
   place plutôt que réécrite. Détail de ce qui était faux : corriger `protocol-schema-coverage.md:264-268`
   (la justification « ordered WS » est falsifiée par
   `$UP/src/gateway/server-broadcast.ts:174-179`), `protocol-drift.ts:20-24`
   (« exactly one addition » est faux) et la section Hermes
   `protocol-schema-coverage.md:299-311`.

**Risque de régression et confinement** : le lot est **presque entièrement en
CI/scripts** — risque de production quasi nul. Deux exceptions : (a) le changement
de politique fail-open (4) est un changement **visible** qui peut retirer des
capacités à un client sur un gateway récent — d'où l'exigence d'une bannière et
d'une décision produit explicite ; (b) G0 va rendre le CI **ROUGE** jusqu'à
classification humaine des 5 champs 7.1 + de tous les schémas nouvellement
vendorés : c'est le résultat attendu, pas une panne, mais cela doit être planifié
(travail de classification, non de code).

**Vérification**
- Après vendorisation de 2026.7.1, `protocol-coverage.test.ts` passe **ROUGE** en
  listant exactement `ChatHistoryParams.offset`,
  `ChatSendParams.expectedSessionRoutingContract`,
  `ChatAbortParams.preserveSideRuns`, `ChatAbortedEvent.errorMessage`,
  `AgentParams.cwd` ; puis VERT après classification.
- Supprimer à la main une ligne d'un fichier vendored ⇒ `vendor-integrity.test.ts`
  **ÉCHOUE**. Porter `maxValidated` à une version sans répertoire vendored ⇒
  `compat.test.ts` **ÉCHOUE**.
- Ajouter volontairement `expectedSessionRoutingContract` au corps de `chat.send`
  ⇒ le test G2 passe **ROUGE** en **nommant** la version plancher `2026.5.19` ;
  avec un gating par version, VERT + matrice méthode×version produite.
- Ajouter un appel RPC vers un module non vendored ⇒ le test de dérivation de
  périmètre **ÉCHOUE**.
- Table de vérité `compat.test.ts` : pour une version > `maxValidated`, les
  capacités d'écriture sont `false` (ou figées au profil validé) ; test frontend
  assertant la présence de la bannière quand `versionBeyondValidated === true`.

---

### W11 — Preuve de validation : corpus doré, banc signé, lockstep réel — effort L

> **G4 LIVRÉ — lot 24 (2026-07-28).** Le corpus doré rejouable existe ; G6 (banc signé)
> et G8 (lockstep bidirectionnel) restent. Leçon du 26-27/07 intégrée : le harnais
> enregistre les conditions d'hôte par scénario, après une journée où un même scénario a
> rendu GO et NO-GO sur du code identique.
>
> **Livré (G4)**
> - **9 captures réelles** promues d'un run GO 11/11 vers
>   `bridge/test/fixtures/golden/2026.7.1/`, rejouées en CI **à travers toute la pile de
>   lecture** (normalizer → run manager → turn sink), sans gateway ni modèle. Ce qui est
>   figé est l'INTERPRÉTATION — les écritures que Convex recevrait — pas les trames.
> - **Le point d'acceptation du programme est tenu** : casser la fusion announce, l'ack
>   async ou la carte Plan rougit le rejeu. Deux lectures de plus sont couvertes et
>   prouvées de la même façon : la livraison média et le RÈGLEMENT de la tâche de fond
>   (`task:running` → `task:done`).
> - **Anonymiseur en liste blanche** : discriminants verbatim, identifiants pseudonymisés
>   par GRAMMAIRE (clé de session, familles de runs, UUID, chemins média), texte masqué
>   par caractère. Vocabulaire des clés dérivé des DEUX artefacts vendorés (manifeste de
>   couverture + instantané de session du lot 23) ; les tables de contrôle sont assertées
>   contre la source du normalizer par un test, pas recopiées.
> - **Horodatage de réception** ajouté à la capture (`{receivedAt, frame}`) : sans lui le
>   corpus naît aveugle aux quatre seuils temporels. Toutes les dates sont REBASÉES sur
>   l'origine de la capture — aucun horodatage absolu ne subsiste.
> - **Garde de FIDÉLITÉ à la promotion** : la tranche brute et sa forme promue sont
>   rejouées et comparées (appels, formes de cartes, ORDRE) ; une divergence REFUSE la
>   promotion. Elle a trouvé, dès son premier passage, trois défauts que quatorze passes
>   de revue avaient manqués. Elle refuse aussi un build absent ou plus vieux que ses
>   sources.
>
> **G6 LIVRÉ — lot 25 (2026-07-28).** `validatedVersions` cesse d'être une phrase qu'on
> édite : `maxValidated` et toute version ajoutée désormais doivent porter un
> `bridge/protocol/openclaw/<version>/BENCH.json` écrit par le banc sur un GO du catalogue
> complet, et `bench-attestation.test.ts` refuse la revendication sinon.
>
> - **Ce n'est PAS une signature**, et le programme avait tort de l'appeler ainsi : la même
>   main lance le banc, écrit le fichier et fait le commit. Ce qui est vérifié est la
>   COHÉRENCE — et le seul point qui porte, `vendoredSha256`, ne porte que parce que le
>   test **recalcule** le haché depuis le répertoire au lieu de croire le nombre du
>   fichier (le piège du haché auto-attesté du lot 14).
> - **Six versions antérieures sont exemptées, explicitement et datées.** Les rejouer
>   aujourd'hui ne dirait pas si la validation était vraie quand elle a été faite. Ce qui
>   compte est que l'exemption soit finie : elle est **gelée en double** (manifeste + test),
>   ne peut contenir aucune version ≥ `maxValidated`, et l'élargir rougit trois assertions.
>   La première version de cette garde était TAUTOLOGIQUE (l'ensemble appliqué est
>   l'ensemble revendiqué moins l'exemption) — trouvé en revue.
> - Le commit attesté doit être **ancêtre de HEAD**, pas seulement un objet qui existe ; en
>   clone superficiel (le cas du CI) la garde distingue « ne peut pas savoir » de « n'existe
>   pas », à voix haute.
> - Une version attestée doit avoir un **corpus** : sans lui, `scenarios: []` satisfaisait
>   « le catalogue couvre le corpus » — un GO déclaré sur rien.
>
> **G8 LIVRÉ — lot 26 (2026-07-28). W11 EST TERMINÉE.**
>
> - **La formulation « ÉGALITÉ d'ensembles front ⟷ manifeste » était imprécise.** Prise à
>   la lettre, elle aurait forcé `abort`, `agentsDiscovery`, `mediaOutbound` et
>   `messageToolRecovery` dans une liste documentée comme « les clés que cette UI
>   consomme » — la liste aurait menti. Ce qui est livré est une PARTITION : consommé, plus
>   explicitement-non-consommé-avec-sa-raison, et c'est leur UNION qui doit égaler le
>   manifeste. Une clé renommée n'appartient alors à aucune moitié.
> - **Le cas discriminant a validé la forme** : la partition laissait exactement dehors
>   `cronList` et `cronManage`, consommées depuis Convex PAR CHAÎNE BRUTE. Elles passent
>   par la porte typée, et un test-lint interdit qu'une clé du contrat soit épelée
>   ailleurs — recentré sur les clés du contrat après avoir signalé un `CronCaps` homonyme.
> - **Un DÉFAUT DE PRODUCTION antérieur découvert en chemin** (revue) :
>   `buildCapabilityTargets` recevait un `provider` et ne s'en servait que pour la cible
>   synthétique. Une instance Hermes avec session ACTIVE était résolue contre la fenêtre
>   OpenClaw — toutes capacités éteintes, panneaux fermés sur un gateway supporté. La
>   surcharge de transport, qui ne vivait que dans la branche sans session, est factorisée.
> - **Corrections de manifeste, vérifiées jusqu'au code** : `agentFiles` et `mediaOutbound`
>   passent dans la surface Hermes INDÉPENDANTE DU TRANSPORT (`/agent-files` route sur le
>   `kind`, via l'API HTTP managed-files, explicitement « no operator socket »).
> - **La fixture n'est plus collée à la main** : `scripts/refresh-capabilities-fixture.mjs`
>   la capture depuis un bridge vivant et REFUSE de capturer depuis un processus dont le
>   manifeste diffère de celui que le checkout compile — entrées entières comparées, car
>   les noms seuls laissaient passer un plancher de version modifié.
>
> **Décidé de ne PAS faire** : ajouter `announce-queue-race` et un scénario `talk` au
> catalogue (report du lot 25). Les intégrer change le catalogue attendu, donc exige un
> nouveau run producteur — à faire dans le lot qui les écrit.
>
> **Limites assumées** : le rejeu s'arrête au run manager, donc l'observateur de
> sous-agents (`session.ts`) n'est pas exercé — la garde de fidélité ne peut pas voir une
> régression qui n'existe qu'à ce niveau. Les scénarios Hermes ne sont pas promus : la
> capture appartient à la connexion OpenClaw seule.

> **Lot 27 (2026-07-28) — l'assertion de fusion cessait d'être vraie, et l'attestation
> pouvait rétrécir.** Pas une lacune du registre : le `NO-GO 10/11` de la fin du lot 26.
>
> - **Le banc COMPTAIT les runs announce fusionnés (`>= N`), et ce compte était faux.**
>   Avec trois enfants, le parent n'a légitimement RIEN à dire quand B se termine pendant
>   que C tourne encore : il émet un announce NO_REPLY, que le bridge jette PAR CONCEPTION
>   (`turn-sink.applyDeferred`). Deux captures de forme identique le prouvent : celle qui
>   passait ne fusionnait 3 que parce que son announce du milieu avait appelé
>   `sessions_yield` ; celle qui échouait n'avait **rien perdu** (PAR_B_OK dans le run
>   propre de l'enfant, les trois enfants ancrés à la bulle racine, conversation close sur
>   PARALLEL_DONE) et était pourtant classée « régression de chaîne, jamais réessayable ».
>   L'invariant est désormais **unidirectionnel** : tout announce à qui le bridge DOIT une
>   bulle (texte utile, final en erreur, carte d'outil au-delà de son `start`) doit être
>   fusionné ; fusionner davantage n'est jamais une violation. Il tient toujours sur
>   la mesure du lot 13 (deux announces sur trois non fusionnés **et** enfants ancrés au
>   mauvais message : les deux moitiés restent assertées).
> - **Le prédicat « texte seul » a d'abord été choisi pour ne pas recopier `eventIsVisible`
>   — et la revue Codex a montré que c'était le mauvais côté de l'asymétrie.** Un announce
>   dont la seule sortie est une carte d'outil, s'il était jeté, se lisait comme un silence
>   choisi, donc **réessayable** : un second essai chanceux aurait pu produire une
>   attestation GO par-dessus une perte réelle. Un signal ajouté ne peut qu'EXIGER plus de
>   fusions (une dérive rougit), un signal omis en excuse (une dérive verdit). `owed` couvre
>   donc texte utile (sentinelle `NO_REPLY` exclue comme en amont), final en état `error`, et
>   item outil/commande au-delà de `start` — la règle exacte du bridge. Média et plan restent
>   dehors, et c'est écrit.
> - **L'attestation pouvait être remplacée par une plus faible.** Le producteur
>   enregistrait honnêtement les drapeaux d'un run restreint… puis écrivait quand même.
>   C'est arrivé : un `--scenario spawn-parallel-merge --skip-hermes` a écrasé le GO
>   complet de 2026.7.1, a été commité (`2989380`), et **la porte est restée rouge à HEAD**
>   — le test faisait son travail, mais la bonne attestation était déjà perdue. Un run
>   restreint n'écrit plus rien, comme un NO-GO.
> - **La boucle Codex a convergé en 10 passes, et chaque passe a trouvé un vrai défaut de
>   la CORRECTION, pas du lot d'origine.** Motif commun : à chaque fois qu'un côté était
>   corrélé, l'autre restait ouvert — announces non corrélés aux enfants du scénario,
>   carte d'outil perdue classée réessayable, identifiant FUSIONNÉ étranger satisfaisant
>   le plancher (fusion inter-tour rendue verte), corrélation par run observé rougissant
>   une réémission légitime, préconditions d'enfants court-circuitant l'intégrité,
>   concaténation des porteurs cassant la sentinelle. Réponse finale : **un seul audit
>   (`mergeAudit`) appelé par les trois voies**, et l'intégrité évaluée AVANT toute cause
>   de variance. Un constat a été REFUSÉ preuve à l'appui (aligner la sentinelle sur la
>   sémantique amont : le bridge compare exactement `"NO_REPLY"` à ses ~20 emplacements,
>   donc assouplir aurait fait diverger le banc du produit qu'il valide).
> - **Confirmation en conditions réelles** : un run du banc a rencontré la cause
>   nouvellement nommée « l'agent n'a jamais annoncé 1 de ses 3 enfants — variance LLM »,
>   a réessayé une fois et passé. Sous l'ancien code, ce même run était « régression de
>   chaîne, jamais réessayable » — un NO-GO faux.
> - **Le rejet silencieux ne disait pas QUI se taisait.** Un `console.log` nu a coûté une
>   session de diagnostic ; il porte maintenant le run, le nombre d'événements tamponnés
>   jetés avec lui et le terminal. Jamais une anomalie, jamais une bulle : le cas est la
>   règle, pas la panne.

**Lacunes** : G-63, G-64, G-65.
**Dépend de** : W10 (le corpus doré et le `BENCH.json` se rangent **dans** le
répertoire vendored par version, qui n'existe qu'après G0).
**Objectif observable** : `validatedVersions` cesse d'être une phrase qu'on édite ;
les 6 features couvertes par le seul banc manuel obtiennent un test qui échoue en
CI ; un renommage de capacité côté bridge ne peut plus faire disparaître un onglet
en silence.

**Contenu**
1. **G4 — Corpus doré rejouable** : le banc capture **déjà** `frames.jsonl`
   (`run-live-bench.mjs:20-22`, `OPENCLAW_CAPTURE_FRAMES`) et les jette dans
   `bench-runs/`. Les **promouvoir** via `promote-capture.mjs` qui anonymise
   (SOC2 : noms de champs + texte **synthétique**) vers
   `bridge/test/fixtures/golden/<version>/<scenario>.jsonl` ; puis
   `golden-replay.test.ts` rejoue **tout** le corpus (toutes versions) dans le
   normalizer et compare les `BridgeEvent[]` à un snapshot versionné. Une nouvelle
   version qui change l'interprétation d'une **ancienne** capture = ROUGE.
   Faire tourner `protocolDrift.observe()` sur ce corpus en CI et exiger drift = 0
   (en prod il reste observe-only, `docs/design/protocol-contract.md:78`).
2. **G6 — Banc signé** : `run-live-bench.mjs` écrit un condensé signé dans
   `bridge/protocol/openclaw/<version>/BENCH.json` (verdict, version gateway, SHA
   du commit Atrium, sha256 du répertoire vendored, liste **exhaustive** des
   scénarios joués, horodatage). `compat.test.ts` **refuse** toute entrée de
   `validatedVersions` sans `BENCH.json` avec `verdict === "GO"`, catalogue complet
   (pas de `--skip-image` silencieux) et `atriumSha` appartenant à l'historique git.
   Ajouter au catalogue `announce-queue-race.mjs` (aujourd'hui hors suite) et un
   scénario `talk` dérivé de `probe-talk.mjs`.
3. **G8 — Lockstep bidirectionnel** : supprimer la fixture éditée à la main
   (`src/chat/bridgeCapabilitiesFixture.ts`) et la **régénérer** depuis le bridge
   vivant à chaque run de banc ; passer `capabilities.test.ts` d'une **inclusion**
   à une **ÉGALITÉ** d'ensembles front ⟷ manifeste ; ajouter un test-lint
   interdisant tout accès `capabilities.<clé>` par chaîne brute hors
   `capabilityOf` (ce qui rattrape `convex/scheduled.ts:96-97`). Compléter le
   manifeste : `mediaOutbound` (implémenté et non déclaré côté Hermes),
   `agentFiles` (déclaré WS-only alors qu'il passe par HTTP donc marche en REST),
   et aligner le manifeste statique sur la surcharge runtime
   (`bridge/src/server.ts:1710-1723`).

**Risque de régression et confinement** : uniquement CI et outillage — aucun code
de production. Le risque est la **fragilité de snapshot** : un corpus doré trop
littéral produirait des ROUGE de bruit à chaque évolution volontaire. Confinement :
comparer les `BridgeEvent[]` **normalisés** (pas les trames), et traiter tout ROUGE
comme une question (« ai-je voulu changer cette interprétation ? »), avec mise à
jour explicite du snapshot dans le même commit que le changement d'interprétation.

**Vérification**
- Casser volontairement la fusion announce dans le normalizer ⇒
  `golden-replay.test.ts` **ROUGE** en CI, **sans** gateway ni modèle. Idem pour
  l'ack async et la carte Plan.
- Ajouter une version fictive à `validatedVersions` sans `BENCH.json` ⇒
  `compat.test.ts` **ROUGE** ; `BENCH.json` avec `verdict: "NO-GO"` ou catalogue
  incomplet ⇒ **ROUGE** aussi.
- Ajouter une clé bidon à `OPENCLAW_CAPABILITIES` ⇒ `capabilities.test.ts`
  **ROUGE**. Renommer `cronManage` côté bridge ⇒ **ROUGE** (aujourd'hui : VERT).
  Réintroduire un accès brut `capabilities.foo` ⇒ test-lint **ROUGE**.

---

### W12 — Conscience de version Hermes — effort M

> **NON LIVRÉ — reporté SCIEMMENT** (même raison que W6).

**Lacunes** : G-55, G-56, G-57, G-58.
**Objectif observable** : Atrium sait **à quelle version de Hermes il parle**, et
n'échoue plus ouvert quand cette version dépasse le validé ou change de schéma de
numérotation.

**Pourquoi c'est nécessaire à la 1.0.0** : aujourd'hui un Hermes 0.19.0, 0.25.0 ou
1.0.0 est traité exactement comme un 0.18.0 sur le transport par défaut — aucun
banner, aucune garde de capacité — alors que l'amont a **lui-même** bumpé son
contrat GUI↔backend de 2 à 4 et que son client officiel **refuse** un backend en
skew. Et le schéma de version a changé (`v2026.7.20` vs `0.19.0`), ce qui peut
faire basculer tout le gating Hermes en fail-open.

**Contenu**
1. Lire `payload.version` et `payload.release_date` dans le handler `session.info`
   et les propager comme `gatewayVersion` de l'instance, en mémorisant la dernière
   valeur vue **par instance** pour que le poll compat l'utilise même sans chat
   ouvert. **Ne pas** dépendre de `/api/status` en primaire (auth non prouvée en
   déploiement réel) : `session.info` est authentifié par construction.
   Une fois branché, le manifeste compat Hermes existant s'active **tel quel**.
2. Ajouter au manifeste un `contractRange: {min, maxValidated}` **distinct** de la
   version sémantique, alimenté par `info.desktop_contract` lu dans
   `session.create` / `session.resume` (disponible dès l'ouverture de session,
   avant tout événement). Politique : contrat inférieur au plancher ⇒ capacités au
   plancher + état visible ; supérieur au `maxValidated` ⇒ même traitement que
   `versionBeyondValidated`. **C'est le signal le plus fiable de la zone** parce
   que l'amont le bump lui-même sur rupture.
3. Trancher le schéma de version (G-57) : établir le mapping paquet ↔ tag daté et
   **refuser** de comparer deux espaces de numérotation incompatibles (un
   `parseVersion` qui accepte `2026.7.20` face à un `maxValidated` `0.18.2` produit
   « beyond » ⇒ toutes capacités à `true`). Fail-**closed** par défaut sur schéma
   inconnu.
4. Contrat Hermes vendored (G-58) : `bridge/protocol/hermes/<version>/` rempli par
   un générateur (~80 lignes Python) tournant sur un clone de tag, produisant
   `ws-events.json` (AST de tous les `_emit` + les `event_type` des
   `*_progress_callback`), `ws-rpc.json` (`@method` + codes `_err`),
   `sse-events.json`, `http-routes.json`, `contract.json`
   (`{desktop_backend_contract, hermes_version}`) et `coverage.json` (décision par
   nom : `consumed` | `ignored-intentional` | `GAP`). Le détecteur de drift =
   régénérer sur le nouveau tag, differ, **ÉCHOUER** si un nom apparaît sans
   décision ou si `desktop_backend_contract` bouge. Brancher dans la skill
   `add-gateway-version`. Ajouter un `protocol-drift` Hermes observe-only comptant
   les **noms** de champs inconnus (P3).

**Risque de régression et confinement** : brancher la version **active** un
manifeste aujourd'hui mort — donc des capacités peuvent **se fermer** là où elles
étaient ouvertes par accident. C'est le comportement voulu, mais il doit être
annoncé : la bannière « au-delà du validé » de W10 doit être livrée **avant ou
avec** ce lot, sinon un client verra des fonctions disparaître sans explication.

**Vérification**
- `session.info` contenant `{version:"0.19.0"}` ⇒ `reportSessionMeta` /
  version d'instance reçoit `"0.19.0"` ; le test **ÉCHOUE** si le champ n'est plus
  lu. `GET /health` du bridge ⇒ `targets[hermes].gatewayVersion` == la version du
  gateway lancé et `versionBeyondValidated === true` (0.19.0 > 0.18.2).
- `session.create` renvoyant `info.desktop_contract = 4` ⇒ attribut d'instance 4 ;
  `2` ⇒ 2 ; absent ⇒ `null` (pré-GUI).
- Générateur **reproductible** : deux exécutions sur `v2026.7.20` donnent des
  fichiers identiques (hash) ; sur `v2026.7.7.2` il reproduit **exactement** le
  delta établi par la zone 2 (SSE identique, WS +3 = `message.interim`, `reaction`,
  `tool.output_risk`, RPC +6/−1 `credits.view`, HTTP +1, contrat 2→4).
- CI : ajouter un faux nom d'événement au vendored courant sans décision ⇒ le
  détecteur **ÉCHOUE**. Régénérer sur les deux tags ⇒ le détecteur signale 2→4
  comme rupture à décider.

---

## 5. Quick wins — corrigeables immédiatement, sans architecture

Chacun est un correctif local, testable en isolation, sans nouvelle structure de
données ni nouveau flux. Ils peuvent être livrés **avant** leur lot d'appartenance,
ou groupés en une release corrective unique.

| # | Correctif | Lacune | Lot | Fichier(s) |
|---|---|---|---|---|
| Q1 | Étendre la garde `used > contextTokens ⇒ null` à `activeTokens` | G-01 | W1 | `src/chat/sessionKnobs.ts:122-126` |
| Q2 | `totalTokensFresh === false` ⇒ jauge indéterminée | G-03 | W1 | `bridge/src/server.ts:614-630` + `sessionKnobs` |
| Q3 | Corriger le commentaire mensonger `activeTokens` / `totalTokens` | G-01 | W1 | `convex/schema.ts:1068-1072` |
| Q4 | Retirer la mention `/reset` du libellé `context_length` (P4) | G-07 | W2 | `src/chat/runStatusView.ts:179` + i18n |
| Q5 | Allowlister les phases **terminales** de `tool` (`result`, `end`) — `update` devient keep-alive | G-19 | W5 | `normalizer.ts:1205-1242` |
| Q6 | `lifecycle phase:"finishing"` arme la grâce au lieu de 240 s de silence | G-20 | W5 | `normalizer.ts:1312-1392` |
| Q7 | Lire `data.completed` sur la compaction ⇒ marqueur `failed` | G-08 | W5 | `normalizer.ts:1297-1308` |
| Q8 | Branche `stream === "error"` + `reason:"seq gap"` ⇒ trace, jamais une erreur de tour | G-24 | W3 | `normalizer.ts:1052-1136` |
| Q9 | Garde d'époque explicite dans `recoverVisibleText` / `recoverDeliveredReply` | G-28 | W8 | `bridge/src/session.ts:872-899`, `run-manager.ts:708-716` |
| Q10 | `continue` + log au lieu de `return` quand `messageId === null` | G-32 | W8 | `turn-sink.ts:496-499` |
| Q11 | Passer `entry.now` au flush des announces | G-35 | W8 | `run-manager.ts:623-638` |
| Q12 | Dédup chat : ensemble borné (LRU 64) au lieu du slot scalaire | G-15 | W4 | `normalizer.ts:436`, `:880-883` |
| Q13 | `AbortController` + deadline sur `streamToUploadUrl` | G-31 | W8 | `bridge/src/convex-writer.ts` |
| Q14 | Log de troncature sur `deferredEvents` et les états intra-tour (P8) | G-34 | W8 | `turn-sink.ts:538`, `:551` |
| Q15 | Hermes : `status:"interrupted"` ⇒ `run.status "aborted"` | G-44 | W7 | `hermes/ws-turn.ts:625` |
| Q16 | Hermes : `approval.respond {deny}` (+ `session.interrupt`) **avant** le settle | G-39 | W6 | `hermes/ws-turn.ts:356-371` |
| Q17 | Hermes : remplacer l'appel mort `session.status` par `session.resume` pour le `cwd`, et rendre l'échec bruyant | G-48 | W7 | `hermes/ws-turn.ts:567-579` |
| Q18 | Hermes : promotion de prose `^Error:\s` dans le classifieur transitoire | G-42 | W6 | `hermes/normalizer.ts:51-57`, `ws-turn.ts:636-641` |
| Q19 | Hermes : flush des outils ouverts au terminal SSE + `tool.failed` reconnu | G-49 | W7 | `hermes/normalizer.ts:375-411`, `:66-87` |
| Q20 | Hermes : retirer/dégrader `abort` du jeu REST + cesser d'avaler le 404 | G-41 | W6 | `bridge/src/compat.ts:121-124`, `hermes/dispatch.ts:524-529` |
| Q21 | `compat.test.ts` refuse un `maxValidated` sans répertoire vendored | G-59 | W10 | `bridge/test/compat.test.ts` |
| Q22 | `capabilities.test.ts` : ÉGALITÉ d'ensembles au lieu de l'inclusion | G-64 | W11 | `src/chat/capabilities.test.ts:84-87` |
| Q23 | Politique fail-**closed** au-delà de `maxValidated` + bannière | G-62 | W10 | `bridge/src/compat.ts:310-316`, `src/chat/admin/compatView.ts:41` |
| Q24 **(FAIT — 26/07 puis lot 47)** | Corriger les trois affirmations fausses des docs de design | G-74 | W10 | `docs/design/protocol-schema-coverage.md:264-268`, `:299-311`, `protocol-drift.ts:20-24` |

**Note P7** : Q1-Q3, Q5-Q12, Q15-Q20 sont des **correctifs** (comportement faux →
comportement juste), donc éligibles à une release. Q8 et Q14 sont de
l'instrumentation et doivent voyager avec un correctif.

---

## 6. Ce qu'il ne faut PAS faire maintenant

Le sur-engineering est en lui-même un risque de régression. Chaque entrée dit
**pourquoi** l'attente est le bon choix, et **ce qui la débloquerait**.

| Sujet | Décision | Raison | Ce qui la débloquerait |
|---|---|---|---|
| **`sessions.messages.subscribe`** pour les runs non visibles Control UI (G-72) | **NE PAS FAIRE** | Effort L, une **surface de champs entière** à classer (`session.message` porte `messageId`/`messageSeq`/`senderIsOwner` + un snapshot de session distinct), et un risque de **doublons** sur les runs visibles (l'amont ne dédoublonne que `session.tool`, `$UP/…/server-chat.agent-events.test.ts:1797`). Aucune plainte prod sur des crons non streamés. | Un compteur W9 montrant que des tours réels arrivent par ce chemin, ou une demande produit explicite. |
| **Surface UI d'approbation + `exec.approval.resolve`** | **NE PAS FAIRE** ; W5 se limite à suspendre le budget et **nommer** l'attente | Un aller-retour d'approbation est un lot **produit** (qui décide ? avec quelle autorité ? quelle trace ?), pas un correctif de protocole. Inventer une approbation automatique serait dangereux. | Une décision produit sur l'autorité d'approbation, et la même chose côté Hermes (`approval.respond`) pour respecter P5. |
| **Ajouter `expectedSessionRoutingContract`, `preserveSideRuns`, `cwd`** aux params sortants | **NE PAS FAIRE avant W10/G2** | `additionalProperties:false` sur `ChatSendParams` : chaque `chat.send` échouerait en `INVALID_REQUEST` sur tout gateway < 7.1. C'est le trou de régression **le plus direct** du processus actuel — et `expectedSessionRoutingContract` est ironiquement le remède au mauvais routage. | La porte G2 (ratchet sortant contre le plancher) verte, puis un gating par version. |
| **Vendorer les 31 modules de schéma amont d'un coup** | **NE PAS FAIRE** | Le CI deviendrait ROUGE sur des centaines de champs à classer, dont la plupart concernent des surfaces qu'Atrium ne touche pas (terminal, devices, voicewake). Le travail de classification noierait le signal utile. | Dérivation **mécanique** depuis les 20 RPC appelées (W10/G0), puis élargissement à la demande. |
| **Estimateur de tokens côté Atrium comme source primaire de la jauge** | **NE PAS FAIRE comme source primaire** ; seulement comme **borne basse** affichée comme telle (« ≥ 210k / 272k »), et seulement après W1 | Le défaut actuel est un chiffre faux ; le remplacer par un **second** chiffre faux serait une régression déguisée. Un plancher honnête bat une valeur inventée. | W1 livré, puis la preuve que `contextBudgetStatus` reste vide sous LCM même après le levier opérateur. |
| **Mettre l'inventaire des formes dans la table `anomalies`** | **NE PAS FAIRE** | `reportAnomalyInternal` n'a **aucun** dédoublonnage et notifie les admins à chaque insertion (`convex/anomalies.ts:741-791`, `:780-788`) : des centaines de lignes ouvertes et autant de notifications. Une forme inconnue est un **inventaire**, pas un incident. | Rien — la décision est définitive : table dédiée + **une** anomalie de pont via `upsertDetectorAnomaly`. |
| **Rendre le drift de protocole bloquant en production** | **NE PAS FAIRE** | Une trame inconnue ne doit **jamais** casser un tour (`docs/design/protocol-contract.md:78`, invariant `protocol-drift.ts:6-7`). Le gating appartient à la CI, sur le corpus doré. | Rien — c'est un invariant permanent. |
| **Mettre le banc live en job CI** | **NE PAS FAIRE** | Il pilote un vrai modèle : non hermétique par construction (variance LLM gérée par retry classifié, `run-live-bench.mjs:325-339`). Un job CI non déterministe détruit la confiance dans le rouge. | Rien — W11 vérifie en CI la **preuve** (`BENCH.json`), pas l'exécution. |
| **Réécrire / optimiser le transport REST Hermes** | **NE PAS FAIRE avant de trancher son sort** | **Six** des quinze défauts Hermes lui sont propres (abort inopérant, pas d'usage/meta, pas de flush d'outils, contexte perdu après compaction, data-URL non bornées, pas de livraison de fichiers). Le **retirer** serait le correctif le moins coûteux et le plus sûr. | Une réponse à « le transport REST est-il encore utilisé en production ? » |
| **Traquer les data-URL 5 Mo en REST** (G-54) | **NE PAS FAIRE** avant de prouver l'effet | Seul le comportement amont est prouvé ; l'effet Convex (rejet ? troncature ?) n'a pas été exercé, et la sévérité réelle en dépend. Corriger à l'aveugle risquerait d'ajouter un chemin d'extraction média inutile. | Un banc live REST demandant une image via `MEDIA:`, avec mesure de la taille du texte reçu. |
| **Corriger `chat.side_result` avant de prouver son atteignabilité** (G-18) | **CAPTURER D'ABORD** | La branche amont exige `!agentRunStarted` (`$UP/…/chat.ts:4960`) : possiblement inatteignable depuis un `chat.send` Atrium. Écrire une part `side_result` non atteignable est du code mort à maintenir. | Une capture `BRIDGE_FRAME_DUMP=side_result` sur un tour commande réel. |
| **Petits défauts basse sévérité** : `oc-chat-seq-not-orderable`, `handledAnnounceRunIds` borné à 100, `subAgents.updatedAt`, rollups de sous-agents Hermes | **DOCUMENTER, pas re-architecturer** | Aucun n'a de symptôme utilisateur actif ; deux sont des garanties **mal documentées** plutôt que cassées (le vrai verrou est Convex). Les toucher, c'est du risque sans gain. | Absorbés dans W8 (doc + tests d'invariant) et W7 (rollups, effort S). |
| **Absorber les défauts de config gateway dans le code Atrium** | **NE PAS FAIRE — REMONTER** | Le timeout de 15 s de `before_prompt_build`, les injections `knowledge` hors sujet (~4k/tour) et la condensation LCM jamais exécutée (`10-registre-prod.md:61-70`) causent des symptômes qu'Atrium **encaisse** mais ne doit pas masquer : les masquer rendrait le diagnostic impossible et laisserait la cause intacte (P10). | Rien — c'est une frontière de conception. Atrium doit **mesurer et nommer**, l'opérateur doit corriger. |
| **Le comportement d'agent hors protocole** (mémo modifié au lieu du compte rendu, mail déjà parti — `10-registre-prod.md:54-59`) | **HORS PÉRIMÈTRE de ce programme** | C'est du briefing d'agent et de la validation d'actions à effet de bord, pas du protocole. Mais **à dire explicitement** : pour le client, « Atrium a fait n'importe quoi » — le programme technique seul ne récupérera pas la confiance. | Un lot séparé « validation des actions à effet de bord », à arbitrer avec l'utilisateur. |

---

## 7. Séquencement recommandé

Ordre par **impact utilisateur décroissant / risque croissant**, en respectant les
dépendances de sens.

```
Vague 1 (mesure honnête + quick wins, risque minimal)
  W1 jauge  ──►  W5 vocabulaire  ──►  W3 détection de perte
  + Q9/Q10/Q11/Q13 (extraits de W8, autonomes)

Vague 2 (les défauts qui font perdre du travail)
  W2 défense contexte (dép. W1)   ‖   W4 intégrité de la réponse
  + prérequis OPÉRATEUR : midTurnPrecheck, promptAuthority LCM

Vague 3 (parité Hermes — P5)
  W6 tours bornés   ──►  W7 contenu et session   ‖   W12 conscience de version

Vague 4 (le cœur des écritures — le plus risqué, à faire quand le reste est stable)
  W8 sérialisation et écritures

Vague 5 (empêcher la prochaine vague de défauts)
  W10 ratchet + fail-closed  ──►  W11 corpus doré + banc signé
  W9 auto-découverte (transverse ; voyage avec un lot correctif, P7)
```

Justifications d'ordre :
- **W1 avant W2** : armer une garde d'envoi sur une mesure fausse bloquerait des
  tours qui auraient réussi — le pire résultat possible.
- **W5 très tôt** : effort S, cinq mauvaises lectures prouvées par exécution, aucun
  changement de structure. Meilleur rapport valeur/risque du programme.
- **W3 avant W8** : W3 rend la perte **visible** ; W8 modifie le chemin d'écriture.
  Mesurer avant de toucher.
- **W8 en vague 4** : la chaîne d'application unique est au cœur du chemin
  d'écriture. Ses quick wins autonomes (Q9, Q10, Q11, Q13) peuvent et doivent
  partir bien avant.
- **W10 avant W11** : le corpus doré et `BENCH.json` se rangent dans le répertoire
  vendored par version, qui n'existe qu'après G0.
- **W12 avec ou après la bannière de W10** : sinon un client verrait des capacités
  Hermes disparaître sans explication.

**Indicateur de sortie du programme** (à mesurer sur 14 jours, trafic prod faible
donc chaque incident compte double — `10-registre-prod.md:9-12`) :
1. débordements de contexte terminaux / 1000 tours ⇒ 0 ;
2. nombre de défauts découverts **par une sonde ou un test** vs **par
   l'utilisateur** ⇒ inversion du ratio actuel (0 / 4) ;
3. `protocolShapes` avec `status: "new"` non triées ⇒ 0 après une semaine ;
4. `frame_gap` et `foreign_run_rejected` mesurés (valeur inconnue aujourd'hui — la
   mesure est elle-même le livrable).

---

## 8. Questions ouvertes à trancher (décisions, pas analyses)

Ces points **bloquent ou orientent** un lot. Ils demandent une décision de
l'utilisateur ou une lecture ciblée, pas une nouvelle reconnaissance.

### 8.1 Décisions produit

| # | Question | Lot concerné | Ce qui dépend de la réponse |
|---|---|---|---|
| D1 | ~~Au-delà de 95 % de remplissage : **bloquer** ou **envoyer quand même** ?~~ **TRANCHÉE (décision produit, 26/07) : bloquer et nommer la cause.** L'envoi ne part pas, le tour finalise immédiatement en `context_length_presend` sans dépense provider, et la carte porte deux actions câblées. Nuance ajoutée par le lot : le blocage n'exige pas seulement le seuil, il exige un refus **observé** de la compaction — un refus « pas maintenant », une réponse inconnue, une RPC en exception ou un budget insuffisant laissent tous partir l'envoi. | W2 | Livré au lot 13. |
| D2 | Au-delà de `maxValidated` : **(i)** gel au dernier profil validé + bannière, ou **(ii)** refus des capacités en **écriture** en gardant les lectures ? | W10 | La politique de `resolveCapabilities` et le contenu de la bannière. |
| D3 | **RÉPONDU PAR LA MESURE (2026-07-26)** : aucune instance Hermes en production (`/compat` → 2 instances, toutes `openclaw`), donc aucun usage prod du transport REST. — Le transport **REST Hermes** est-il encore utilisé en production, ou peut-il être **retiré** ? | W6, W7 | Six défauts propres au REST. Le retirer est le correctif le moins coûteux et le plus sûr. |
| D4 | `abort` REST : **retirer du manifeste + griser Stop**, ou obtenir en amont l'enregistrement du `run_id` SSE ? | W6 | Options exclusives. Dans les deux cas le 404 cesse d'être avalé. |
| D5 | Stocker la **valeur littérale** des discriminants (`event`/`stream`/`kind`) ou seulement leur hash ? | W9 | Recommandation : valeur **filtrée** par regex d'identifiant — sinon la restitution est inexploitable pour écrire un correctif. |
| D6 | Faut-il un **lot séparé** « validation des actions à effet de bord » (le mémo modifié / le mail déjà parti du 22/07) ? | hors programme | Sans lui, le programme technique seul ne récupérera pas la confiance client. |

### 8.2 À trancher par lecture ou capture ciblée

| # | Point NON PROUVÉ | Comment trancher |
|---|---|---|
| N1 | L'incident du 20/07 (179k affichés / >308k réels) est-il bien passé par la branche **cumulative** ? La branche existe (`$UP/src/agents/usage.ts:335`) mais qu'elle ait été empruntée n'est pas démontré. | Requêter `chat.gateway_pressure` de ce jour et comparer `postTotalTokens` à `postInputTokens + postOutputTokens` (incohérence ou dépassement de `contextTokens` = preuve). |
| N2 | Comportement exact du plugin **lossless-claw / LCM** : `promptAuthority`, `turnMaintenanceMode`, raisons de refus de `compact()`. Le plugin n'est **pas** dans le dépôt amont. | Lire le source du plugin, ou chercher `[context-overflow-precheck] skipped` dans les logs gateway et corréler via `classifyCompactionReason` sur `/api/v1/compaction-history`. |
| N3 | `display.busy_input_mode` réel des gateways clients (défaut amont `interrupt`) : l'ACK `steered` — le cas le plus destructeur de G-36 — est-il atteignable en production ? | Lire `$HE/hermes_cli/config.py` + `cli-config.yaml.example`. |
| N4 | Que se passe-t-il si **deux** bridges Atrium résument la **MÊME** `stored_session_id` ? `session["transport"]` est réassigné à chaque `prompt.submit` (`$HE/…/server.py:9404-9405`) : le second volerait le transport du premier. **Candidat sérieux** pour les « conflits de trames » rapportés. | Banc live à deux bridges sur la même session. |
| N5 | Ordre réel des trames `assistant` entre `phase:"commentary"` et la réponse sur un modèle à préambule (GPT-5) : le cas défavorable est-il observable ? | Capture `BRIDGE_FRAME_DUMP=commentary`. |
| N6 | `chat.side_result` est-il atteignable depuis un `chat.send` Atrium (branche `!agentRunStarted`) ? | Capture `BRIDGE_FRAME_DUMP=side_result` sur un tour commande. |
| N7 | Le code de fermeture `1008 "slow consumer"` est-il lu côté bridge ? | Lire la gestion `close` de `bridge/src/providers/openclaw/openclaw-client.ts`. |
| N8 | Sous quel format Hermes reporte-t-il sa version au bridge (`0.19.0` vs `2026.7.20`) ? Détermine si le gating Hermes échoue ouvert. | Lire `hermes/client.ts`, `ws-client.ts`, `bridge/src/server.ts:1533` (`onHermesVersion`). |
| N9 | `/capabilities` déclare-t-il honnêtement `none-published` pour Hermes, comme promis par `docs/design/protocol-contract.md:108-110` ? | Lire `bridge/src/server.ts:2040-2070` et le rendu `src/chat/admin/`. |
| N10 | `tool.failed` Hermes : réellement émis, ou branche défensive morte ? (aucun émetteur trouvé dans `agent/`, `tools/`) | Capture live sur `/api/sessions/{id}/chat/stream`, ou grep sur une version ultérieure. |
| N11 | Le poids réel des **schémas d'outils** dans le prompt (l'estimation amont ne les compte pas ; Hermes documente 20-30k tokens sur 50+ outils). | `sessions.describe` avant/après désactivation d'un lot d'outils, à transcrit constant. |
| N12 | La `Map agentRunSeq` partagée entre `nextChatSeq` et le détecteur de gap peut-elle fabriquer un **faux** « seq gap » ? | Lire le cycle de vie de `clientRunId` dans `$UP/src/gateway/server-methods/chat.ts` + test amont ciblé. |
| N13 | Fréquence réelle des drops `dropIfSlow` sur le client. **Non mesurable aujourd'hui** — la correction de G-23 est elle-même l'instrument de mesure. | Livrer W3, puis observer 7 jours. |

### 8.3 Demandes à formuler à l'amont

Ce sont des **défauts amont**, pas Atrium. Les gardes Atrium doivent exister quelle
que soit la réponse, mais la demande vaut d'être faite.

| # | Demande | Preuve |
|---|---|---|
| U1 | `broadcastChatFinal` réutilise une constante d'**historique** (8 000 car.) sur un événement **live** : passer un `maxChars` explicite | `$UP/src/gateway/server-methods/chat.ts:2752` → `chat-display-projection.ts:27` |
| U2 | Inclure `reason` (`manual`/`threshold`/`overflow`) dans `data` des événements `stream:"compaction"` — la valeur est **déjà en main** | `$UP/…/handlers.compaction.ts:35-43` vs `:61-65`, `:151-155` |
| U3 | Ajouter `chat.send_timing` et `chat.side_result` à `GATEWAY_EVENTS` (test amont proposé : toute clé de `EVENT_SCOPE_GUARDS` figure dans `GATEWAY_EVENTS`, hors `plugin.*`) | `$UP/src/gateway/server-broadcast.ts:23-56` vs `server-methods-list.ts:39-70` |
| U4 | La trame synthétique `seq gap` **viole** `AgentEventSchema` (`seq` requis et absent) | `$UP/src/gateway/server-chat.ts:1272-1287` vs `schema/agent.ts:60` |
| U5 | `sessions.get`, méthode réellement appelée, n'a **aucun** schéma dans `ProtocolSchemas` (params validés à la main) | `$UP/src/gateway/server-methods/sessions.ts:2513-2527` |
| U6 | Un discriminant explicite sur les injections (`injected:true`) plutôt qu'un préfixe `inject-` fragile | `$UP/src/gateway/server-methods/chat.ts:6019-6034` |
| U7 | Hermes : `is_error` est calculé puis **jeté** par le pont SSE — l'échec d'un outil n'est pas transportable sur `chat/stream` | `$HE/agent/tool_executor.py:917-921` vs `$HE/gateway/platforms/api_server.py:2567-2568` |
| U8 | Hermes : émettre un terminal sur le chemin de sortie muet (course annulation/ACK) | `$HE/tui_gateway/server.py:9494-9508` |
| U9 | Hermes : enregistrer le `run_id` du flux SSE dans `_active_run_agents` (ou passer `agent_ref`) pour que le stop soit réel | `$HE/gateway/platforms/api_server.py:2534` vs `:4926`, `:5285-5289` |

---

## 9. Traçabilité — correspondance rapports sources → registre consolidé

| Rapport source | Constats | Fusionnés dans |
|---|---|---|
| `01-openclaw-emission.md` | `oc-final-truncated-8k` | G-13 |
| | `oc-frames-seq-gap-blind`, `oc-agent-error-seqgap-dropped` | G-23, G-24 |
| | `oc-drift-denylist-not-derived` | G-68 |
| | `oc-compaction-reason-lost` | G-09 |
| | `oc-controlui-invisible-runs` | G-72 (**notNow**) |
| | `oc-side-result-dropped` | G-18 |
| | `oc-shutdown-ignored` | G-25 |
| | `oc-vendor-narrow` | G-61 |
| | `oc-plan-native-missing` | G-22 |
| | `oc-inject-adoption` | G-12 (sous-cas) |
| | `oc-chat-seq-not-orderable` | documenté (W8) |
| | `oc-unadvertised-events` | G-71 |
| | `oc-lifecycle-finishing-unhandled` | G-20 |
| `02-hermes-emission.md` | `hz-01`, `hz-02`, `hz-14` | G-55, G-56, G-58 |
| | `hz-03` | G-36 |
| | `hz-04` | G-38 |
| | `hz-05` | G-44 |
| | `hz-06` | G-43 |
| | `hz-07` | G-49 |
| | `hz-08` | G-51 |
| | `hz-09` | G-47 |
| | `hz-10` | G-48 |
| | `hz-11` | G-50 |
| | `hz-12` | G-53 |
| | `hz-13` | G-40 |
| `03-atrium-openclaw-handling.md` | `oc-seq-gap-loss-blind` | G-23, G-24 |
| | `oc-foreign-run-adopted-compaction` | G-12 |
| | `oc-finalize-no-retry-swallowed` | G-30, G-32 |
| | `oc-tool-update-phase-misread` | G-19 |
| | `oc-lifecycle-terminal-metadata-lost` | G-20 |
| | `oc-media-upload-no-timeout-deadlock` | G-31 |
| | `oc-agent-data-vocabulary-unratcheted` | G-67 |
| | `oc-compaction-completed-ignored` | G-08 |
| | `oc-approval-stream-dropped` | G-21 |
| | `oc-shutdown-sideresult-dropped` | G-25, G-18 |
| | `oc-assistant-phase-ignored` | G-17 |
| | `oc-intra-turn-unbounded-maps` | G-34 |
| `04-atrium-hermes-handling.md` | `hermes-promptsubmit-ack-ignored` | G-36 |
| | `hermes-no-deadline-no-ping` | G-37 |
| | `hermes-session-rotation-lost` | G-46 |
| | `hermes-rest-abort-manifest-lie` | G-41 |
| | `hermes-message-interim-dropped` | G-43 |
| | `hermes-blocking-prompts-unhandled` | G-38 |
| | `hermes-approval-loses-real-reply` | G-39 |
| | `hermes-transient-classifier-wrong-input` | G-42 |
| | `hermes-sse-no-tool-flush` | G-49 |
| | `hermes-sse-no-usage-no-meta` | G-50 |
| | `hermes-warning-and-interrupted-mismapped` | G-44, G-45 |
| | `hermes-no-protocol-drift-machinery` | G-58 |
| | `hermes-subagent-rollups-and-statuses-lost` | G-52 |
| | `hermes-rest-inline-dataurl-unbounded` | G-54 (**notNow**) |
| `05-context-overflow.md` | `oc-gauge-source-misattribution` | G-01 |
| | `oc-contextbudget-status-dropped` | G-02 |
| | `oc-totaltokensfresh-ignored` | G-03 |
| | `oc-plugin-owns-compaction-disarms-preflight` | G-05 |
| | `oc-midturn-precheck-off-by-default` | G-06 |
| | `oc-no-presend-guard` | G-04 |
| | `oc-overflow-terminal-no-exit` | G-07 |
| | `oc-atrium-own-estimate-missing` | **notNow** (borne basse seulement) |
| | `oc-subagent-overflow-unclassified` | G-11 |
| | `oc-rehydration-token-ceiling-missing` | G-10 |
| `06-ordering-concurrency.md` | `oc-recover-delivered-no-epoch` | G-28 |
| | `oc-turnsink-apply-not-serialized` | G-29 |
| | `oc-foreign-run-adopted-in-grace` | G-12 |
| | `oc-seq-unused-and-gap-signal-dropped` | G-23, G-24 |
| | `oc-snapshot-regression-unguarded` | G-14 |
| | `oc-chat-dedup-single-slot` | G-15 |
| | `oc-inbound-frame-queue-unbounded` | G-27 |
| | `oc-announce-flush-clock-rewrite` | G-35 |
| | `oc-handled-announce-bounded-100` | G-15b |
| | `oc-subagent-updatedat-is-arrival-time` | G-15c |
| `07-version-process.md` | `vendor-lag-ratchet-noop` | G-59 |
| | `outbound-params-no-floor-gate` | G-60 |
| | `ratchet-scope-3-of-31` | G-61 |
| | `validated-versions-unproven` | G-63 |
| | `beyond-validated-fails-open` | G-62, G-57 |
| | `caps-manifest-incomplete-lockstep-broken` | G-64 |
| | `features-live-only-no-failing-test` | G-65 |
| | `drift-inbound-only-and-masked` | G-66 |
| | `upstream-diff-informational-wrong-base` | G-73 |
| `08-unknown-frames.md` | F1 (exception muette) | G-33 |
| | angles morts A/B/C/D/E/F/G | G-69, G-66 |
| | §1.4 (trame perdue) | G-23 |
| | §3.11 (`hello-ok.features`) | G-70 |
| | F11/F12/F13 (perte de contenu) | G-16, G-34 |
| `10-registre-prod.md` | 10 incidents datés | **ancre de priorisation** de tout le programme |

**Total** : 90 constats sources → 73 lacunes consolidées → 12 lots.
