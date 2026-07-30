# Lot 46 — le transport par défaut apprend sa version, et la version décide

Ferme **G-55** (W12). Ouvre la vague W12, dont le motif de report (« aucune instance Hermes
en production ») est mort depuis la décision produit du 28/07.

## Ce qui était faux, dit avec précision

La lacune écrite affirme « tout le manifeste compat Hermes est du code mort ». C'est plus
juste que ça, et la nuance a décidé de la forme des tests.

**Deux moitiés, la seconde plus profonde :**

1. `discoverHermesAgents` rendait `gatewayVersion: null` **en dur** sur la branche WS — le
   transport par défaut — alors que la branche REST juste en dessous lisait `health.version`.
   Le motif inscrit dans le code (« `hermes serve` n'a pas de `/health` ») est vrai et hors
   sujet : la version est **sur le fil**. `session.info` la porte
   (`info["version"] = __version__`, `tui_gateway/server.py:3851`, et `__version__`
   n'apparaît nulle part ailleurs dans ce fichier), et le lecteur WS parse déjà cette trame
   pour `stored_session_id`, `model`, `usage` et `cwd`.
2. `applyHermesTransportOverlay` accordait ensuite **tout** le jeu de capacités du transport
   avec un `true` à plat, avec **une** capacité (`abort`) pour proxy de version. Comme le
   minimum d'`abort` **est** le plancher de la plage, ce proxy passe pour toute version dans
   la plage : aucun `minVersion` par capacité ne décidait de quoi que ce soit.

**Donc rien n'était MAL gaté** — tous les minimums Hermes valent le plancher aujourd'hui. Le
mécanisme était **inerte**, et il aurait continué d'accorder au premier minimum relevé, ce
qui est exactement la raison d'être d'un cliquet. Ce qui était faux côté utilisateur : toute
instance Hermes WS rapportait une version **inconnue** à la vue admin, et la bannière
beyond-validated ne pouvait jamais s'allumer.

**Constat lié, à garder en tête** : le gate d'attestation est alimenté par le **banc**
(`--expect-hermes-version`), pas par le bridge. L'attestation 0.19.0 gagnée au lot précédent
certifiait donc une version que le chemin de production ne pouvait pas observer.

## Une règle, trois portes

`readHermesGatewayVersion(raw, site)` est le seul endroit où la question « est-ce une version
que nous savons lire ? » est tranchée. Les trois portes y passent :

| Porte | Source | Quand |
| --- | --- | --- |
| `session.info` | l'événement WS | à chaque tour |
| `/health` | la découverte REST | à chaque poll |
| `gatewayVersionFallback` | la config opérateur | démarrage à froid |

La règle : semver strict **plus** un majeur au plus égal à celui de `maxValidated` + 1.
Hermes publie **deux schémas pour un même build** — le semver de `pyproject` (`0.19.0`) et le
tag git (`v2026.7.20`) — et un majeur calendaire parse comme un semver parfaitement valide
tout en se comparant comme astronomiquement au-delà de tout ce qui a été validé (G-57). Un
majeur suivant légitime passe et s'annonce honnêtement beyond-validated ; un majeur plus
lointain échoue **fermé** et résout au plancher. Un refus est **observé** via
`protocolDrift`, jamais avalé.

## Qui croire, et quand une observation en retire une autre

`resolveInstanceVersion(observed, snapshot, configured)` : un tour qui a **regardé** est
autoritaire, y compris quand il a regardé et n'a pas su lire. Sinon le snapshot du poll, puis
la config.

La question la plus fine du lot, et elle vient de la source : **quel constructeur a envoyé la
trame ?** `session.info` en a deux. `_session_info` est le complet et porte **toujours**
`version` (chaîne vide quand son import échoue — ce qui **est** une réponse : on ne sait
plus). Les constructeurs allégés — session sans agent encore — envoient
`{cwd, branch, project, lazy: true}` et ne disent rien de la version. `_session_info` ne pose
**jamais** `lazy`, et les cinq émetteurs allégés le posent tous : le drapeau les distingue
exactement.

Les deux directions portent. Retirer sur une trame allégée ferait clignoter la version vers
« inconnue » plusieurs fois par session ; ne pas retirer sur une trame complète qui a cessé
de porter le champ laisserait publier une version que la passerelle ne confirme plus — avec
son jeu de capacités, sa bannière et ses gates.

**La version n'est PAS invalidée à la fermeture de socket** : la dernière observée reste la
meilleure information jusqu'à ce qu'un nouveau tour dise autre chose, et l'invalider
renverrait `/capabilities` à « inconnu » et au plancher à chaque reconnexion.

## Démarrage à froid, assumé

Un bridge qui n'a joué aucun tour et dont `/health` ne répond pas rapporte `null`. C'est
l'état honnête, pas la valeur codée en dur qu'il remplace.

## Portes

1541 tests bridge, 2514 racine, `npm run typecheck`. **Six passes `/codex:review`** jusqu'à
une passe propre ; chaque correction neutralisée rougit ses seuls tests, dans les deux sens
quand la règle discrimine. Une neutralisation a révélé qu'un de mes propres tests ne
discriminait pas son cas (`/health` joignable sans champ `version`) — il est désormais pinné.

Un constat de revue a été **rejeté avec la source** : classer le 2xx `stopping` du lot
précédent en `unknown`. Un autre a été **accepté dans son diagnostic mais pas dans sa
correction** : appeler le callback à chaque `session.info` aurait retiré une bonne observation
sur chaque trame allégée.

## Reste de W12

**G-56** (`DESKTOP_BACKEND_CONTRACT`, passé de 2 à 4 entre 0.18.2 et 0.19.0, absent d'Atrium),
**G-58** (aucun contrat Hermes vendored, aucun coverage, aucun cliquet, aucun détecteur de
drift — le seul artefact sous `bridge/protocol/hermes/` est `0.19.0/BENCH.json`) et **G-74**
(le contrat de conception affirme des choses non tenues). G-56 est un lot à part : le contrat
arrive sur `session.create` et `session.info`, donc côté **tour**, alors que
`inboundAttachments` est déclarée au moment de la **découverte** — le gater demande son propre
design, à l'usage plutôt qu'à la déclaration.
