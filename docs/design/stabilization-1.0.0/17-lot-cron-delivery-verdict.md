# Lot — un compte rendu programmé qui n'a atteint personne se lit sur la tâche

Suite directe du lot précédent sur les crons, et deuxième moitié d'une promesse faite
à un utilisateur en production : *« qu'un compte rendu de tâche programmée qui ne peut
pas être livré atterrisse dans la conversation qui l'a créée »*.

## Ce que ce lot fait

Le planificateur amont maintient le verdict de livraison **sur la tâche elle-même**
(`CronJobState.lastDelivered`, `lastDeliveryStatus`, `lastDeliveryError`,
`lastRunAtMs`), et pas seulement dans l'historique des exécutions. Atrium gardait
`lastRunStatus` de ce même bloc d'état et jetait les quatre champs voisins.

Conséquence pratique : la seule façon de remarquer qu'un rapport s'était perdu était
d'ouvrir l'historique d'une tâche à la main, une par une. Avec ces champs, **un seul
appel `cron.list` par instance** répond à « quelles tâches n'ont livré leur dernier
compte rendu à personne ». C'est ce qui rend un balayage périodique abordable au lieu
de coûteux — la détection ne demande plus de parcourir l'historique de chaque tâche.

## La règle qui porte le lot

`null` n'est pas `false`. Une passerelle qui ne dit rien de la livraison ne doit pas
faire paraître toutes les tâches en échec — et une tâche qui, **volontairement**, ne
livre nulle part (`delivery.mode: "none"`) n'est pas une défaillance. Un signal qui
s'allume toujours finit ignoré, puis affaibli.

Le booléen est donc **strict** aux deux étages : `"false"`, `0`, `null` et un objet
sont tous refusés et ramenés à « non dit ». Une coercition ferait passer une
exécution correctement livrée pour perdue.

## Le maillon qu'on oublie

Le fait traverse **cinq** maillons successifs, et chacun re-type ce qu'il garde :
`normalizeCronJobDetail` et `fetchCronJobs` côté bridge, puis `detailFrom`,
`parseCronListResponse` et `listCronRuns` côté Convex — ces trois derniers **jettent
tout ce qu'ils ne nomment pas**.

La première version de ce lot en a corrigé deux, a écrit dans son propre message de
commit que « le maillon qu'on oublie » était le danger, et s'est arrêtée avant la
**liste** — l'unique écran qu'un opérateur balaie. Une tâche dont le compte rendu
s'était perdu y affichait toujours « OK ». L'historique d'exécutions avait le même
trou, hérité d'un lot antérieur. Énoncer la leçon ne l'applique pas.

Ce qui suit décrit les deux premiers maillons, et chacun re-type ce qu'il garde :
`normalizeCronJobDetail` côté bridge, puis `detailFrom` côté Convex, qui **jette tout
ce qu'il ne nomme pas**. Un champ transporté fidèlement par le premier meurt
silencieusement dans le second. C'est exactement la leçon du lot G-70 : *une chaîne ne
fait que la longueur des maillons que quelqu'un a vérifiés*.

La branche Hermes épelle les quatre champs à `null` explicitement : cette passerelle
n'a pas de `cron.get` par tâche et son listing ne porte aucun état de livraison. Les
laisser absents aurait laissé un champ manquant se lire comme un verdict.

## Le motif brut de la passerelle : jugement assumé

La revue croisée a signalé `lastDeliveryError` comme une voie de fuite possible : c'est
une chaîne libre (`Type.String` au contrat, sans classification), et un fournisseur
pourrait y glisser une destination ou un identifiant.

Vérifié plutôt que supposé : ce champ **n'atteint ni les traces ni les anomalies** — les
surfaces où la règle « jamais de contenu, seulement des comptes, des longueurs et des
noms de champs » s'applique. Il ne vit que sur les écrans cron, qui affichent déjà le
**prompt de la tâche elle-même** (jusqu'à 4000 caractères) : ce sont des surfaces de
contenu du propriétaire, pas des surfaces de métadonnées, et le listing est cadré aux
agents auxquels l'appelant a droit.

Le motif est par ailleurs la seule partie **actionnable** : « non livré » sans cause ne
donne rien à corriger. Il est borné à 400 caractères aux deux étages. Décision : on le
garde tel quel sur ces écrans, et on ne le laisse pas migrer vers l'observabilité.

## À FAIRE — l'atterrissage lui-même

Ce lot livre la **détection**. Ce qui reste est la livraison : un balayage lent qui,
pour chaque tâche dont le dernier compte rendu n'a atteint personne, dépose ce compte
rendu **une seule fois** dans la conversation qui l'a créée.

Trois points sont déjà tranchés et doivent être respectés :

1. **L'idempotence est une clé stockée**, pas une recherche. Chaque exécution porte un
   `runId` ; c'est lui qui doit garantir l'unicité. Décider « déjà déposé ? » en
   cherchant le texte dans la conversation republie après une édition et se trompe
   après une troncature.
2. **`ownerSessionKey` se valide, ne se devine pas.** La forme
   `agent:<id>:atrium:chat:<canonical>:<chatId>` est une **convention**, et le même
   champ porte `agent:<id>:cron:<jobId>:run:<uuid>` pour une exécution isolée. Prendre
   le dernier segment y renverrait un UUID. Il faut résoudre l'identifiant contre la
   table des conversations et **refuser** l'exécution s'il ne résout pas : un compte
   rendu qui atterrit dans la mauvaise conversation est pire qu'un compte rendu qui
   n'atterrit pas. La propriété de la conversation doit être vérifiée en plus.
3. **Le message doit se lire comme une livraison tardive du système**, pas comme
   l'agent qui parle maintenant. La provenance ambiguë d'une bulle est déjà ce qui a
   rendu l'épisode d'origine illisible pour l'utilisateur.

Une alternative existe et relève d'une décision produit, pas d'un choix technique : le
contrat amont expose `completionDestination` / `failureDestination` (`mode: "webhook"`).
Y pointer Atrium supprimerait le balayage — mais cela suppose de **réécrire les tâches
de l'utilisateur**, ne rattrape pas les tâches existantes, et demande une URL publique.
Noté, non engagé.
