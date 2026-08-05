# Import de conversations ChatGPT

Un utilisateur qui travaille dans son ChatGPT personnel doit pouvoir reprendre ce
travail dans Atrium : une conversation, ou un dossier entier, deviennent des
conversations Atrium rattachées à un agent, poursuivables comme n'importe quelle
autre.

## Ce que ChatGPT laisse lire

Trois formes d'URL coexistent, et une seule est lisible sans être connecté. La
mesure, faite par requête anonyme :

| URL | Réponse | Lisible par Atrium |
|---|---|---|
| `chatgpt.com/share/<uuid>` | 200, page HTML | oui |
| `chatgpt.com/share/<uuid>.data` | 200, payload structuré | oui |
| `chatgpt.com/g/<projet>/shared/c/<uuid>` | 403 | non |
| `chatgpt.com/g/<projet>/shared/c/<uuid>.data` | 403 | non |
| `chatgpt.com/g/<projet>/project` | 403 | non |

Le partage **de projet** est réservé aux personnes connectées : un serveur ne le
lit pas. Atrium ne cherche pas à passer outre — ni identifiants, ni contournement
d'une protection anti-robot.

Deux limites s'ajoutent du côté du partage public, quand il existe : il fige un
**instantané** à l'instant où il est créé, et il **ne porte pas les fichiers**.

Et surtout, une règle du produit amont décide du reste : **le partage est
désactivé pour une conversation rangée dans un projet**. Il faut l'en sortir pour
le réactiver. La voie du lien ne couvre donc que les conversations laissées à la
racine — pas la façon de travailler de quelqu'un qui organise tout en projets.

## La décision

**L'export officiel des données est la voie principale.** Lui seul couvre les
projets, les conversations qui y sont rangées, l'historique complet et les
fichiers, et il est supporté par l'éditeur — donc stable, là où une page de
partage change de forme sans préavis.

**Le lien de partage public est une voie d'appoint**, pour une conversation isolée
qu'on veut reprendre immédiatement sans attendre l'e-mail d'export.

## L'architecture : un import DEVIENT un fork

La partie difficile est déjà résolue dans le dépôt. `convex/chatFork.ts` crée une
conversation avec un historique repris, **n'attribue aucune session de passerelle**
(`forkPendingRehydration`, pas d'identifiant de conversation fournisseur), et laisse
le premier envoi ouvrir une session neuve : la réhydratation hybride re-fonde alors
l'agent avec un résumé glissant et une fin de conversation verbatim, sous le budget
de contexte de `convex/lib/rehydration.ts`.

Un import matérialise donc les messages, puis **est un fork** : même plafond, même
budget, même re-fondation. « Si la conversation est trop grosse, en faire générer le
résumé » est déjà tenu par ce chemin — un import qui écrirait son propre résumeur
aurait divergé.

Le dossier d'atterrissage est un projet Atrium (`convex/projects.ts`), et l'import
propose les deux cas : une conversation neuve, ou une conversation neuve dans un
projet donné.

## Où l'archive est ouverte

Une archive d'export porte tout l'historique d'un compte, fichiers compris : son
poids n'a rien de commun avec une pièce jointe de conversation, et le backend n'est
pas dimensionné pour l'avaler d'un bloc.

Elle est donc **ouverte dans le navigateur**, sur la machine de la personne qui
l'importe : elle y voit la liste de ses conversations et de ses dossiers, choisit ce
qu'elle reprend, et Atrium ne reçoit que cela. Le poids cesse d'être un problème, et
surtout l'historique complet d'un compte ne traverse pas le réseau pour qu'on en
garde trois conversations.

## Le contrat amont

`conversations.json` est une **troisième surface amont** — après OpenClaw et Hermes
— et se traite comme les deux autres : forme vendorisée dans le dépôt, corpus doré
rejouable, décodeur qui **échoue bruyamment** sur une forme inconnue plutôt que de
deviner. Une surface non documentée qu'on interprète au jugé dérive en silence,
et l'incident se découvre en production.

## Établi sur pièce (export réel, 2026-08-04)

L'archive porte 9 conversations, 27 entrées, et **9 fichiers JSON** dont
`export_manifest.json` qui les inventorie avec leur taille — utile pour valider
une archive avant de la lire.

**L'appartenance à un projet est PRÉSENTE, mais sous une forme qu'il faut savoir
lire.** Aucun champ ne s'appelle `project`, `folder` ni `workspace` : la
recherche sur les noms de champs les donne à zéro. Ce qui la porte :

| Champ | Ce qu'il dit |
|---|---|
| `conversation_template_id` | `g-p-<hex>` quand la conversation appartient à un projet, `null` sinon |
| `memory_scope` | `project_v2` pour ces mêmes conversations, `global_enabled` autrement |

Les deux concordent exactement sur l'export mesuré (3 + 2 conversations réparties
sur deux projets, 4 hors projet). Le préfixe `g-p-` distingue un PROJET d'un GPT
personnalisé (`g-` seul) — c'est cette distinction qui fait de ce champ une
appartenance de dossier et non un simple modèle.

**Ce que l'export ne porte pas : le NOM des projets.** Seul leur identifiant
voyage. Un import peut donc reconstituer les regroupements fidèlement, mais pas
les intituler — le libellé sera demandé à l'utilisateur, ou porté par une
conversation du groupe.

### La forme des messages

L'arbre `mapping` est fait de nœuds `{id, message, parent}` — un arbre, pas une
liste : les branches de régénération y vivent, et un import doit choisir la
sienne (`current_node` remonte la branche affichée).

Un `message` porte `{author, content, create_time, id, metadata}`. Les rôles
observés sont `user` et `assistant`; les `content_type` sont `text`,
`multimodal_text`, et deux formes de RAISONNEMENT — `thoughts` et
`reasoning_recap` — qui représentent 23 % des messages. Elles ne sont pas de la
réponse : un import qui les traite comme du texte fabriquerait une conversation
que l'utilisateur n'a jamais lue.

### Les pièces jointes

Les fichiers sont des `.dat` anonymes ; `conversation_asset_file_names.json` fait
le lien vers leurs vrais noms. Deux paires de 114 Mo et 22 Mo dans cet export
seul confirment la décision d'ouvrir l'archive DANS LE NAVIGATEUR : le poids ne
transite que pour ce que l'utilisateur choisit de reprendre.

`library_files.json` (19 entrées) décrit les fichiers de bibliothèque avec leurs
`context_scopes` — une seconde voie d'attachement, à instruire séparément.

## Décidé (2026-08-04, après lecture de l'export réel)

### Les dossiers sont NOMMÉS par l'utilisateur, à l'import

L'export porte l'appartenance mais pas le libellé : seul `g-p-<hex>` voyage.
Plutôt que d'inventer un nom ou d'en déduire un d'une conversation du groupe —
deux façons de se tromper en silence — **l'écran d'import affiche les groupes
détectés et laisse nommer chacun**.

Cela tombe juste, parce que cet écran existe de toute façon : l'archive est
ouverte dans le navigateur et l'utilisateur y choisit déjà ce qu'il reprend. Le
nom est une colonne de plus sur une décision qu'il prend déjà, pas une étape
ajoutée. Un groupe non renommé garde un libellé neutre dérivé de son rang, jamais
l'identifiant brut — `g-p-67d99058…` n'a de sens pour personne.

Conséquence sur la conception : le décodeur rend des GROUPES (identifiant
d'origine + conversations), pas des projets Atrium. C'est l'écran qui décide de
créer un projet et sous quel nom, et `convex/projects.ts` n'est appelé qu'avec un
libellé fourni. Le décodeur reste pur et sans opinion.

### Les blocs de raisonnement ne sont pas importés

`thoughts` et `reasoning_recap` — 23 % des messages de l'export mesuré — sont
ÉCARTÉS. Ce n'est pas une réponse : c'est la trace de fabrication d'une réponse,
que l'utilisateur n'a pas lue comme telle et dont il n'a jamais demandé la
reprise. Les importer gonflerait la conversation d'une matière qu'il ne
reconnaîtrait pas, et surtout la ferait payer deux fois — au stockage, puis au
budget de contexte de la première réhydratation.

Conséquence sur la conception : le filtrage est une DÉCISION DU DÉCODEUR, pas un
masquage d'affichage. Ce qui est écarté ne doit jamais entrer. Le décodeur
travaille donc sur une liste EXPLICITE de `content_type` repris (`text`,
`multimodal_text`), et **échoue bruyamment sur un type inconnu** plutôt que de
choisir à notre place — même règle que les deux autres surfaces amont : une
forme non reconnue s'arrête, elle ne se devine pas.

## Points identifiés, à traiter dans le lot

- **Le choix de l'agent se fait à la création, pas après.** `createChat` lie
  l'agent au moment où la conversation naît, et `rebindChatAgent` refuse ensuite
  dès qu'un message existe. Une conversation importée en porte immédiatement :
  l'agent — donc le fournisseur, OpenClaw ou Hermes — se choisit dans la boîte de
  dialogue d'import et se lie à la création. Le sélecteur par tour reste offert
  ensuite, comme sur une conversation ordinaire, mais l'import ne doit pas
  compter sur une re-liaison après coup.
- **Des messages qui ne sont pas des tours.** Un message importé n'a ni run, ni
  usage, ni passerelle. Les surfaces qui supposent le contraire — jauge d'usage,
  jauge de contexte, export, anomalies — se vérifient une par une.
- **L'URL est une entrée utilisateur** (voie d'appoint) : hôte épinglé, chemin
  contraint, redirections inter-hôtes refusées.
- **SOC2** : le contenu importé est du contenu conversationnel. Les traces ne
  portent que des comptes, des longueurs et des états.
- **Les fichiers** de l'export ont un poids et un format propres ; leur reprise se
  décide séparément de celle du texte.
- **La branche à reprendre.** `mapping` est un arbre : une régénération laisse
  les deux versions. `current_node` remonte celle qui était affichée — c'est
  celle-là qui est reprise, parce que c'est la conversation que l'utilisateur a
  eue. Les branches abandonnées ne sont pas de l'historique perdu : elles n'ont
  jamais fait partie du fil qu'il a lu.

## Ce qui n'est pas fait

Aucune lecture des partages de projet, aucun usage d'identifiants ChatGPT, aucun
contournement de protection anti-robot. Ces trois portes restent fermées, quelle
que soit la commodité qu'elles offriraient.
