# Lot 47 — Atrium dépend de TROIS serveurs amont, un seul publie un contrat

**G-58, tranche 1.** La lacune tenait en une phrase — « aucun contrat Hermes vendorisé,
aucun coverage, aucun cliquet, aucun détecteur de drift » — et c'est ce que W10 a fait pour
OpenClaw en **neuf lots**. Découpé, donc, et le découpage a été choisi sur mesure, pas au
jugé.

## Trois vérifications avant d'écrire une ligne

| Question | Réponse mesurée |
| --- | --- |
| Le contrat a-t-il bougé entre les versions validées ? | **Non** — le dict `/v1/capabilities` est byte-identique entre `v2026.7.7.2` (0.18.2) et `v2026.7.20` (0.19.0), prouvé par hash. Un artefact couvre les deux. |
| Un lockstep `features` aurait-il des dents ? | **Non** — Atrium déclare 8 capacités, l'amont met 5 `features` à `false`, **intersection vide**. Un garde qui ne pourrait pas se déclencher : le piège tautologique du lot 25. **Exclu, avec ce compte pour raison.** |
| Les chemins qu'Atrium construit sont-ils déclarés ? | **Huit sur treize ne le sont pas.** |

## Le constat

**Atrium dépend de trois serveurs HTTP amont :**

| Serveur | Contrat publié | Chemins qu'Atrium y appelle |
| --- | --- | --- |
| `gateway/platforms/api_server.py` | **oui** — `GET /v1/capabilities` | 5 |
| `tui_gateway` | non | 1 (`/api/ws`, le transport par défaut) |
| dashboard (`hermes_cli/web_server.py`, `dashboard_auth/`) | **non** | 6 |

Et le dashboard est **opt-in** dans les mots de l'amont : « dashboard supervised alongside
**if HERMES_DASHBOARD is set** » (`hermes_cli/gateway.py:6607`). `tui_gateway` ne monte
qu'une route, `/api/ws` (`ws.py:19`). Donc **`hermes serve` seul — un déploiement
parfaitement normal — répond à chaque tour et 404 sur chaque opération de fichiers
d'agent**, ce qu'Atrium rendait en `UPSTREAM_ERROR` rejouable à l'infini.

## Ce que le lot livre

1. **Le contrat vendorisé.** `scripts/vendor-hermes-rest.mjs` extrait le dict littéral par
   équilibrage d'accolades, **refuse** toute entrée qu'il ne sait pas lire, lit **au tag**
   (`git show <tag>:<file>`) et enregistre `<tag>^{commit}`. Le `sha256` porte sur les
   **octets amont**, pas sur ma propre sortie. `--identical-to` prouve — et enregistre le
   tag et le commit de — chaque version couverte par identité.
2. **Le cliquet.** Chaque chemin absolu que le provider Hermes construit doit être dans la
   carte publiée **ou** classé explicitement, avec le serveur auquel il appartient et
   pourquoi. Dérivation **sur-inclusive**, récursive, sans commentaires et **sans allowlist
   de préfixe**.
3. **La cause nommée.** `HermesDashboardAbsentError` → `DASHBOARD_NOT_DEPLOYED`, reconnue
   **par type** (motif de `ContextBlockedError`), sur les **quatre** routes ambiguës, et
   propagée jusqu'à l'onglet, qui **retire son bouton Retry**.

## La question la plus fine : un 404 ne veut pas dire une seule chose

Soulevée en revue, et elle a **invalidé la moitié du premier jet**. `/api/files` lève
`404 "Path not found"` quand le **chemin** n'existe pas. Promouvoir tout 404 aurait dit à un
opérateur d'activer un serveur déjà en marche — la même fausse diagnose, en miroir.

Le discriminant est **structurel** : `agentFilesRoot()` appelle `/api/files` **sans** `path`,
donc le handler résout sa propre racine et un 404 là-bas est la route absente. Mais la racine
est **mise en cache**, donc la sonde était sautée après un succès : `assertDashboardStillThere()`
la réinvalide et **re-demande** à chaque 404 ambigu — liste, `read`, `upload`, `download`. Si
la sonde répond, le verdict **original** est conservé : un fichier réellement absent reste
`missing`. Et seule une sonde qui répond **elle-même** « absent » nomme l'absence : un 500,
un 401 ou un silence donnent `fetch_error`.

## Portes

1578 tests bridge, 2521 racine, `npm run typecheck`. **Six passes `/codex:review`**,
**dix corrections** issues des cinq premières, chacune neutralisée et rougissant ses seuls
tests. Deux d'entre elles ont été trouvées par le cliquet **sur moi** au premier passage : ma
dérivation ratait trois helpers en silence, et `validatedVersions` contenait une version sans
contrat.

## Ce que G-58 garde ouvert, dit plutôt que tu

- La **surface WS JSON-RPC** — travail d'AST, la moitié la plus grosse.
- Le **détecteur de drift à l'exécution** (`client.capabilities()` reste appelée nulle part ;
  faut-il que le runtime la lise est une tranche à part).
- Le **lockstep `features`**, jusqu'à ce qu'une contradiction soit possible.
- La vérification amont est **conditionnelle au checkout** : présente en local, absente en CI,
  et le test le **dit** plutôt que de laisser croire à une couverture.
