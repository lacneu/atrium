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

## Ce qui reste à établir sur pièce

**L'export porte-t-il l'appartenance à un projet ?** Aucune source consultée ne
l'affirme de façon fiable ; la réponse se lit sur un export réel, pas sur une
documentation. Elle décide de la reconstitution des dossiers : portée par le
fichier, ou reconstruite autrement.

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

## Ce qui n'est pas fait

Aucune lecture des partages de projet, aucun usage d'identifiants ChatGPT, aucun
contournement de protection anti-robot. Ces trois portes restent fermées, quelle
que soit la commodité qu'elles offriraient.
