# Lot — une conversation ouverte sur une passerelle en panne n'est plus un cul-de-sac

Rapport de production, 31/07/2026. Un utilisateur ouvre une conversation, choisit un
agent dans le dialogue de création sans savoir que la passerelle de cet agent ne répond
pas, et se retrouve devant un composeur entièrement grisé — **sélecteur d'agent
compris**. La seule sortie était de supprimer la conversation.

## Le défaut

Deux verrous indépendants, un seul piège.

1. Le sélecteur d'agent était désactivé par `unavailable`, c'est-à-dire par la
   condition même qu'il sert à résoudre. C'est le contrôle qui décide **où** part
   l'envoi ; le fermer quand l'envoi est impossible retire la seule issue.
2. Il était aussi fermé sur toute conversation sans tour utilisateur — et ce
   second verrou n'était pas gratuit. L'agent est lié **à la création**, et la règle
   d'envoi ne route jamais le tour 1 (`resolveRoutedAgentToSend`). Ouvrir le sélecteur
   sans plus aurait remplacé « bloqué mais visible » par « a l'air normal, et c'est
   l'agent qu'on vient de quitter qui répond ».

## La correction

Le sélecteur a désormais un **mode**. Sur un fil qui n'a rien dit, il **relie** la
conversation (`rebindChatAgent`) ; dès qu'il y a un tour, il route comme avant.

`resolveAgentSelectorGate` porte cette décision comme prédicat pur : il prend
`unavailable` et `readOnly` en entrée et ne laisse délibérément ni l'un ni l'autre
fermer un mode utilisable — c'est ce que les tests épinglent par neutralisation.

`rebindChatAgent` est gardée sur « **aucun message**, pas « aucun tour utilisateur » :
l'attribution d'un message sans estampille de routage retombe sur l'agent primaire de
la conversation, donc relier sous du contenu existant réétiquetterait qui a parlé.
L'écriture est déléguée à `bindChatTarget`, seul endroit qui sait aussi lâcher
l'identifiant de conversation amont devenu périmé.

L'opacité de désactivation est appliquée **frère par frère** : l'opacité CSS groupe
tout son sous-arbre, donc une règle posée sur un ancêtre n'aurait pas pu être relevée
sur le sélecteur.

## Lacunes assumées

- **Un fil assistant seul** (une annonce spontanée, aucun tour utilisateur) reste
  fermé : un rebind pourrait y réétiqueter des messages sans estampille. Lacune
  préexistante, conservée étroite.
- **Une conversation en lecture seule qui a déjà des tours** reste fermée : un choix
  par tour ne lèverait pas le verrou, qui se calcule sur la liaison.
- **Le dialogue de création n'indique pas l'état des passerelles.** C'est la moitié
  « rendre impossible » du défaut : ici on donne la sortie, on n'empêche pas encore
  l'entrée.

## À FAIRE — précondition de liaison sur le premier envoi

C'est la moitié fermante du défaut, pas un confort.

Le composeur retient l'envoi tant qu'un rebind est en vol, mais cette retenue est
**locale à un composeur**. Deux surfaces sur la même conversation vide peuvent encore
s'entrelacer : l'onglet B lance son premier envoi vers l'agent A, l'onglet A relie vers
B pendant que la requête est en transit, et l'envoi atterrit ensuite. Le tour 1 ne porte
volontairement aucun `routedAgent`, donc il se résout sur la liaison **courante** et
c'est le nouvel agent qui répond, sans rien dire à l'émetteur.

Fermer proprement demande de donner à `sendMessage` une précondition — la génération de
liaison que le client affichait — et de refuser atomiquement quand elle ne correspond
plus. C'est une modification du chemin le plus chaud de l'application ; elle mérite son
propre lot.
