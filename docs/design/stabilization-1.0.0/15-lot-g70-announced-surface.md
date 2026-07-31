# Lot G-70 — lire ce que la passerelle annonce sur elle-même

Ferme **G-70** (W9, tranche 2b, point 7). Rend la découverte de protocole **proactive**.

## Le défaut

Les deux passerelles publient la liste de ce qu'elles offrent. OpenClaw annonce son
catalogue d'événements dans `hello-ok.features.events` ; Hermes déclare ses capacités
sur `GET /v1/capabilities`. Atrium lisait la version et le plafond de trame du handshake
et **jetait le catalogue**. Conséquence, visible dans le registre de production : chaque
défaut de trame de juillet a été découvert par un utilisateur qui tombait dessus, jamais
par un test, une alerte ou une garde.

## La mesure qui a décidé de la forme, prise AVANT d'écrire la garde

| | |
| --- | --- |
| Catalogue annoncé à `v2026.7.1` | **30** familles |
| Réellement ALIMENTÉES | **4** — `connect.challenge`, `agent`, `chat`, `shutdown` |
| Annoncées et non lues | **26** |

**Ce chiffre a bougé en passe 4, et c'est le fait le plus utile du lot.** J'avais compté
`session.operation` parmi les traitées : son lecteur existe, est correct, est couvert par
des tests — et n'est **jamais alimenté**. L'événement ne va qu'aux connexions ayant appelé
`sessions.subscribe`, et s'abonner sur la socket qui sert le tour coûtait des trames de
conversation (lot 13, prouvé par bisect au banc). Du code mort affirmait qu'une règle
était tenue là où rien ne la tient.

À 25, une assertion « tout ce qui est annoncé doit être traité » serait **rouge à la
naissance**, donc affaiblie dans la journée : la garde tautologique du lot 25 par une
autre route. Ce qui peut se déclencher pour une vraie raison, c'est l'**exhaustivité de
la classification** — le motif de coverage de W10.

**Ma première dérivation a menti.** Elle cherchait `.event === "…"` et annonçait 4 routés,
ratant `session.operation` comparé via une variable locale. C'est le défaut du lot 47 —
une dérivation qui matche par forme d'appel et perd des sites en silence. D'où le choix
assumé : la classification est un fichier **relu à la main** dont le cliquet vérifie
l'exhaustivité, et non une extraction « intelligente » qui prétendrait à la complétude.

## La chaîne

**En dépôt (CI, sans passerelle ni checkout amont).** Le catalogue est vendorisé par
version, **dérivé** et non copié : une de ses 30 entrées est une constante importée
(`GATEWAY_EVENT_UPDATE_AVAILABLE`), qu'un scrape littéral aurait perdue sans un mot. Le
dérivateur **lève** plutôt que de rendre 29 — un catalogue amputé est pire qu'aucun, le
cliquet bénirait le manque. Le cliquet impose ensuite une bijection avec la
classification : `handled` doit dire `by`, `ignored` doit dire `why`, `gap` **exige** un
`note` disant ce qui n'est pas tenu et ce que ça coûte.

Cela comble au passage l'angle mort laissé par le lot 47 : sa vérification amont était
conditionnelle à un checkout local, donc **absente en CI**, là où les régressions
atterrissent. Ici, le catalogue est dans le dépôt.

**Au runtime.** Le handshake lit `features.events` et ne compte que ce qui est **absent
de la classification entière** — « une passerelle vivante annonce ce que le contrat
vendorisé n'avait jamais anticipé ». Les 26 familles classées `ignored`/`gap` restent
silencieuses : les verser au registre laisserait l'indicateur de sortie n° 3
(« formes en `status:"new"` ⇒ 0 ») rouge en permanence sur du connu, et un indicateur
toujours rouge finit ignoré puis affaibli.

Le capteur est en **capture totale** et son constat vit dans le budget capteur réservé :
une annonce est un compte de 1 le jour où elle compte, elle ne doit pas se faire chasser
du rapport borné par un flot de champs inconnus.

## Ce que le cliquet a produit dès le premier usage

`2026.6.11` annonçait **27** familles, `2026.7.1` en annonce **30** : `task`,
`terminal.data`, `terminal.exit` sont arrivées sans que personne ne les classe. Si ce
cliquet avait existé au moment de vendoriser 7.1, il serait passé rouge sur ces trois-là.
C'est la liste de migration que le mécanisme existe pour produire.

## L'asymétrie Hermes, dite plutôt que maquillée

Hermes ne publie **pas** de catalogue de noms d'événements — il publie des drapeaux
booléens, et Atrium **les lit déjà** (`client.ts`). Il ne manquait donc pas la lecture,
il manquait la **classification**. Mesure, après relecture verdict par verdict en passes 4 et 5 : 24 capacités déclarées,
**19 offertes**, dont **12 consommées par rien** — Atrium n'en consomme que 6. Cet ensemble est NON VIDE, et le vérifier était la
précondition — le lot 47 avait mesuré le lockstep `features` et trouvé une intersection
vide, donc une garde qui ne pouvait jamais se déclencher, donc non construite. La
précondition est gardée **exécutable** : un test échoue si plus aucune capacité
déclarée-vraie n'est inconsommée, car ce cliquet n'aurait alors plus rien à garder.

## Vingt et une lacunes inventoriées, non corrigées — et c'est le but

Le lot ne prétend pas lire les 26 familles. Il rend **impossible d'oublier** qu'on ne les
lit pas. Les plus coûteuses, désormais opposables :

- **`cron` et `task`** — Atrium reconstruit ces faits depuis la complétion d'un outil sur
  le flux `agent`, pas depuis l'événement dédié. Un cron modifié hors appel d'outil est
  invisible.
- **Les quatre approbations** (`exec.*`, `plugin.*`) — c'est exactement ce qui permettrait
  de *nommer* un tour bloqué au lieu de le voir devenir muet.
- **`session_resources`** (Hermes) — une surface de ressources publiée et inutilisée,
  pendant que les fichiers d'agent dégradent en 404 faute du dashboard (lot 47).

## Ce que G-70 ne ferme PAS pour G-69

G-69 dit que 31 des 33 types d'events amont ne sont ni consommés, ni comptés, ni visibles.
G-70 en traite la **visibilité par annonce** : ce que la passerelle déclare est désormais
inventorié et gardé. Restent ouverts, et c'est du G-58 tranche 2+ : la dérive à
l'exécution entre catalogue vendorisé et catalogue annoncé, et le comptage des trames
d'un type non routé qui arriveraient quand même.

## Défauts trouvés en chemin

- **Le même défaut, TROIS fois.** Trois liseurs de répertoires sélectionnaient « tout sauf
  ce qu'on avait pensé à exclure », donc chaque nouveau répertoire frère (`events/`, puis
  `features/`) était lu comme une version. J'ai corrigé les deux qui étaient rouges, et le
  troisième m'a rattrapé au tour suivant, sur l'autre provider. La leçon existait déjà,
  écrite au lot 47 : *une règle appliquée à une porte sur trois n'est pas une règle*. Les
  trois disent désormais qu'une version est ce dont le nom **parse** comme une version.
- **Un journal qui mentait.** Le capteur rapportait « unknown protocol *field* » pour une
  famille d'événements, envoyant un opérateur chercher dans le trafic une trame qui n'est
  jamais arrivée. Le commentaire du code disait pourtant « TROIS constats circulent ici et
  ce n'est pas la même nouvelle » — j'en avais ajouté un quatrième sans étendre le
  branchement.
- **La re-dérivation de `vendor-integrity` était câblée en dur** sur le dérivateur de
  snapshot : appliquée à mon catalogue, elle rapportait « buildSessionEventSnapshot not
  found », ce qui se lit comme un renommage amont et n'en est pas un. Elle dispatche
  désormais par artefact, et un artefact sans re-dérivation câblée **échoue** au lieu
  d'être sauté.
- **Une neutralisation qui n'a pas rougi.** Mon test du budget capteur passait même sans
  la classification capteur : tout était à un exemplaire, l'ordre d'insertion tranchait.
  Le test ne discriminait pas. Corrigé pour que le bruit **surclasse** l'annonce.

## Constats de revue, et le motif qu'ils dessinent

**Neuf constats sur quatre passes, tous réels.** Les deux premières passes ont visé le
mécanisme, la quatrième a visé le **contenu** — et c'est elle qui a trouvé le pire.

**Passe 4 — la classification mentait, trois fois.** Un cliquet prouve qu'un inventaire
est *exhaustif* et *justifié* ; il ne prouve jamais qu'un verdict est *vrai*. Il fallait
donc relire chaque verdict contre le code, et trois étaient faux — tous dans le même sens,
celui qui rassure :

| Entrée | Ce que j'avais écrit | Ce que fait le code |
| --- | --- | --- |
| `session.operation` | `handled` par le normalizer | Lecteur présent et testé, **jamais alimenté** |
| `run_status` (Hermes) | `handled`, polling après perte de flux | Aucun GET de statut n'existe ; la reprise passe par `session.resume` en WS |
| `session_fork` (Hermes) | `handled` par le branchement | Le branchement **copie** l'historique et ouvre une session neuve ; rien n'appelle l'endpoint |

Trois `gap` de plus, et une leçon que le mécanisme ne pouvait pas donner : **un inventaire
faux dans le sens rassurant est plus dangereux qu'une lacune connue**, parce qu'il éteint
la surveillance sur l'endpoint qu'il prétend couvrir.

**Passe 1 — deux constats, tous deux réels.**

1. **Le dérivateur pouvait tronquer en silence** — l'invariant même qu'il existe pour
   tenir. La fermeture du tableau était cherchée par `indexOf("]")`, donc un commentaire
   mentionnant un crochet (`"agent", // see events[] upstream`) coupait le catalogue **et
   rendait une liste non vide**, que le cliquet aurait bénie comme couverture complète.
   Remplacé par un balayage lexical ignorant chaînes et commentaires. En le corrigeant,
   un second défaut est apparu : ne retirer que les `//` par ligne faisait échouer une
   entrée suivie d'un bloc `/* */` — une erreur dure sur un catalogue intact.
2. **Le cliquet Hermes était épinglé à `0.19.0`** : vendoriser une nouvelle version
   l'aurait laissé vert en revérifiant l'ancienne, éteignant la détection de dérive pour
   la version qui vient d'arriver. Il énumère désormais les répertoires.

**Le motif, qui vaut plus que les constats.** Les défauts trouvés dans ce lot sont tous
des **reproductions de leçons déjà écrites dans ce programme** :

| Défaut de ce lot | Leçon déjà consignée |
| --- | --- |
| Ma dérivation ratait `session.operation` | Lot 47 — une dérivation qui matche par forme d'appel perd des sites en silence |
| Le dérivateur tronquait sur un `]` en commentaire | Lot 47 — même leçon, autre mécanisme |
| Cliquet Hermes épinglé à une version | W10/G1 — « épinglé à un seul répertoire, il est passé vert sur une version que personne n'avait examinée » |
| Trois liseurs de répertoires, deux corrigés | Lot 47 — une règle appliquée à une porte sur trois n'est pas une règle |

Écrire une leçon ne suffit pas à ne pas la refaire. Ce qui les a attrapées, ce sont les
**cliquets** et la **revue adverse** — pas la mémoire de celui qui les avait écrites.

## Portes

1619 tests bridge, 2540 racine, `npm run typecheck`, banc live **GO 11/11** avec
attestations re-méritées — la surface vendorisée ayant changé, l'ancienne attestation ne
valait plus, et la garde l'a dit.

## Limites, dites

- La classification est un **jugement**, pas une dérivation. Le cliquet garantit qu'elle
  est exhaustive et justifiée, jamais qu'un `ignored` est le bon verdict.
- Le capteur runtime n'a pas été exercé contre une passerelle annonçant une famille
  inconnue : aucune version disponible n'en annonce hors du catalogue vendorisé. La
  chaîne est prouvée par tests, pas en vrai.
- Le seuil Hermes reste **0.19.0** : une seule version de contrat est vendorisée, donc le
  cliquet Hermes énumère bien les répertoires mais n'en trouve qu'un — il ne compare pas
  encore deux surfaces comme le fait celui d'OpenClaw.
- **Un manifeste manquant fait échouer la COLLECTE**, sur les deux cliquets : la version
  non classée est nommée, mais les autres versions ne sont plus vérifiées dans ce
  passage. C'est bruyant, donc pas silencieux — mais un échec par version serait plus
  juste.
