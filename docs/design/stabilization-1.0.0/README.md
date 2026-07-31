# Programme de stabilisation 1.0.0

Ce répertoire porte le registre du programme de stabilisation d'Atrium : l'inventaire
des lacunes, les reconnaissances qui les ont établies, et la note de chaque lot livré.

Il vit dans le dépôt pour une raison précise : **un inventaire faux est pire qu'aucun**.
Tant que l'état du programme était tenu hors du code, il dérivait — des lacunes closes
restaient listées ouvertes, et une note d'état jamais re-dérivée depuis la source devient
un piège. Ici, il se relit et se corrige avec le code qu'il décrit.

## Ce qu'on lit en premier

| Document | Ce qu'il porte |
| --- | --- |
| [00-programme-1.0.0.md](00-programme-1.0.0.md) | Le registre : vagues de travail, lacunes numérotées (`G-nn`), état de chacune, et le lot qui l'a close |
| [10-registre-prod.md](10-registre-prod.md) | Les défaillances observées en production qui ont ancré la priorisation |
| [09-critique-completude.md](09-critique-completude.md) | La critique adverse du programme lui-même : ce qu'il ne couvre pas |

## Les reconnaissances

Chacune établit un fait vérifiable dans la source amont ou dans le code d'Atrium, pas une
impression. Elles sont datées de leur version amont et se relisent à ce titre.

| Document | Zone |
| --- | --- |
| [01-openclaw-emission.md](01-openclaw-emission.md) · [02-hermes-emission.md](02-hermes-emission.md) | Ce que chaque passerelle émet réellement |
| [03-atrium-openclaw-handling.md](03-atrium-openclaw-handling.md) · [04-atrium-hermes-handling.md](04-atrium-hermes-handling.md) | Ce qu'Atrium en fait |
| [05-context-overflow.md](05-context-overflow.md) | Le débordement de contexte |
| [06-ordering-concurrency.md](06-ordering-concurrency.md) | Ordre des trames, concurrence, conflits de session |
| [07-version-process.md](07-version-process.md) | Le processus de support d'une version de passerelle |
| [08-unknown-frames.md](08-unknown-frames.md) | L'auto-découverte des trames non traitées |

## Les notes de lot

Une note par lot livré : le défaut, la mesure qui l'a établi, la chaîne de correction, les
constats de revue, et — systématiquement — les limites qui restent.

- [11-lot-45-stop-verdict.md](11-lot-45-stop-verdict.md) — le Stop rend un verdict
- [12-lot-46-version-awareness.md](12-lot-46-version-awareness.md) — le transport par défaut apprend sa version
- [13-lot-47-rest-surface.md](13-lot-47-rest-surface.md) — trois serveurs amont, un seul publie un contrat
- [14-lot-48-lost-reply.md](14-lot-48-lost-reply.md) — rendre au tour perdu sa réponse
- [15-lot-g70-announced-surface.md](15-lot-g70-announced-surface.md) — lire ce que la passerelle annonce sur elle-même
- [16-lot-agent-dead-end.md](16-lot-agent-dead-end.md) — sortir d'une conversation ouverte sur une passerelle en panne ; **à faire** : précondition de liaison sur le premier envoi
- [17-lot-cron-delivery-verdict.md](17-lot-cron-delivery-verdict.md) — une tâche porte le verdict de livraison de sa dernière exécution ; **à faire** : l'atterrissage du compte rendu

## Conventions

Les documents sont **anonymisés** : les instances portent des noms génériques
(`client-1`, `client-2`), les chemins hors dépôt sont notés `<hors-dépôt>/…`, et aucun
contenu conversationnel n'y figure — les mesures citées sont des comptes, des longueurs,
des énumérations et des noms de champs.
