# 07 — Processus de support d'une version de gateway (exigence : ZÉRO régression)

Zone : le processus « ajouter/valider une version d'OpenClaw ou de Hermes ».
Lecture seule sur `<workspace>/atrium`. Toute
affirmation est tracée à un `fichier:ligne` réel. Quand une chose n'est pas
prouvée, c'est écrit **NON PROUVÉ** avec ce qu'il faut lire pour trancher.

Sources amont lues :
- OpenClaw @ `v2026.7.1` :
  `<scratch>`
  (tag confirmé : `git describe --tags` → `v2026.7.1`, HEAD `2d2ddc43`)
- Hermes @ `/tmp/hermes-upstream.okb8T2` (tag unique `v2026.7.20`,
  `pyproject.toml:10` → `version = "0.19.0"`)

---

## 1. Inventaire de l'existant — ce qui est déterministe, ce qui ne l'est pas

### 1.1 Les six mécanismes en place

| # | Mécanisme | Fichier | Nature | Bloque ? |
|---|---|---|---|---|
| M1 | Skill `add-gateway-version` | `<hors-dépôt>/skills/add-gateway-version/SKILL.md` | procédure humaine, 7 étapes | non (aucune machine ne l'exécute) |
| M2 | Diff d'interprétation amont | `<hors-dépôt>/live-bench/upstream-diff.sh` | script déterministe (clone 2 tags, diff watchlist, ancres `+`/`-`) | **non — dit explicitement l'inverse** (`upstream-diff.sh:14-17`) |
| M3 | Banc live | `<hors-dépôt>/live-bench/run-live-bench.mjs` + `scenarios.mjs` + `frame-contracts.mjs` | 11 scénarios réels, verdict GO/NO-GO, exit 0 = GO (`run-live-bench.mjs:10`, `:616`) | oui, mais **local + manuel + hors CI** |
| M4 | Ratchet de couverture | `bridge/test/protocol-coverage.test.ts` | test unitaire, bijection schéma vendored ↔ `coverage.json` | oui (CI `bridge` job, `ci.yml:90`) |
| M5 | Détecteur de drift runtime | `bridge/src/providers/openclaw/protocol-drift.ts` (+ `test/protocol-drift.test.ts`) | observe-only, compte les champs inconnus, jamais gate (`protocol-contract.md:78`) | non, par conception |
| M6 | Trames amont rejouées | `bridge/test/upstream-frames.test.ts` + `test/fixtures/openclaw_upstream_frames.json` | 7 scénarios extraits VERBATIM des tests amont @v2026.7.1 | oui (CI) |
| M7 | VCOMPAT | `bridge/src/compat.ts` + `bridge/test/compat.test.ts` | table capacité → minVersion, résolution pure | oui pour la *résolution*, **jamais pour la validation** |

### 1.2 Déterministe vs jugement humain

**Déterministe (la machine tranche) :**
- M4 : `protocol-coverage.test.ts:94-144` — tout schéma/champ nouveau du
  répertoire vendored reste ROUGE tant qu'un humain ne l'a pas classé
  (`handled`/`ignored`/`gap`, chacun avec son champ obligatoire :
  `:71-87`). Zéro orphelin autorisé (`:126-144`).
- M4bis : `protocol-drift.test.ts:107-215` — bijection entre les ensembles
  runtime (`KNOWN_CHAT_FIELDS`, `KNOWN_AGENT_FIELDS`, `COVERAGE_SUMMARY`) et
  `coverage.json`. Chaîne unique : schéma vendored ↔ manifeste ↔ runtime.
- M6 : `upstream-frames.test.ts` rejoue 7 formes de trames dont la source amont
  est citée à la ligne (ex. `chat-abort.test.ts:335-346`,
  `server-chat.agent-events.test.ts:3829-3865`).
- M2 : `upstream-diff.sh:85-102` — 15 ancres littérales `+`/`-` vérifiées
  mécaniquement (`upstream-anchors.txt`). Sortie factuelle, reproductible.
- M3 : la comparaison de version est un vrai gate
  (`run-live-bench.mjs:529` NO-GO si `gwVersion != EXPECT_VERSION`) et une
  sélection de scénarios vide est un NO-GO (`:575-578`) — pas de GO vacuous.
- M7 : `resolveCapabilities` est pure et exhaustivement testée
  (`compat.ts:293-318`).

**Jugement humain (« on a regardé et ça marchait ») :**
- **M1 n'a aucune exécution machine.** C'est un document. Rien ne vérifie que
  ses 7 étapes ont eu lieu. En particulier, **l'étape 6 (`SKILL.md:80-87`)
  n'inclut AUCUNE re-vendorisation du schéma** : elle ne touche que
  `compat.ts`, `compat.test.ts` et les `minVersion`. Conséquence directe :
  ajouter une version au support laisse M4 pointé sur l'ancien schéma → le
  ratchet devient un **no-op silencieux** (voir §3).
- **M2 est informatif par écrit** : « The OUTPUT is informational […] this
  script never decides GO/NO-GO » (`upstream-diff.sh:14-17`). Une zone CHANGED
  déclenche « lancer un agent par zone » — c'est-à-dire une analyse LLM en
  prose, dont le résultat n'est contraint par aucun test.
- **`validatedVersions` est une déclaration humaine.** `compat.ts:168-184`
  liste 8 versions ; `bridge/test/compat.test.ts:166` ne fait que ré-épingler
  la même liste littérale. **Aucun artefact de run n'est lié** : `grep -rn
  "bench-runs|live-bench"` dans le repo ne retourne que 3 commentaires
  (`bridge/test/tool-output-contract.test.ts:13`, `convex/dev.ts:1078`,
  `convex/dev.ts:2168`). Rien ne prouve qu'un banc a tourné pour une version
  donnée.
- **Le banc n'est pas hermétique** : il pilote un vrai modèle. Les scénarios
  reposent sur des jetons pinnés dans le prompt (`scenarios.mjs:36` →
  « Commence ta reponse par EXACTEMENT: BENCH_BASIC_OK ») ; la variance LLM est
  gérée par un retry borné et *classifié*
  (`run-live-bench.mjs:325-339`, `:363-376` : `retryable = !sawAnnounce`) — ce
  qui est un bon design, mais qui reste une non-reproductibilité assumée.
- **Le banc ne tourne pas en CI.** `.github/workflows/ci.yml` = 3 jobs :
  supply-chain image (`:12-46`), app typecheck/build/test (`:48-75`), bridge
  typecheck/test (`:77-90`). Aucun appel au banc, aucun artefact de banc requis.

**Verdict §1 :** la machinerie déterministe existe et est de bonne qualité,
mais elle est **débranchée du processus d'ajout de version**. Le seul gate
réellement bloquant pour une nouvelle version est le banc live, exécuté à la
main, sur une machine, sans trace vérifiable.

---

## 2. Les features dépendantes du protocole — le manifeste est-il complet ?

### 2.1 Ce que le manifeste couvre (et ce qu'il ne couvre pas)

`bridge/src/compat.ts` déclare **15 capacités OpenClaw** (`:75-110`) et
**2 / 8 capacités Hermes** (`:121-145`).

Le manifeste est présenté comme « la liste officielle » — il ne l'est pas. Il
liste des **interrupteurs d'UI**, pas les **comportements de protocole**.
Comparaison entre les features Atrium qui dépendent réellement du protocole et
la couverture réelle :

| Feature Atrium dépendante du protocole | Clé de capacité ? | Test qui ÉCHOUE si la version casse la feature ? | Preuve |
|---|---|---|---|
| Streaming delta/final (le cœur) | non | oui — `upstream-frames.test.ts` + `chatStreamContract` (`frame-contracts.mjs:55`) + scénario `basic-turn` | `scenarios.mjs:31-52` |
| Classification terminale (`state` seul, `stopReason` refusé) | non | oui — `upstream-frames.test.ts` scénarios `aborted-user-stop-partial-text`, `error-timeout-stopreason-precedence` | fixture `openclaw_upstream_frames.json` |
| `errorKind` → `errorCode` | non | oui — scénario `error-errorkind-rate-limit` + `protocol-coverage.test.ts:146-160` (spot-pin) | |
| Verrous de session (embedded / init OCC) | non | oui — scénarios `embedded-takeover-after-content`, `init-conflict-zero-content` (regex verbatim) | ancres `upstream-anchors.txt` Zone 1 |
| Compaction (signaux `{stream:"compaction"}`) | non | oui — scénario `compaction-explicit-stream-signals` + `compaction-detection.test.ts` | |
| Fusion announce « une bulle » | non | banc live (`spawn-announce-merge`, `spawn-chain-merge`, `spawn-parallel-merge`) **+ `merge-contract.test.mjs`** (assertion pure sur 2 captures réelles) | `scenarios.mjs`, `frame-contracts.mjs` |
| Tâches async (`{async:true,taskId}` + run `<tool>:<id>:ok`) | non | **banc live seulement** (`async-task`) | `scenarios.mjs:229-264` |
| Carte « Plan » (`UpdatePlanToolSchema`) | non | **banc live seulement** (`update-plan`) | `scenarios.mjs:70-85` |
| Livraison média sortante | `mediaOutbound` | **banc live seulement** (`media-outbound`) | `scenarios.mjs:86-102` |
| Cron liste / gestion | `cronList` / `cronManage` | **banc live seulement** (`cron-tool`) | `scenarios.mjs:265-288` |
| Idempotency `chat.send` / dispatchKey | non | non (unitaire côté Atrium ; **aucun test contre le contrat amont**) | zone 5 de `upstream-zones.md` |
| Préemption announce×send (`preemptRepark`) | non | **banc live seulement** (`announce-queue-race.mjs`, hors suite principale) | fichier séparé, non appelé par `run-live-bench.mjs` |
| `chat.abort` (bouton stop) | `abort` | partiel — `abort-route.test.ts` teste la route bridge, pas la forme amont | `server.ts:2407-2410` |
| Sous-agents (`spawnedBy`, monitor) | `subagents` | banc live + `sub-agent-observer.test.ts` (fixtures figées) | |
| Talk / WebRTC | `talk` | **aucun test** — `probe-talk.mjs` est un script manuel hors suite | `live-bench/probe-talk.mjs` |
| Quote-reply, signets, branchement | non | pas de dépendance protocole directe | — |

**Constat :** 6 features majeures ne sont couvertes QUE par un scénario live
manuel, et 2 (`talk`, `announce×queue`) ne sont dans AUCUNE suite exécutée par
défaut.

### 2.2 Le manifeste est incohérent entre les deux repos (cassure prouvée)

`src/chat/capabilities.ts:22-34` fige `CAPABILITY_KEYS` à **11 clés**. Le
bridge en publie **15**. Manquent côté union fermée du front :
`messageToolRecovery`, `agentsDiscovery`, `abort`, `mediaOutbound`, `cronList`,
`cronManage`.

Or `cronList` / `cronManage` **sont consommés** — mais par chaîne de caractères
brute, ce qui contourne le gate compile :
```
convex/scheduled.ts:96   supported: cap?.capabilities?.cronList === true,
convex/scheduled.ts:97   manageSupported: cap?.capabilities?.cronManage === true,
```
`capabilityOf` (`capabilities.ts:67-73`) et l'union `CapabilityKey`
(« tsc est le vrai gate », `capabilities.ts:16-18`) sont donc court-circuités
pour ces deux clés. Un renommage bridge-side de `cronManage` compilerait et
désactiverait silencieusement l'onglet Programmées.

Le test qui prétend garantir le lockstep ne le garantit pas :
- `src/chat/capabilities.test.ts:53-73` compare `CAPABILITY_KEYS` à une **liste
  littérale copiée dans le test** — auto-référentiel, aveugle à l'autre repo.
- `src/chat/capabilities.test.ts:75-91` (« cross-repo anchor, P2-1 ») est
  **unidirectionnel** : `for (const key of CAPABILITY_KEYS) expect(manifestKeys).toContain(key)`.
  Une clé AJOUTÉE côté bridge ne fait jamais échouer.
- Et l'ancre elle-même est **périmée et éditée à la main** :
  `src/chat/bridgeCapabilitiesFixture.ts:1-6` dit « captured VERBATIM from a
  LIVE bridge […] against a real OpenClaw 2026.5.19 gateway […] 2026-06-12 »,
  `:47` `maxValidated: "2026.6.5"`, et `:62-68` avoue :
  « Hand-added in lockstep with the bridge manifest […] pending a real
  /capabilities re-capture ». Elle ne contient ni `abort`, ni `cronList`, ni
  `cronManage`. **Une fixture recopiée depuis l'hypothèse n'ancre plus rien.**

### 2.3 `versionBeyondValidated` échoue OUVERT

`compat.ts:311-316` : si la version du gateway dépasse `maxValidated`, **toutes
les capacités passent à `true`**. C'est exactement le scénario opérationnel
documenté par le repo lui-même : « the NAS updates OpenClaw before the bridge
image » (`docs/design/protocol-contract.md:82-84`).

L'unique conséquence visible est un badge admin : `src/chat/admin/compatView.ts:41`
`if (target.versionBeyondValidated) return "beyond";`. Aucune restriction,
aucune bannière utilisateur (grep `versionBeyondValidated` sur `src/` : 6
occurrences, toutes admin/tests/schema). Un client sur un gateway non validé
obtient donc une UI qui promet des capacités jamais éprouvées — c'est
littéralement la définition de la régression qu'on veut interdire.

---

## 3. Le décalage du schéma vendored : coût réel, mesuré

`bridge/protocol/openclaw/2026.6.11/` est le SEUL répertoire vendored
(`ls bridge/protocol/openclaw/` → `2026.6.11`, `coverage.json`), tandis que
`compat.ts:167` déclare `maxValidated: "2026.7.1"`. `coverage.json:version` =
`"2026.6.11"` et `protocol-coverage.test.ts:27` `VENDORED_VERSION = "2026.6.11"`.

`docs/design/protocol-contract.md:39-45` exigeait pourtant : « For **each**
gateway version in the validated range […] vendor the protocol schema into the
repo ». Le contrat de conception n'est pas tenu.

### 3.1 Ce que le décalage a laissé passer — diff mesuré 6.11 → 7.1

Diff réel entre `bridge/protocol/openclaw/2026.6.11/*.ts` et
`$UP/packages/gateway-protocol/src/schema/*.ts` (hors bandeau de vendoring) :

| Schéma | Champ nouveau @7.1 | Sens | Direction | Trié par une machine ? |
|---|---|---|---|---|
| `ChatHistoryParams` | `offset` (`logs-chat.ts:35` amont) | pagination de l'historique | sortant | **non** |
| `ChatSendParams` | `expectedSessionRoutingContract` (`logs-chat.ts:99` amont) | garde anti-mauvais-routage : le gateway refuse le send si le contrat de routage a changé (`src/gateway/server-methods/chat.ts:3825-3838`, erreur `INVALID_REQUEST` « session routing changed; review and retry ») | sortant | **non** |
| `ChatAbortParams` | `preserveSideRuns` (`logs-chat.ts:111` amont) | n'abandonne PAS les runs de voie latérale (`turnKind === "btw"`) — `src/gateway/server-methods/chat.ts:2442`, `:2505` | sortant | **non** |
| `ChatAbortedEvent` | `errorMessage` (`logs-chat.ts:176` amont) | motif lisible d'un abort auto (ex. échec de validation d'outil) | **entrant** | **non** |
| `AgentParams` | `cwd` (`agent.ts:209` amont) | répertoire de travail du run | sortant | **non** |

Cinq additions de contrat sur une version déclarée validée, dont **aucune** n'a
été présentée à un humain par une machine. Le ratchet M4 n'a rien dit : il
compare le manifeste au répertoire `2026.6.11`, pas au gateway supporté.

Deux angles morts structurels sont ainsi démontrés :

1. **Le détecteur de drift M5 ne voit que l'ENTRANT.**
   `protocol-drift.ts:159-170` n'observe que `event: "chat"` et
   `event: "agent"`. Les 4 additions sortantes ci-dessus lui sont
   invisibles par construction. Et la 5ᵉ (`ChatAbortedEvent.errorMessage`) est
   **masquée** : `KNOWN_CHAT_FIELDS` est l'UNION des quatre événements chat
   (`protocol-drift.ts:28-43`), et `errorMessage` y figure déjà via
   `ChatErrorEvent` → drift = 0 alors que le contrat a bougé.
2. **Le commentaire de référence est factuellement faux.**
   `protocol-drift.ts:20-24` affirme : « The 2026.7.1 bench observed EXACTLY
   ONE addition over it (`agent.effectiveResponseUsage`) […] so 6.11 + that
   field IS the 7.1 surface ». Le diff ci-dessus le contredit : la surface 7.1
   contient 5 champs de plus. La phrase confond « ce que le banc a observé » et
   « ce que le contrat autorise » — précisément la distinction (a)/(b) que la
   stabilisation exige.

### 3.2 L'angle mort de périmètre : 3 modules vendored sur 31

`protocol-coverage.test.ts:23-25` ne parcourt que `logs-chat`, `agent`,
`primitives`. Amont, `packages/gateway-protocol/src/schema/` compte **31
modules non-test**.

Or le bridge appelle **20 méthodes RPC distinctes** (grep sur `bridge/src/`) :

| Méthode | Module de schéma amont | Vendored ? | Ratchet ? |
|---|---|---|---|
| `chat.send`, `chat.abort` | `logs-chat.ts` | oui (6.11) | oui |
| événements `chat`/`agent` | `logs-chat.ts`, `agent.ts` | oui (6.11) | oui |
| `sessions.patch` ×6, `sessions.get` ×4, `sessions.describe` ×2, `sessions.reset`, `sessions.compact` | `sessions.ts` (40 schémas) | **non** | **non** |
| `cron.list`, `cron.get` ×2, `cron.update`, `cron.remove`, `cron.run`, `cron.runs`, `cron.manage` ×2 | `cron.ts` (45 schémas) | **non** | **non** |
| `tasks.list`, `tasks.get` | `tasks.ts` (9 schémas) | **non** | **non** |
| `config.get` ×3, `config.patch` | `config.ts` (13 schémas) | **non** | **non** |
| `models.list` | `agents-models-skills.ts` (77 schémas) | **non** | **non** |
| `agent.activity` ×3 | `agent.ts` | oui | oui |

**15 des 20 méthodes appelées n'ont aucun ratchet de schéma.** Les onglets
Programmées (cron), les knobs de session (`sessions.patch`), la compaction
(`sessions.compact`), les défauts de chat (`config.patch`) et la liste de
modèles reposent entièrement sur « le banc a marché ce jour-là ».

Le même trou existe côté M2 : `upstream-watchlist.txt` couvre 22 fichiers sur 5
zones, dont **aucun** `cron.ts`, `sessions.ts`, `tasks.ts`, `config.ts`,
`agents-models-skills.ts`.

### 3.3 Deux bases de comparaison différentes

- M4 compare le manifeste au **répertoire vendored** = `2026.6.11`.
- M2 prend pour base `maxValidated` de `compat.ts` (`upstream-diff.sh:31-35`)
  = `2026.7.1`.

Les deux gardes ne regardent donc pas le même point de départ. Le dernier
rapport produit
(`<hors-dépôt>/bench-runs/upstream-diff-2026.6.11-vs-2026.7.1/report.md`)
signale « 15 changed / 7 unchanged / 0 missing / 6 new » et « Anchors: 15 ok /
0 FAILED » — donc la machine A SIGNALÉ que `logs-chat.ts` avait changé, mais
comme sa sortie est informative, la re-vendorisation n'a jamais eu lieu.

### 3.4 Le risque SORTANT que rien ne couvre : le range de support

Les schémas de paramètres amont sont **stricts** :
`{ additionalProperties: false }` sur `ChatSendParams` et `ChatAbortParams`
(vendored `logs-chat.ts`, identique amont). Amont le confirme en clair :
`src/tui/gateway-chat.ts:243-245` — « Protocol v4 peers reject unknown fields.
Retry the shipped abort shape so mixed-version TUI stops still work ».

Atrium annonce supporter un RANGE (`compat.ts:167` : `min: "2026.5.19"` →
`maxValidated: "2026.7.1"`) mais :
- envoie **une seule forme de paramètres** à toutes les versions —
  `gatewayVersion` n'est utilisé que pour publier `/capabilities`
  (`server.ts:1678-1685`, `:1709`), jamais pour moduler un appel sortant ;
- le banc ne rejoue **jamais le plancher** : `SKILL.md:60-74` bascule le banc
  sur la version CIBLE et lance la suite une fois. Aucune ré-exécution sur
  `2026.5.19`.

Conséquence : ajouter un paramètre pour bénéficier d'une nouveauté 7.1 (par ex.
`expectedSessionRoutingContract`, qui serait précisément le remède au
mauvais routage dont se plaignent les clients) **casserait durement tous les
gateways < 7.1** — `INVALID_REQUEST` sur chaque `chat.send` — et **aucun gate
actuel ne l'attraperait**. C'est le trou de régression le plus direct du
processus.

---

## 4. Hermes : le processus n'existe quasiment pas

| Élément | OpenClaw | Hermes |
|---|---|---|
| Schéma vendored | `bridge/protocol/openclaw/2026.6.11/` | **aucun** (`ls bridge/protocol/` → `openclaw` seul) |
| Manifeste de couverture | `coverage.json` (32 schémas) | **aucun** |
| Ratchet CI | `protocol-coverage.test.ts` | **aucun** |
| Détecteur de drift | `protocol-drift.ts`, câblé `run-manager.ts:437` | **aucun** (`ls bridge/src/providers/hermes/` : pas de `protocol-drift.ts`) |
| Diff amont outillé | `upstream-diff.sh` + watchlist + ancres | **aucun** (le script est OpenClaw-only, `upstream-diff.sh:46` clone `github.com/openclaw/openclaw`) |
| Fixtures | trames extraites des tests AMONT (`openclaw_upstream_frames.json`) | **captures live uniquement** (`test/fixtures/hermes/*.jsonl`, `*.sse`) — donc (b) « ce qu'il a émis ce jour-là », jamais (a) « ce qu'il peut émettre » |
| Scénarios de banc | 9 | 2 (`hermes-basic-turn`, `hermes-cron-list`, `scenarios.mjs:289-330`) |

`docs/design/protocol-contract.md:108-110` promettait au moins l'honnêteté
(`"schema": "none-published"`). **NON PROUVÉ** que ce soit implémenté — à
vérifier en lisant la section `protocol` construite dans `bridge/src/server.ts`
(vers `:2053`, `drift: protocolDrift.report()`) et son rendu
`src/chat/admin/` : le champ est nommé pour OpenClaw ; rien n'indique une
branche Hermes.

Signal amont à traiter : Hermes a changé de schéma de version. Le dépôt est
taggé `v2026.7.20` alors que `pyproject.toml:10` dit `0.19.0`. `compat.ts:193`
déclare `maxValidated: "0.18.2"` et `parseVersion` (`compat.ts:211-224`) exige
exactement trois entiers — `"2026.7.20"` parserait aussi, mais dans un espace
de comparaison **incompatible** avec `0.18.2` (2026 > 0 ⇒ « beyond validated »
⇒ toutes capacités à `true`, cf. §2.3). Selon la chaîne qui alimente la version
(health Hermes vs tag), le passage à 0.19.0 peut donc faire échouer OUVERT tout
le gating Hermes. **NON PROUVÉ** dans quel format Hermes reporte sa version au
bridge : lire `bridge/src/providers/hermes/client.ts` / `ws-client.ts` et
`server.ts:1533` (`onHermesVersion`).

---

## 5. Pipeline cible — refuser une version par la machine, pas par l'humain

Principe : **`validatedVersions` ne doit plus être un texte qu'on édite ; ce
doit être la conséquence mécanique d'un artefact signé.** Le processus est un
pipeline à 8 portes, chacune produisant une preuve vérifiable ; toute porte
rouge = version REFUSÉE.

### G0 — Vendorisation obligatoire (nouvelle porte, la plus rentable)

- **Automatisé** : `bridge/scripts/vendor-protocol.mjs <version>` — clone
  shallow du tag, copie `packages/gateway-protocol/src/schema/*.ts` + les
  dépendances (`client-info.ts`, `secret-ref-contract.ts`) dans
  `bridge/protocol/openclaw/<version>/`, réécrit les imports, écrit un
  `PROVENANCE.json` (tag, SHA du commit, sha256 par fichier).
- **Périmètre élargi** : plus 3 modules mais **la liste des modules dont
  Atrium dépend** — au minimum `logs-chat`, `agent`, `primitives`, `sessions`,
  `cron`, `tasks`, `config`, `frames`, `error-codes`,
  `agents-models-skills` (restreint à `models.list`). Cette liste est elle-même
  dérivée mécaniquement des méthodes RPC appelées (§3.2).
- **Gate** : un test `vendor-integrity.test.ts` recalcule les sha256 et refuse
  un répertoire vendored édité à la main ; un test refuse que
  `compat.ts:maxValidated` désigne une version **sans** répertoire vendored.
- **Preuve** : `PROVENANCE.json` avec le SHA amont.

### G1 — Ratchet multi-version (M4 généralisé)

- **Automatisé** : `protocol-coverage.test.ts` boucle sur TOUS les répertoires
  de `bridge/protocol/openclaw/` (aujourd'hui codé en dur ligne 23-27) et
  `coverage.json` devient `coverage/<version>.json`.
- **Gate** : ROUGE tant qu'un schéma/champ nouveau n'est pas classé — logique
  déjà écrite (`:94-144`), il suffit de la nourrir.
- **Preuve** : le diff `coverage/<ancienne>.json` → `coverage/<nouvelle>.json`
  **EST** la checklist de migration (l'intention originelle,
  `protocol-contract.md:65`).

### G2 — Ratchet SORTANT (porte absente aujourd'hui)

- **Automatisé** : un test qui, pour chaque appel RPC du bridge, valide le
  corps de paramètres qu'il construit contre le schéma TypeBox vendored
  **de la version PLANCHER** (`supportedRange.min`) ET de `maxValidated`.
  Faisable sans réseau : les schémas TypeBox sont des JSON Schema, et
  `additionalProperties:false` fait le travail.
- **Gate** : ROUGE si le bridge émet un champ que le plancher rejette. Le
  correctif imposé est alors explicite : soit relever le plancher, soit gater
  le champ par version (comme `src/tui/gateway-chat.ts:237-247` le fait amont).
- **Preuve** : matrice `méthode × version` verte.
- **Impact** : c'est cette porte qui rend enfin sûr l'usage de
  `expectedSessionRoutingContract` et `preserveSideRuns`.

### G3 — Diff d'interprétation, promu bloquant (M2 durci)

- **Automatisé** : `upstream-diff.sh` inchangé dans son mécanisme mais
  (a) base = **la version vendored**, pas `maxValidated` (aujourd'hui
  `:31-35`), (b) watchlist étendue aux modules cron/sessions/tasks/config,
  (c) sortie machine (`report.json` avec `changedZones[]`, `anchorFailures[]`).
- **Gate** : une zone CHANGED ou une ancre FAILED **bloque** tant qu'un fichier
  `docs/design/upstream-interpretation-comparison.md` n'a pas été mis à jour ET
  qu'au moins un scénario de `openclaw_upstream_frames.json` de la zone n'a pas
  été **ré-extrait** (le test vérifie que `upstream_tag` du fichier de fixtures
  == la version cible ; aujourd'hui il vaut `"v2026.7.1"` en dur).
- **Preuve** : `report.json` + `upstream_tag` de la fixture.

### G4 — Corpus doré rejouable (transforme le live en déterministe)

- **Automatisé** : le banc capture déjà `frames.jsonl` par run
  (`run-live-bench.mjs:20-22`, `OPENCLAW_CAPTURE_FRAMES`). Ces captures sont
  aujourd'hui jetées dans `bench-runs/`. Les **promouvoir** : un
  `promote-capture.mjs` anonymise (SOC2 : ne conserver que les noms de champs
  et des valeurs synthétiques pour le texte) et écrit
  `bridge/test/fixtures/golden/<version>/<scenario>.jsonl`.
- **Gate** : un test `golden-replay.test.ts` rejoue TOUT le corpus (toutes
  versions) dans le normalizer et compare les `BridgeEvent[]` produits à un
  snapshot. Une nouvelle version qui change l'interprétation d'une ANCIENNE
  capture = ROUGE.
- **Preuve** : snapshots versionnés en git.
- **Effet** : les 6 features aujourd'hui « banc live seulement » (§2.1)
  obtiennent enfin un test qui échoue en CI.

### G5 — Drift, des deux côtés et en CI (M5 étendu)

- **Automatisé** : (a) faire tourner `protocolDrift.observe()` sur le corpus
  doré en CI (aujourd'hui il ne s'exécute qu'en prod, `run-manager.ts:437`) ;
  (b) ajouter un `outboundDrift` symétrique sur les paramètres émis ;
  (c) remplacer l'UNION `KNOWN_CHAT_FIELDS` par un test **par état**
  (`delta`/`final`/`aborted`/`error`) — sinon un champ nouveau sur un état
  reste masqué (§3.1).
- **Gate** : drift ≠ 0 sur le corpus doré = ROUGE (en prod il reste
  observe-only, conformément à `protocol-contract.md:78`).
- **Preuve** : rapport de drift à 0.
- **SOC2** : inchangé — noms de champs et compteurs uniquement
  (`protocol-drift.ts:9-10`, `:176-186`).

### G6 — Banc live, verdict signé et lié au manifeste

- **Automatisé** : `run-live-bench.mjs` écrit déjà `report.json` avec
  `verdict` (`:616`). Ajouter : version du gateway, SHA du commit Atrium, SHA
  du répertoire vendored, liste des scénarios, horodatage — et un condensé
  signé écrit dans `bridge/protocol/openclaw/<version>/BENCH.json`.
- **Gate** : `compat.test.ts` refuse toute entrée de `validatedVersions` sans
  `BENCH.json` correspondant, `verdict === "GO"`, `scenarios` couvrant
  l'intégralité du catalogue (pas de `--skip-image` silencieux), et
  `atriumSha` appartenant à l'historique du repo.
- **Preuve** : `BENCH.json` versionné. **La liste des versions validées cesse
  d'être une affirmation humaine.**
- **Couverture manquante à ajouter au catalogue** : `announce-queue-race.mjs`
  (aujourd'hui hors suite) et un scénario `talk` dérivé de `probe-talk.mjs`.

### G7 — Plancher re-testé, et refus d'échouer ouvert

- **Automatisé** : le banc rejoue la suite sur `supportedRange.min` en plus de
  la cible (2 swaps `gateway-swap.sh`, script existant). Alternative moins
  coûteuse et suffisante pour la plupart des cas : G2 + G4 sur le corpus doré
  du plancher.
- **Gate** : `resolveCapabilities` (`compat.ts:311-316`) change de politique —
  au-delà de `maxValidated`, **ne pas** accorder toutes les capacités. Deux
  modes possibles, à trancher avec l'utilisateur : (i) gel au dernier profil
  validé + bannière opérateur, (ii) refus de servir les capacités « à risque »
  (écritures : `knob*`, `configDefaults`, `cronManage`) tout en gardant les
  lectures. Dans les deux cas, `versionBeyondValidated` doit remonter jusqu'à
  une bannière visible, pas seulement le badge admin
  (`compatView.ts:41`).
- **Preuve** : test de politique dans `compat.test.ts` + capture d'écran de la
  bannière.

### G8 — Lockstep de manifeste, réellement bidirectionnel

- **Automatisé** : supprimer la fixture éditée à la main
  (`bridgeCapabilitiesFixture.ts`) ; la régénérer depuis le bridge à chaque
  run de banc (le banc a déjà un bridge vivant) et l'écrire dans le repo.
- **Gate** : `capabilities.test.ts` teste l'ÉGALITÉ des ensembles (front ⟷
  manifeste), pas l'inclusion (`:84-87`), et un test interdit tout accès
  `capabilities.<clé>` par chaîne brute hors `capabilityOf` (lint / grep test)
  — ce qui rattraperait `convex/scheduled.ts:96-97`.
- **Preuve** : fixture régénérée + test d'égalité vert.

### Vue d'ensemble

```
G0 vendorisation ──► G1 ratchet entrant ──► G2 ratchet sortant ──► G3 diff amont
                                                     │
                     G4 corpus doré ◄─────────────────┘
                            │
                     G5 drift CI ──► G6 banc signé ──► G7 plancher + fail-closed ──► G8 lockstep
```
Portes exécutables en CI : G0, G1, G2, G3 (diff pré-calculé), G4, G5, G8.
Portes nécessitant une machine avec gateway : G6, G7 — mais leur **preuve**
(`BENCH.json`) est vérifiée en CI, donc la CI reste l'arbitre final.

### Ordre de mise en œuvre recommandé (rapport valeur/coût)

1. **G0 + G1** — débloque immédiatement le retard 6.11→7.1 et fait apparaître
   les 5 champs non triés. Coût M.
2. **G6** — lie `validatedVersions` à un artefact ; supprime le « on a regardé ».
   Coût S (le `report.json` existe déjà).
3. **G2** — supprime le risque de casse du plancher. Coût M.
4. **G4** — donne un test qui échoue aux 6 features « banc seulement ». Coût L.
5. **G7** — arrête le fail-open. Coût S (code) mais décision produit à prendre.
6. **G8, G5, G3** — durcissement. Coût S/M chacun.

---

## 6. Ce qui reste NON PROUVÉ (à trancher par lecture ciblée)

1. La section `protocol` de `/capabilities` déclare-t-elle honnêtement
   `none-published` pour Hermes ? → lire `bridge/src/server.ts` autour de
   `:2040-2070` et le rendu `src/chat/admin/`.
2. Sous quel format Hermes reporte-t-il sa version (`0.19.0` vs `2026.7.20`) ?
   → `bridge/src/providers/hermes/client.ts`, `ws-client.ts`,
   `bridge/src/server.ts:1533`.
3. Le scénario `announce-queue-race.mjs` est-il invoqué par un chemin autre que
   `run-live-bench.mjs` ? → il n'apparaît ni dans `run-live-bench.mjs` ni dans
   `scenarios.mjs` ; confirmer qu'il est bien exécuté à la main uniquement.
4. Existe-t-il un ratchet côté Convex/front pour la forme du body
   `/capabilities` (au-delà de la fixture) ? → `convex/compat.test.ts`
   normalise la fixture mais **NON PROUVÉ** qu'un champ manifeste supprimé
   fasse échouer.
