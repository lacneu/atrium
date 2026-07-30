# Lot 48 — rendre au tour perdu la réponse que la passerelle avait finie

Ferme **G-47**, la dernière lacune de **W7**.

## Le défaut

Le transport lâche pendant un tour. Atrium règle la bulle en erreur et — ne pouvant pas
répondre de la session — la purge (lots 30/31). Mais la passerelle, elle, a très bien pu
**finir la réponse** : elle la garde dans `inflight`. Personne ne la lisait jamais.

## Pourquoi la première tentative a été annulée, et ce qui a changé

Ce lot a été **écrit, testé vert, puis annulé avant commit** le 28/07 : ses tests posaient un
état initial que la production ne produit jamais. Deux bloqueurs, tous deux levés par
**mesure amont** cette fois, pas par intuition :

| Bloqueur | Levée |
| --- | --- |
| Le terminal PURGE la session, donc plus rien à reprendre | La poignée de récupération est **distincte** d'`openclawChatId` — lecture seule, jamais reprise par le sélecteur |
| La mutation exigeait que le dernier message soit l'assistant, or `send` insère la ligne **utilisateur** avant de dispatcher | La poignée **nomme son message**, enregistré à l'instant où la réponse a été perdue. Aucune heuristique de « dernier message » nulle part |

## Deux faits mesurés qui décident du périmètre

1. **Joignabilité, énumérée.** Parmi les terminaux qui purgent la session, **deux** peuvent
   laisser une réponse complète : le silence (`response_timeout`) et le transport perdu. Le
   Stop non honoré et le `/reset` purgent aussi et n'enregistrent **rien** — l'utilisateur a
   annulé, récolter son texte serait un contresens. `correlation_lost` est exclu et dit comme
   tel : une voie qu'on n'a pas su attribuer est un terrain plus faible qu'un tour qu'on a
   simplement cessé d'entendre.
2. **La garde est une porte, pas un fait périmé.** `session.resume` sur une session **vivante**
   répond par `_reuse_live_payload` — instantané live, `running: true` — **sans rien
   ré-attacher**. C'est ce qui rend défendable la lecture d'une session que le lot 30 interdit
   de *reprendre*. S'y ajoute `inflight.streaming`, le signal de l'amont qui distingue un texte
   encore en production d'une réponse finie.

## La chaîne

**Aller** — les deux terminaux éligibles posent le drapeau ; il traverse sink → writer →
ingest ; le `finalize` enregistre `{session, messageId, at, instanceName, resetCount}` **dans
le même patch que la purge** (règle du lot 31 : un écrit séparé peut échouer seul).

**Retour** — `getChatRouting` ne transmet la poignée que si **l'instance** et **l'époque**
correspondent ; elle traverse le POST `/send` et son parseur ; le bridge fait une lecture
unique ; le texte revient au message **nommé**.

## Cinq constats de revue, et le dernier était LE constat

1. La poignée n'était dépensée que sur une récolte **réussie** — or les refus sont le cas
   normal, donc chaque envoi repayait un `session.resume`.
2. Elle n'était **pas liée à son instance d'origine** : un id de session est *gateway-local*,
   et un rebind aurait demandé à B de reprendre l'id de A.
3. **Un `/reset` ne la révoquait pas** : l'utilisateur abandonnait un tour et le voyait
   revenir. Corrigé par l'**époque** plutôt que par une suppression de plus, pour qu'aucun
   futur chemin de purge ne puisse oublier de la révoquer.
4. La récolte **ouvrait une fenêtre** où un `/reset` concurrent n'était plus honoré — le siège
   est réservé mais aucun run n'y est encore lié, donc l'abort n'a rien à arrêter.
5. **`parseSendBody` reconstruisait le corps SANS la poignée.** La fonctionnalité ne tournait
   donc **que dans mes tests**, qui appelaient `performHermesSend` directement — exactement la
   faute qui avait fait annuler la v1, revenue par une autre porte. *Une fonctionnalité qui ne
   marche que dans les tests n'est pas une fonctionnalité.*

## Deux neutralisations qui n'ont pas rougi, et ce qu'elles ont appris

- La vérification « récolte vide » était **réellement redondante** avec la garde
  anti-rétrécissement (aucun texte n'est plus court que rien). **Code mort retiré** — du code
  mort affirme qu'une règle est tenue là où rien ne la tient.
- La garde `running` était **masquée par mon propre test**, qui la couplait à `streaming`. Les
  deux drapeaux sont indépendants ; le test isole désormais l'état et la garde rougit.

## Portes

1589 tests bridge, 2538 racine, `npm run typecheck`. Chaque correction neutralisée rougit ses
seuls tests.

## Limites, dites

- La récupération se déclenche au **dispatch suivant**. Si l'utilisateur ne renvoie rien, la
  réponse reste perdue — un déclencheur à l'ouverture du chat serait un autre lot.
- Le transport **REST** n'est pas couvert : `inflight` n'existe que sur la surface WS.

## Validation live locale (2026-07-30, banc `hermes-bench` 0.19.0)

**Prouvé en vrai :**

| Maillon | Preuve |
| --- | --- |
| Le terminal de silence écrit la poignée | `chats.recoverableSession = { at, instanceName: "hermes", messageId, resetCount: 1, session: "20260730_223144_de2809" }` — tous les champs, y compris les deux gardes ajoutées en revue |
| La poignée est transmise puis **dépensée** | après l'envoi suivant, le champ a disparu du chat : la lecture est bien one-shot, ce que la passe 1 de revue avait exigé |

**NON prouvé en vrai : la récolte d'un texte réel.** Trois tentatives, chacune bloquée par
l'environnement et non par le code :

1. **`docker pause`** — gèle aussi l'appel au modèle. Journal de la passerelle au dégel :
   `⚡ Interrupted during API call.` Le tour n'a jamais fini, donc `inflight` n'avait rien de
   complet à rendre. **La précondition du lot n'était pas reproduite.**
2. **Proxy TCP intercalé** (couper la socket sans toucher la passerelle) — l'URL de
   l'instance est figée dans Convex et la repointer demande une mutation d'administration
   authentifiée. Le proxy a été monté puis retiré.
3. **Appel direct de `harvestLostReply` sur une session terminée** — l'identifiant WS du
   dashboard est un secret d'instance **chiffré dans Convex**, illisible depuis l'extérieur ;
   le jeton du conteneur est refusé (401/403).

**Constat de conception au passage** : sur un chat en routage **par tour**,
`chats.openclawChatId` porte le segment `turn:…` et non la session Hermes — la purge durable
y est donc un no-op par construction (garde de forme d'id), et c'est l'éviction du cache
bridge qui fait le travail. Cohérent, mais cela veut dire que la conséquence « session
lâchée » ne s'observe pas sur ce champ pour ces chats.

**Ce qu'il faudrait pour finir** : un proxy TCP entre bridge et passerelle, ce qui suppose de
pouvoir repointer l'instance (mutation admin authentifiée), ou un identifiant Hermes lisible
pour parler à la passerelle depuis un script.
