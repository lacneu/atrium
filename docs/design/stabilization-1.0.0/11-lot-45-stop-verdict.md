# Lot 45 — le Stop rend un verdict, et une session non interrompue n'est plus reprise

Ferme **G-41** (W6) et le report enregistré comme « un Stop pendant le silence laisse la
session jamais déclarée non fiable » : c'est le même mécanisme vu de deux côtés.

## La mesure amont (Hermes v2026.7.20)

Sur le transport REST, `POST /v1/runs/{id}/stop` est un **404 garanti**, pas un 404
occasionnel :

| Fait | Source |
| --- | --- |
| `/api/sessions/{id}/chat/stream` mint son propre `run_id` | `gateway/platforms/api_server.py:2534` |
| …et l'enregistre dans `_background_tasks`, jamais dans `_active_run_agents` / `_active_run_tasks` | `:2609-2613` |
| `_handle_stop_run` ne consulte que ces deux maps avant de répondre 404 `run_not_found` | `:5285-5289` |
| Le handler ne passe **pas** `agent_ref`, donc rien ne peut atteindre `agent.interrupt()` | comparer `:2570-2582` à `:2856-2875` (`/v1/chat/completions`) et `:3939-3968` (`/v1/responses`) |
| `_run_agent` exécute `run_conversation` dans un **thread executor** — `task.cancel()` ne l'arrête pas | `:4650-4700` |
| L'interruption sur déconnexion existe… sur les routes sœurs seulement | `:3151-3162` |
| Le thread va au bout et **persiste le tour**, « on any exit path » | `agent/turn_finalizer.py:322`, `run_agent.py:1721` |
| Le tour suivant relit ce transcript | `api_server.py:2223-2231` |

**Conséquence utilisateur** : après un Stop, le tour suivant héritait d'une réponse jamais
vue et crue annulée.

## Ce que le lot corrige

`stopRun` rend un **verdict** au lieu d'avaler son résultat :

- `interrupted` — le fournisseur a confirmé. La session est gardée.
- `ineffective` — **preuve** que rien n'a été arrêté (404 `run_not_found`, ou aucun `run_id`
  à nommer donc rien de demandé). Structurel et constant sur REST.
- `unknown` — on n'a pas pu savoir (réseau, timeout, 5xx). Rare, et sur WS n'implique même
  pas que l'interruption a échoué.

**Une seule conséquence** : tout sauf `interrupted` purge la session provider. Les trois
noms restent distincts pour la triage a posteriori, pas pour se comporter différemment.

La purge a **deux couches et deux porteurs** :

1. *durable, primaire* — `clearProviderSession` sur le finalize garanti de `dispatchAbort`,
   donc atomique avec le terminal avorté (règle du lot 31), nommée par l'id que **Convex
   détient** ;
2. *durable, secours* — `applyDurableSessionDrop` écrit depuis le bridge avant de répondre,
   pour que la garantie ne dépende pas de la survie d'une réponse HTTP ;
3. *cache* — `registry.forgetChat`, sans quoi `selectPriorSession` retombe sur la mémoire du
   processus et rend la session dans le tour suivant ;
4. *liaisons en vol* — `markSessionUntrusted` puis une attente bornée à 2 s, pour que l'id
   nommé soit celui que Convex tient et non celui qu'il est sur le point de tenir.

L'ordre, sur les **deux** transports : marquer → **couper localement** → attendre les
liaisons → lire l'id → interrompre à distance → évincer le cache. La coupe avant l'attente
n'est pas cosmétique : l'inverse laissait un terminal fournisseur finaliser le message
`complete` pendant la fenêtre, donc un Stop rendait une réponse finie.

## Résidus, dits plutôt que tus

- **La facturation et les effets de bord des outils continuent** sur REST après un Stop.
  Atrium ne peut pas les arrêter.
- La réhydratation est **refusée** quand des pièces jointes montent, en l'absence de
  `messageId`, ou knob coupé. Un Stop sur un tel tour perd donc la continuité côté serveur.
- Si Convex tient encore l'ancienne session pendant qu'une rotation vient d'être décidée et
  que son écriture a été abandonnée, la purge nomme l'ancienne — correct, et l'éventuelle
  session tournée-away échoue à la reprise puis se répare par `freshText`.

## La vraie correction, en vague à part

Migrer le transport REST vers **`POST /v1/runs` + `GET /v1/runs/{id}/events`**. Prémisse
vérifiée : `/v1/runs` accepte `session_id` (`:4851`), enregistre l'agent dans
`_active_run_agents` (`:4926`), et son stop fonctionne. Bloqueurs : vocabulaire d'événements
différent (`message.delta`, `run.cancelled` au lieu de `assistant.delta`,
`assistant.completed`, `run.completed`), flux en deux appels, validation au banc obligatoire.

L'asymétrie est donc un **choix de route**, pas une limite de Hermes — ce qui fait de la
migration la vraie correction et de ce lot le confinement honnête.

## Déploiement

`npx convex deploy` **avant** l'image bridge : ce lecteur est le seul consommateur du
verdict, donc un bridge neuf devant un Convex ancien le rapporte à personne. Sûr dans les
deux sens (la fenêtre est le défaut préexistant, jamais un nouveau), mais déployer à
l'envers ne livre rien.

## Portes

1506 tests bridge, 2514 racine, `npm run typecheck`. Quatre passes `/codex:review` jusqu'à
une passe propre. Chaque correction neutralisée rougit ses seuls tests, dans les deux sens
quand le garde discrimine.
