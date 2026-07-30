# Zone 05 — Le débordement de contexte (`Context overflow: prompt too large for the model`)

Audit en LECTURE SEULE. Sources réelles :

- Atrium : `<workspace>/atrium` (branche `main`, `ed7bf5d`)
- OpenClaw amont : `.../scratchpad/upstream/openclaw` @ tag **v2026.7.1** (`git describe` = `v2026.7.1`)
- Hermes amont : `/tmp/hermes-upstream.okb8T2` @ tag **v2026.7.20** (grafted). **Aucun tag `0.18.2` / `0.19.0` n'existe** dans ce dépôt : les tags sont datés (`v2026.3.12` … `v2026.7.20`, 28 tags). La « version 0.18.2 » validée par Atrium est la version du **paquet `hermes-agent`**, pas un tag du dépôt → comparaison 0.18.2 vs 0.19.0 **NON PROUVABLE** avec ce checkout (voir §9).

Convention : chaque affirmation porte `fichier:ligne`. Ce qui n'est pas prouvable est marqué **NON PROUVÉ** avec la lecture qui trancherait.

---

## 0. Verdict en une page

Le symptôme `Context overflow: prompt too large for the model.` que voient les clients est **le message terminal d'épuisement de la récupération overflow** du gateway (`run.ts:3032-3035`). Il n'est pas produit par Atrium : Atrium le reçoit en texte, le classe `context_length`, et affiche une carte d'erreur actionnable.

La chaîne amont possède **cinq étages de défense**. Dans le déploiement client (context engine externe LCM / lossless-claw qui déclare `ownsCompaction: true`), **trois des cinq sont désarmés par construction** :

| Étage | Rôle | État sous `ownsCompaction: true` |
|---|---|---|
| A. Compaction auto du runtime (dans `Session.prompt()`) | garde-fou natif | **DÉSACTIVÉE** — `agent-settings.ts:174-184` |
| B. Precheck pré-prompt (estimation + routage compaction/troncature) | garde pré-vol | **COURT-CIRCUITÉ** — `attempt.ts:4843-4853` |
| C. Garde mi-tour (après chaque tool result) | garde intra-boucle | **OFF PAR DÉFAUT** (config) — `attempt.ts:2729-2730`, `schema.help.ts:1531-1532` |
| D. Compaction preflight pré-réponse (seuil) | garde inter-tours | **ACTIVE**, mais alimentée par un compteur non fiable |
| E. Récupération overflow (compaction ×3 + troncature tool results) | rattrapage | ACTIVE (réactive : l'erreur est déjà tombée) |

⇒ **L'hypothèse prod est CONFIRMÉE au niveau du code** : quand un plugin possède la compaction, il ne reste **aucune garde pré-vol basée sur une estimation du prompt**. Le seul filet restant (D) est un seuil calculé sur `SessionEntry.totalTokens`, un compteur dont l'amont lui-même documente qu'il peut être **cumulatif de run** (donc absurde) au lieu d'être l'occupation de fenêtre.

Côté Atrium, trois défauts sont **sous notre contrôle** :

1. **La jauge n'est pas fidèle et ne peut pas l'être** avec les champs consommés aujourd'hui : `activeTokens` et `sessionMeta.totalTokens` sont **le même champ amont** (`SessionEntry.totalTokens`) lu à deux instants différents. Le commentaire de schéma qui prétend le contraire (`convex/schema.ts:1068-1072`) est une **mésattribution**.
2. **Atrium ignore les deux champs amont qui portent la vérité** : `contextBudgetStatus` (l'estimation du gateway lui-même, avec `overflowTokens` et `promptBudgetBeforeReserve`) et `totalTokensFresh` (le drapeau « ce chiffre est périmé »). Les deux sont **sur le fil** (`session-utils.ts:2386-2387`, `2407-2408`) et **jetés** par `parseSessionMeta` (`bridge/src/server.ts:614-630`).
3. **Aucune garde pré-envoi** : le bridge fait déjà un `sessions.describe` avant CHAQUE `chat.send` (`bridge/src/server.ts:828-859`) et n'en fait qu'une trace d'observabilité. C'est le point d'insertion naturel d'une garde, gratuit en appels gateway.

---

## 1. Côté gateway — la chaîne complète (OpenClaw v2026.7.1)

### 1.1 Le budget et l'estimation (le contrat)

| Élément | Valeur / mécanique | Preuve |
|---|---|---|
| Marge de sécurité appliquée à toute estimation | `SAFETY_MARGIN = 1.2` | `src/agents/compaction-planning.ts:17` |
| Réserve de sortie (headroom réponse) | `agents.defaults.compaction.reserveTokens`, plancher `reserveTokensFloor` | `src/config/schema.help.ts:1509-1514`, `src/config/types.agent-defaults.ts:523-527` |
| Budget de prompt minimal garanti | `min(8 000, 50 % de la fenêtre)` | `src/agents/agent-compaction-constants.ts` (`MIN_PROMPT_BUDGET_TOKENS = 8_000`, `MIN_PROMPT_BUDGET_RATIO = 0.5`) |
| Réserve effective (bornée pour ne pas affamer le prompt) | `min(reserveTokens, budget − minPromptBudget)` | `run/preemptive-compaction.ts:347-356` |
| Budget prompt avant réserve | `max(1, contextTokenBudget − effectiveReserveTokens)` | `run/preemptive-compaction.ts:356` |
| Débordement estimé | `max(0, estimatedPromptTokens − promptBudgetBeforeReserve)` | `run/preemptive-compaction.ts:357` |
| Plafonnement de la réserve pour petits modèles (anti-boucle infinie) | cap à `contextWindow − minPromptBudget` | `src/agents/agent-settings.ts:65-88` (commentaire explicite : sans ce cap, « every prompt is classified as an overflow → infinite compaction loop ») |

**Heuristique d'estimation** (`run/preemptive-compaction.ts:26-32`, `53-274`) — elle est *grossière et assumée comme telle* (« runs before provider tokenization », l. 256) :

| Constante | Valeur | Ligne |
|---|---|---|
| `ESTIMATED_CHARS_PER_TOKEN` | 4 | `:26` |
| `TOOL_RESULT_CHARS_PER_TOKEN` | 2 (plus conservateur) | `:27` |
| `JSON_PAYLOAD_CHARS_PER_TOKEN` | 3 | `:28` |
| `MESSAGE_BOUNDARY_OVERHEAD_TOKENS` | 12 / message | `:29` |
| `CONTENT_BLOCK_OVERHEAD_TOKENS` | 6 / bloc | `:30` |
| `IMAGE_BLOCK_TOKENS` | 2 000 / image (forfait) | `:31` |

**Point aveugle documenté** : les **définitions d'outils** (tool schemas) **ne sont PAS comptées** par `estimateLlmBoundaryTokenPressure` (`:258-274` — history + systemPrompt + prompt uniquement). Hermes, lui, compte explicitement les schémas d'outils (« with 50+ tools enabled these add 20-30K tokens the messages-only estimate misses », `/tmp/hermes-upstream.okb8T2/agent/conversation_loop.py:5134-5139`). C'est un écart **≈ 20-30 k tokens** entre l'estimation OpenClaw et le prompt réel sur un agent outillé. Sur l'incident 179 k affichés / > 308 k réels, cet écart est un contributeur plausible mais **NON PROUVÉ** comme cause principale.

### 1.2 Étage B — le precheck pré-prompt et son court-circuit

Appel : `src/agents/embedded-agent-runner/run/attempt.ts:4855-4872`.
Décision : `run/preemptive-compaction.ts:311-392` → route `fits | compact_only | truncate_tool_results_only | compact_then_truncate`.

**Le court-circuit** (le cœur de l'incident prod) :

```ts
// src/agents/embedded-agent-runner/run/attempt.ts:4843-4853
const shouldSkipPrecheck =
  skipPromptSubmission ||
  (contextEngineAssemblySucceeded &&
    activeContextEngine?.info.ownsCompaction &&
    contextEnginePromptAuthority !== "preassembly_may_overflow");

if (shouldSkipPrecheck && !skipPromptSubmission) {
  log.info(
    `[context-overflow-precheck] skipped: context engine "…" owns compaction`,
  );
}
```

Le contrat côté plugin l'énonce noir sur blanc (`src/context-engine/types.ts:9-37`) :

> « "assembled": the generic precheck uses only the assembled prompt's estimate **unless the engine owns compaction; owning engines manage prompt admission**. »
> « "preassembly_may_overflow": the precheck takes the maximum of the assembled estimate and the pre-assembly (unwindowed) session-history estimate. **Engines opt into this when their assembled view can hide an overflow**… This opt-in keeps the generic precheck active even for engines that own compaction. »

⇒ **Le retour du precheck est à la main du PLUGIN**, via `AssembleResult.promptAuthority`. Par défaut (`"assembled"`, `types.ts:35`), un moteur `ownsCompaction` **désarme** le precheck générique. C'est un opt-in, pas un défaut sûr.

Preuve comportementale amont (tests épinglés) :

- `run.overflow-compaction.loop.test.ts:850-851` — « recovers from real model overflow **when ownsCompaction context engine skips precheck** »
- `run.overflow-compaction.loop.test.ts:864-865` — « still handles precheck overflow when ownsCompaction engine uses `preassembly_may_overflow` »

### 1.3 Étage A — la compaction auto native, aussi désactivée

```ts
// src/agents/agent-settings.ts:174-184
function shouldDisableAgentAutoCompaction(params): boolean {
  return (
    params.contextEngineInfo?.ownsCompaction === true ||
    params.compactionMode === "safeguard" ||
    params.silentOverflowProneProvider === true
  );
}
```

Commentaire amont (`agent-settings.ts:165-173`) : cela désactive `_checkCompaction → _runAutoCompaction`, « which would otherwise fire from inside `Session.prompt()` … before the provider call ».

⇒ Sous LCM, **A et B tombent ensemble**. Il ne reste rien entre l'assemblage du prompt et l'appel provider.

### 1.4 Étage C — la garde mi-tour, désactivée par défaut

Installation : `src/agents/embedded-agent-runner/tool-result-context-guard.ts:469-566`.
Déclenchement : après chaque tool result ajouté (`hasNewToolResultAfterFence`, `:520-526`), on rejoue `shouldPreemptivelyCompactBeforePrompt` sur la vue transformée et on lève `MidTurnPrecheckSignal` (`:549`, classe en `run/midturn-precheck.ts:28-36`).

Gating :

```ts
// src/agents/embedded-agent-runner/run/attempt.ts:2729-2730
const midTurnPrecheckEnabled =
  params.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true;
```

Aide de configuration (`src/config/schema.help.ts:1531-1532`) :

> « Enable structured mid-turn context pressure checks for embedded OpenClaw tool loops. **Default: false.** Keep disabled unless long tool-heavy sessions hit context overflow before normal turn-end compaction can run. »

⇒ C'est **exactement** la description du symptôme prod, et le remède est **off par défaut**. C'est un levier opérateur immédiat (§8).

Note : la garde installe **aussi** un plafond dur non conditionnel (`exceedsPreemptiveOverflowThreshold` → `PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE`, `tool-result-context-guard.ts:557-563`) et une troncature par tool result (`:498-506`) qui, eux, tournent toujours. Mais ces deux-là sont des plafonds *caractères* dérivés de la fenêtre, pas une estimation du prompt.

### 1.5 Étage D — la compaction preflight pré-réponse (le seul filet restant)

Site : `src/auto-reply/reply/agent-runner-memory.ts:883-891` (gate) → `:931-957` (appel `compactEmbeddedAgentSession`, `trigger: "budget"`, `forcePreflight: true`).

Le seuil (`src/auto-reply/reply/memory-flush.ts:101-134`, `163-178`) :

```
threshold = max(contextWindow − reserveTokensFloor − softThreshold, minimumThresholdTokens)
compacte si totalTokens >= threshold
```

Le `totalTokens` injecté (`agent-runner-memory.ts:857-866`) est
`max(usageProjectedTokenCount, freshProjectedTokenCount, stalePersistedPromptTokens)` — donc le **maximum** de trois estimations, ce qui est prudent. Mais :

- `stalePersistedPromptTokens` n'est retenu **que si `entry.totalTokensFresh !== false`** (`:837-840`) — un compteur marqué périmé est **ignoré**, pas remplacé.
- Les trois sources dérivent du transcrit **local** ou de `SessionEntry.totalTokens`. Un context engine qui réécrit/assemble sa propre vue rend ces trois chiffres **non représentatifs du prompt réellement envoyé**. Aucun code ne demande au moteur « quelle est la taille de TON prompt assemblé ».

Exclusions du preflight : heartbeat, CLI (`:743-745`), runtime Codex (`:746-762`, « its harness owns automatic compaction »). **Il n'y a PAS d'exclusion `ownsCompaction`** ici — bonne nouvelle : D reste armé sous LCM.

**Mais** le chemin de report existe : `compact.queued.ts:75-90`

```ts
function shouldDeferOwningContextEngineBudgetCompaction(params): boolean {
  return (
    params.compactParams.deferOwningContextEngineCompaction === true &&
    params.compactParams.trigger === "budget" &&
    params.contextEngine.info.ownsCompaction === true &&
    params.contextEngine.info.turnMaintenanceMode === "background" &&
    typeof params.contextEngine.maintain === "function"
  );
}
```

→ retourne un résultat non compacté avec `reason = "deferred to background context-engine maintenance"` (`compact-reasons.ts:9-10`), classé `deferred_background` (`compact-reasons.ts:46-48`).

**En v2026.7.1, le seul site de production passe `deferOwningContextEngineCompaction: false`** (`agent-runner-memory.ts:962`). ⇒ La maintenance différée **ne** court-circuite **pas** le preflight dans cette version. L'« hypothèse maintenance différée post-tour » est donc **partiellement infirmée** : le mécanisme existe et est prêt (`context-engine-maintenance.ts:695-722` : `reason === "turn" && turnMaintenanceMode === "background"` → `scheduleDeferredTurnMaintenance`), mais il n'est pas armé sur le chemin preflight en 2026.7.1. **Ce qui reste vrai et suffit à expliquer l'incident, c'est A + B + C désarmés.**

### 1.6 Étage E — la récupération overflow (réactive)

Détection : `run.ts:2703-2721` — `isLikelyContextOverflowError(promptError)` d'abord, sinon `assistantErrorText`.
Diagnostic : `run.ts:2740-2752` (`[context-overflow-diag] … diagId=… observedTokens=… preflightEstimatedTokens=… compactionTokens=…`).

Ladder :

| Ordre | Condition | Action | Ligne |
|---|---|---|---|
| 1 | compaction déjà faite dans la tentative | rejoue le prompt **sans** recompacter | `run.ts:2755-2769` |
| 2 | pas d'échec de compaction, `attempts < 3` | `contextEngine.compact({force:true, compactionTarget:"budget", trigger:"overflow"})` sous timeout de sécurité | `run.ts:2771-2872` |
| 2b | route `compact_then_truncate` | troncature des tool results après compaction | `run.ts:2921-2949` |
| 3 | tool results surdimensionnés | `truncateOversizedToolResultsInSession` | `run.ts:2971-3019` |
| 4 | épuisement | message terminal + `livenessState: "blocked"` | `run.ts:3021-3072` |

Bornes : `MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3` (`run.ts:1611`).

**Quand la compaction échoue ou est « déjà récente »** : `isCompactionFailureError(errorText)` (`run.ts:2753`) fait **sauter directement à l'abandon** (branche `give_up`, `run.ts:3021-3031`). Le vocabulaire d'échec est normalisé par `classifyCompactionReason` (`compact-reasons.ts:28-74`) :

| Classe | Déclencheur textuel | Ligne |
|---|---|---|
| `no_compactable_entries` | « nothing to compact » / « no real conversation messages » | `:33-35` |
| `below_threshold` | « below threshold » / « already under target » | `:38-40` |
| **`already_compacted_recently`** | « already compacted » / « already_compacted » | `:41-43` |
| **`deferred_background`** | « deferred to background » | `:44-46` |
| `live_context_still_exceeds_target` | « still exceeds target » | `:47-49` |
| `guard_blocked` / `summary_failed` / `timeout` / `provider_error_4xx|5xx` | … | `:50-72` |

⇒ Un plugin qui répond `already_compacted_recently` **transforme immédiatement l'overflow en échec terminal**, sans autre tentative.

### 1.7 Le terminal — le texte exact que voit le client

```ts
// src/agents/embedded-agent-runner/run.ts:3032-3035
const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
const overflowRecoveryText =
  "Context overflow: prompt too large for the model. " +
  "Try /reset (or /new) to start a fresh session, or use a larger-context model.";
```

- Log : `run.ts:3036-3039` — `[context-overflow-recovery] exhausted … livenessState=blocked suggestedAction=reset_or_new kind=…`
- Retour : `payloads:[{text, isError:true}]`, `meta.livenessState:"blocked"`, `meta.error:{kind, message}` (`run.ts:3040-3072`).
- Variantes internes (jamais terminales) : `PREEMPTIVE_OVERFLOW_ERROR_TEXT = "Context overflow: prompt too large for the model (precheck)."` (`run/preemptive-compaction.ts:23-24`) et `MID_TURN_PRECHECK_ERROR_MESSAGE = "… (mid-turn precheck)."` (`run/midturn-precheck.ts:20-21`).
- Tests amont épinglant le texte : `src/agents/run-wait.test.ts:347,354`, `src/agents/subagent-announce-output.test.ts:361,368`, `src/agents/subagent-registry.test.ts:2440,2468,4256`.

### 1.8 Les signaux de compaction émis sur le fil

| Signal | Émission | Contenu |
|---|---|---|
| `{stream:"compaction", data:{phase:"start"}}` | `embedded-agent-subscribe.handlers.compaction.ts:61-69` | + `livenessState = "paused"` (`:53`) |
| `{stream:"compaction", data:{phase:"end", willRetry, completed}}` | `embedded-agent-subscribe.handlers.compaction.ts:151-159` | `completed = hasResult && !aborted` |
| `{stream:"compaction", data:{phase, messages[]}}` (hooks) | `run.ts:1913-1929` | messages de hook, chemins `ownsCompaction` |
| `session.operation` (`operation:"compact"`, `phase`) | schéma `packages/gateway-protocol/src/schema/sessions.ts:22-34` | **non souscrit par Atrium** (documenté `docs/design/upstream-interpretation-comparison.md:300-303`) |
| Checkpoints `sessions.compaction.list` | schéma `sessions.ts:48-63` (`reason: manual|auto-threshold|overflow-retry|timeout-retry`, `tokensBefore/After`) | consommé en lazy par Atrium (`bridge/src/server.ts:1183-1221`) |

**Le point crucial** : **aucun** de ces signaux ne porte l'estimation du prompt. Le seul champ qui la porte est `contextBudgetStatus`, sur `sessions.describe` (§2).

---

## 2. Le champ que le gateway expose et qu'Atrium jette : `contextBudgetStatus`

### 2.1 Il est produit

`buildPrePromptContextBudgetStatus` (`run/preemptive-compaction.ts:428-467`) construit :

```
{ schemaVersion:1, source:"pre-prompt-estimate", updatedAt, provider, model,
  route, shouldCompact, estimatedPromptTokens, contextTokenBudget,
  promptBudgetBeforeReserve, reserveTokens, effectiveReserveTokens,
  remainingPromptBudgetTokens, overflowTokens, toolResultReducibleChars,
  messageCount, unwindowedMessageCount, sessionId }
```

Type : `src/config/sessions/types.ts:97-121`. Persisté : `src/agents/command/session-store.ts:203`.

### 2.2 Il est sur le fil

```ts
// src/gateway/session-utils.ts:2386-2387, 2407-2408 (buildGatewaySessionRow)
    totalTokens,
    totalTokensFresh,
    …
    contextTokens,
    contextBudgetStatus: entry?.contextBudgetStatus,
```

`sessions.describe` renvoie exactement cette ligne (`src/gateway/server-methods/sessions.ts:1069-1082`).

**Il n'est PAS aplati sur les agent events** : `buildGatewaySessionEventFields` (`src/gateway/session-event-payload.ts:16-90`) liste `totalTokens`, `totalTokensFresh`, `contextTokens`, `estimatedCostUsd`, `inputTokens`, `outputTokens`… mais **pas** `contextBudgetStatus`. Il n'est donc lisible **que** via `sessions.describe`.

### 2.3 L'amont s'en sert lui-même pour l'affichage

```ts
// src/status/status-message.ts:958-961
const contextUsageLabel =
  totalTokens == null || totalTokens === 0
    ? (formatEstimatedContextBudgetTokens(entry?.contextBudgetStatus, contextTokens) ??
      formatTokens(totalTokens, contextTokens ?? null))
    : formatTokens(totalTokens, contextTokens ?? null);
```

`formatEstimatedContextBudgetTokens` (`status-message.ts:228-256`) rend `~145.1k/272k (53% est)`. **L'amont a donc déjà l'affichage fidèle qu'Atrium n'a pas.**

### 2.4 Mais il est vide sous LCM

Trois raisons cumulatives :

1. **Il n'est écrit que si le precheck a tourné** — `attempt.ts:4873-4886` est gardé par `if (preemptiveCompaction)`, qui est `null` quand `shouldSkipPrecheck` (`:4842`, `:4855`).
2. **Il est effacé après une compaction** — `session-store.ts:240-242` (`useCompactionSnapshot`), `:267`, `:404`.
3. **Il est effacé sur changement de modèle** — `src/sessions/model-overrides.ts:115-118`.

⇒ Pour qu'Atrium puisse afficher la vérité, il faut **soit** que le plugin déclare `promptAuthority: "preassembly_may_overflow"` (levier opérateur §8), **soit** qu'Atrium calcule sa propre estimation (levier Atrium §7).

### 2.5 Atrium le jette

```ts
// bridge/src/server.ts:614-630 (parseSessionMeta)
return {
  model, modelProvider, agentRuntime, thinkingLevel, thinkingDefault,
  thinkingLevels, availableModels, verboseLevel,
  totalTokens: num(sess.totalTokens),
  contextTokens: num(sess.contextTokens),
  estimatedCostUsd: num(sess.estimatedCostUsd),
};
```

Ni `contextBudgetStatus`, ni `totalTokensFresh`. Le détecteur de dérive connaît `totalTokensFresh` mais le classe « consommé nulle part » (`bridge/src/providers/openclaw/protocol-drift.ts:78`).

---

## 3. La fidélité de la jauge — la démonstration

### 3.1 Ce qu'Atrium affiche

```ts
// src/chat/sessionKnobs.ts:115-126
export function effectiveContextUsed(sm): number | null {
  if (!sm) return null;
  if (sm.activeTokens != null) return sm.activeTokens;   // (1) priorité
  if (sm.totalTokens == null) return null;
  if (sm.contextTokens && sm.totalTokens > sm.contextTokens) return null; // (2) garde 859 %
  return sm.totalTokens;
}
```

Seuils visuels : `is-warn` ≥ 75 %, `is-critical` ≥ 90 % (`src/chat/ConvexChat.tsx:1618`).

### 3.2 D'où vient `activeTokens`

```ts
// bridge/src/core/turn-sink.ts:1425-1438
const active = this.pendingDiagUsage?.totalTokens;
if (active != null && active > 0) {
  void this.writer.reportSessionActiveTokens?.(this.chatId, active, Date.now())…
}
```

`pendingDiagUsage` ← `event.diagnosticUsage` (`turn-sink.ts:927-936`) ← `this.diagUsage` (`normalizer.ts:1580`) ← :

```ts
// bridge/src/providers/openclaw/normalizer.ts:1030-1039
if (num(payload.totalTokens) !== null || num(payload.estimatedCostUsd) !== null) {
  this.diagUsage = {
    totalTokens: num(payload.totalTokens),
    inputTokens: num(payload.inputTokens),
    outputTokens: num(payload.outputTokens),
    estimatedCostUsd: num(payload.estimatedCostUsd),
  };
}
```

`payload` = le frame agent event, dont les champs de session sont aplatis par `buildGatewaySessionEventFields` (`src/gateway/session-event-payload.ts:16-90`). La liste des champs aplatis correspond **exactement**, nom pour nom, à la liste « connue » du détecteur de dérive d'Atrium (`bridge/src/providers/openclaw/protocol-drift.ts:58-125` : `session`, `updatedAt`, `kind`, `channel`, `chatType`, `origin`, `deliveryContext`, `verboseLevel`, `systemSent`, `lastChannel`, `totalTokens`, `totalTokensFresh`, `goal`, `estimatedCostUsd`, `modelProvider`, `model`, `status`, `startedAt`, `abortedLastRun`, `inputTokens`, `outputTokens`, `contextTokens`, `endedAt`, …). ⇒ **preuve d'identité de la source**.

### 3.3 Le défaut : c'est le MÊME champ que `totalTokens`

`sessionRow.totalTokens` ← `SessionEntry.totalTokens` ← `deriveSessionTotalTokens` (`src/agents/usage.ts:339-374`) ← `deriveContextPromptTokens` (`usage.ts:308-336`).

Or `deriveContextPromptTokens` a un **escalier de repli** :

```
1. promptTokens explicite            → correct
2. lastCallUsage.contextUsage        → correct (occupation de fenêtre réelle)
3. derivePromptTokens(lastCallUsage) → correct (prompt du dernier appel)
4. usage.contextUsage                → correct
5. derivePromptTokens(usage)         → *** usage = ACCUMULATEUR DE RUN ***
```

Et l'appelant choisit bien l'accumulateur en dernier ressort :

```ts
// src/agents/command/session-store.ts:210-217
const usageForContext = isCliProvider(providerUsed, cfg)
  ? lastCallUsage
  : lastCallUsage?.contextUsage
    ? lastCallUsage
    : usage;                        // <— run-cumulative
const totalTokens = deriveSessionTotalTokens({ usage: promptTokens ? undefined : usageForContext, contextTokens, promptTokens });
```

où `usage = result.meta.agentMeta?.usage` (`session-store.ts:84`) est l'accumulateur du run entier.

⇒ **Quand le provider n'expose pas `contextUsage` (et que `promptTokens` est absent), `SessionEntry.totalTokens` devient la somme des tokens d'entrée de TOUS les appels du tour.** C'est très exactement le « 859 % — 3194.3k/372.0k » rapporté en prod et cité dans `convex/schema.ts:1069-1071`.

**Conséquence** : le commentaire de schéma d'Atrium

```
// convex/schema.ts:1068-1072
totalTokens  // gateway sessions.get counter (CUMULATIVE under a context engine — not the window fill)
// REAL window usage of the LAST turn (bridge post-usage snapshot): …
activeTokens
```

est une **mésattribution**. Les deux valeurs sont `SessionEntry.totalTokens` ; ce qui les distingue est **l'instant de lecture** (describe pré-tour vs frame agent pendant/après le tour), **pas** la sémantique. Le correctif « activeTokens » a probablement fonctionné parce que la valeur aplatie sur le frame arrive après une remise à zéro/compaction ou est simplement plus fraîche, **pas** parce qu'elle serait d'une autre nature. **Le mode de défaillance cumulatif n'est pas éliminé**, il est seulement moins souvent observé — et la garde `(2)` de `effectiveContextUsed` (`sessionKnobs.ts:124`) ne s'applique **pas** à `activeTokens` (le `return` de la ligne 122 est avant).

**⇒ Un `activeTokens` cumulatif inférieur à `contextTokens` est affiché tel quel, comme une vérité.** C'est le mécanisme exact d'un « 179 k affichés » alors que le prompt réel dépasse 308 k : la valeur affichée est un artefact d'un des cinq paliers de repli, sans marqueur de confiance.

### 3.4 Ce que fait Hermes (et qui donne raison à l'analyse)

Hermes a rencontré **le même bug** et l'a corrigé en refusant d'afficher :

```python
# /tmp/hermes-upstream.okb8T2/tui_gateway/server.py:3619-3644
# context_used is the *current-window* occupancy. Do NOT fall back to
# usage["total"] (cumulative lifetime session_total_tokens): for an
# external context engine that doesn't report last_prompt_tokens that
# substitution showed lifetime totals as the live context fill, yielding
# impossible readings such as 1.9m/120k clamped to 100% (#50421).
# … populate context_used/percent only from a *real* current-occupancy
# value and "leave it unknown otherwise"
last_prompt = getattr(comp, "last_prompt_tokens", 0) or 0
if last_prompt < 0: last_prompt = 0
ctx_max = getattr(comp, "context_length", 0) or 0
if ctx_max and last_prompt:
    usage["context_used"] = last_prompt
    usage["context_max"]  = ctx_max
    usage["context_percent"] = max(0, min(100, round(last_prompt / ctx_max * 100)))
```

Atrium consomme déjà correctement ces deux champs côté Hermes (`bridge/src/providers/hermes/ws-turn.ts:601-624` : `context_used → totalTokens`, `context_max → contextTokens`).

Hermes émet en plus des **avertissements de pression** utilisateur à 60 % et 85 % du seuil de compaction (`/tmp/hermes-upstream.okb8T2/website/docs/user-guide/configuration.md:878-896`) — une gradation qu'OpenClaw n'a pas et qu'Atrium n'a pas non plus (seuls 75/90 % de coloration).

---

## 4. Côté Atrium — ce qui est consommé, ignoré, perdu

| # | Signal amont | Peut être émis | Émis réellement | Consommé par Atrium | Verdict |
|---|---|---|---|---|---|
| 1 | `chat:error.errorKind = "context_length"` | oui (`src/infra/errors.ts:150,184`) | **non sur 2026.6.11** (commentaire live `normalizer.ts:1597-1600`) ; à revérifier en 2026.7.1 | oui + repli texte | ✅ traité |
| 2 | Texte `"Context overflow: prompt too large…"` | oui (`run.ts:3032-3035`) | oui | `CONTEXT_OVERFLOW_TEXT_RE` (`normalizer.ts:129-133`) → `errorKind="context_length"` (`normalizer.ts:1599-1607`) | ✅ traité |
| 3 | `{stream:"compaction", phase:start/end}` | oui | oui | oui — signal primaire (`docs/design/upstream-interpretation-comparison.md:262-282`) | ✅ traité |
| 4 | `sessions.describe.contextBudgetStatus` | oui (`session-utils.ts:2408`) | **oui quand le precheck tourne**, vide sous `ownsCompaction` | **NON** (`bridge/src/server.ts:614-630`) | ❌ **PERDU** |
| 5 | `sessions.describe.totalTokensFresh` | oui (`session-utils.ts:2387`) | oui | **NON** (`protocol-drift.ts:78` « consommé nulle part ») | ❌ **PERDU** |
| 6 | `session.operation` (`operation:"compact"`) | oui (schéma `sessions.ts:22-34`) | oui | non (pas de `sessions.subscribe`) | ⚪ écart assumé, documenté |
| 7 | Taxonomie `manual|threshold|overflow` | oui (`handlers.compaction.ts:35-39`) | oui (dans le log, pas dans l'event : `data:{phase}` seul, `:64`) | non | ⚪ non transmise par le protocole |
| 8 | `route` / `overflowTokens` du precheck | via `contextBudgetStatus` uniquement | idem #4 | non | ❌ **PERDU** |
| 9 | Overflow d'un **sous-agent** | texte brut dans `errorMessage` | oui | **pas de classification** — `convex/schema.ts:1367` a `errorMessage` mais **aucun `errorCode`** | ❌ **PERDU** (item A du mémo `atrium-context-overflow-audit`) |

### 4.1 Ce qu'Atrium fait bien (à conserver)

- **Classification robuste** : `CONTEXT_OVERFLOW_TEXT_RE` couvre 8 formulations providers (`normalizer.ts:129-133`), avec un filet client-side (`src/chat/runStatusView.ts:213-217`).
- **Carte d'erreur actionnable** : `context_length → m.runstatus_error_context_length` (`src/chat/runStatusView.ts:179`), allowlist SOC2 (`convex/lib/chatRenderState.ts:58-88` — jamais de texte brut dans la télémétrie).
- **Non-retryable, à raison** : `RETRYABLE_KINDS = {session_init_conflict, empty_response_silent, provider_internal}` (`convex/turnRetry.ts:62-66`) — rejouer à l'identique un prompt trop gros échouerait à l'identique.
- **Trace de pression par tour, sans contenu** : `recordGatewayPressure` (`bridge/src/core/turn-sink.ts:1397-1423`) — `totalTokens`, `contextTokens`, `costUsd`, `toolCalls`, `compaction`, `errorKind`, `stopReason`, `postTotalTokens/Input/Output`. Conforme SOC2 (noms + compteurs uniquement).
- **Rehydratation bornée** : `HARD_MAX_HISTORY_CHARS = 60 000` (~20 k tok) et `min(50 % de la fenêtre × 3, plafond)` (`convex/lib/rehydration.ts:19`, `88-91`).
- **Compaction et reset manuels exposés** : `POST /compact` (`bridge/src/server.ts:2940-2960`, `performCompact` `:1167-1174`), `POST /reset` (`:2249-2330`), UI `SessionPanel.tsx:152-153`.

### 4.2 Le parcours utilisateur quand ça casse

1. L'utilisateur envoie. Le bridge `describe` (`server.ts:828-859`), envoie (`server.ts:1055`), ouvre le tour (`server.ts:1069-1078`).
2. Le gateway déborde, épuise E, renvoie le texte terminal + `livenessState:"blocked"`.
3. Le bridge classe `context_length`, finalise le message en `error`, écrit la trace de pression (`turn-sink.ts:1375-1424`).
4. L'UI affiche la carte actionnable. **Pas de retry automatique** (correct).
5. **Le tour est perdu** : le message utilisateur reste, mais aucune réponse. **Et le tour suivant échouera de même** — rien n'a changé dans la session. L'utilisateur doit deviner qu'il faut cliquer *Compacter* ou *Réinitialiser* dans le panneau de session.

⇒ **C'est là le vrai défaut produit** : l'échec est terminal *et* répétable, et la seule sortie est une action manuelle non suggérée par la carte d'erreur.

---

## 5. Défauts identifiés (synthèse)

| id | Titre | Sévérité | Où |
|---|---|---|---|
| `oc-gauge-source-misattribution` | `activeTokens` et `totalTokens` sont le même champ amont ; la jauge peut afficher un cumul comme un remplissage | **critical** | `convex/schema.ts:1068-1072`, `turn-sink.ts:1428`, `usage.ts:308-336`, `session-store.ts:210-217` |
| `oc-contextbudget-dropped` | `contextBudgetStatus` (estimation du gateway) sur le fil, jeté | **high** | `session-utils.ts:2408` vs `bridge/src/server.ts:614-630` |
| `oc-totaltokensfresh-dropped` | `totalTokensFresh=false` ignoré → un chiffre périmé s'affiche comme vrai | **high** | `session-utils.ts:2387` vs `protocol-drift.ts:78` |
| `oc-no-presend-guard` | Aucune garde pré-envoi côté bridge malgré un `describe` déjà fait à chaque tour | **high** | `bridge/src/server.ts:828-859`, `:1055` |
| `oc-overflow-terminal-repeats` | Après overflow terminal, aucune action de sortie proposée ; le tour suivant re-déborde | **high** | `run.ts:3032-3072` → `runStatusView.ts:179` |
| `oc-plugin-owns-precheck-off` | Un moteur `ownsCompaction` désarme A + B ; `preassembly_may_overflow` est un opt-in plugin | **critical** (config gateway) | `attempt.ts:4843-4853`, `agent-settings.ts:174-184`, `types.ts:9-37` |
| `oc-midturn-precheck-off` | La garde exactement conçue pour ce symptôme est off par défaut | **high** (config gateway) | `attempt.ts:2729-2730`, `schema.help.ts:1531-1532` |
| `oc-subagent-overflow-unclassified` | Overflow enfant jamais classé, invisible à l'obs | **medium** | `convex/schema.ts:1367` (pas d'`errorCode`) |
| `oc-rehydration-no-token-ceiling` | Plafond en **caractères** seulement sur `history + userText` ; `contextTokens` peut être périmé/inter-agent | **medium** | `convex/lib/rehydration.ts:19,88-91` |
| `oc-toolschema-blindspot` | L'estimation amont ne compte pas les schémas d'outils (~20-30 k tok) | **medium** (amont) | `preemptive-compaction.ts:258-274` vs `conversation_loop.py:5134-5139` |

---

## 6. Architecture de défense en profondeur proposée

Principe directeur (charte repo `no-user-workaround-advice`, `design-agent-does-the-work-both-providers`) : **on corrige le défaut et on rend le dangereux impossible ; on ne prescrit pas un contournement à l'utilisateur.** Et : Atrium **mesure et protège**, il ne **traite** pas le contexte (pas de moteur de compaction dans Atrium).

### Couche 1 — MESURER JUSTE (préalable à tout le reste)

**1.1 Consommer `contextBudgetStatus`.** `parseSessionMeta` (`bridge/src/server.ts:586-631`) lit `sess.contextBudgetStatus` et le projette, content-free, sur `sessionMeta` :
`{ estimatedPromptTokens, promptBudgetBeforeReserve, overflowTokens, route, source:"pre-prompt-estimate", updatedAt }`.
Quand il est présent, il **prime** sur `activeTokens`/`totalTokens` pour la jauge — c'est le chiffre que l'amont utilise lui-même (`status-message.ts:958-961`).

**1.2 Consommer `totalTokensFresh`.** `totalTokensFresh === false` ⇒ la valeur est marquée périmée. La jauge doit alors afficher un état **indéterminé** (pas de %), jamais un chiffre. Modèle direct : Hermes `#50421` (`tui_gateway/server.py:3625-3644`).

**1.3 Étiqueter la source de la jauge.** Ajouter `sessionMeta.contextSource: "budget_estimate" | "last_call_usage" | "unknown"` et l'afficher dans le tooltip (`~145k/272k (estimé)` vs `145k/272k`). Un chiffre sans provenance est un chiffre non vérifiable.

**1.4 Étendre la garde anti-absurde à `activeTokens`.** `effectiveContextUsed` (`src/chat/sessionKnobs.ts:115-126`) applique aujourd'hui `used > contextTokens ⇒ null` uniquement à `totalTokens` (ligne 124), après un `return` prioritaire sur `activeTokens` (ligne 122). Appliquer la même garde aux deux.

*Vérification* : test unitaire sur `effectiveContextUsed` (`activeTokens > contextTokens ⇒ null` ; `totalTokensFresh:false ⇒ null` ; `budgetStatus présent ⇒ prime`). Puis banc live : `sessions.describe` sur une session longue et comparaison du `%` affiché avec `contextBudgetStatus.estimatedPromptTokens / contextTokenBudget`.

### Couche 2 — ESTIMER NOUS-MÊMES quand l'amont se tait

Sous LCM, `contextBudgetStatus` est vide (§2.4). Atrium doit alors produire sa **propre** borne inférieure, **content-free** :

**2.1 Un estimateur pur côté Convex**, `estimateOutboundPromptTokens(chatId)` :
`somme(longueurs des messages du fil depuis le dernier marqueur de compaction) / 3` + `taille du bloc de rehydratation composé` + `taille du texte du tour`, × `SAFETY_MARGIN` (aligner sur 1.2, `compaction-planning.ts:17`).
Ce n'est pas la vérité (Atrium ne voit ni le system prompt, ni les schémas d'outils, ni les tool results internes du gateway) — c'est une **borne basse**. Un dépassement de la borne basse est déjà une preuve.

**2.2 L'afficher comme un plancher**, jamais comme la valeur : « ≥ 210k / 272k ». Un plancher honnête bat un chiffre faux.

*Vérification* : fixtures de conversations (courte / longue / avec sous-agents) → assertions sur la monotonie et le sens (estimation ≤ `contextBudgetStatus.estimatedPromptTokens` quand les deux existent). Banc live : corréler avec les `overflowTokens` observés dans les traces de pression des tours ayant réellement débordé.

### Couche 3 — GARDE PRÉ-ENVOI (bridge), graduée, jamais bloquante par défaut

Point d'insertion : `bridge/src/server.ts:828-880`, dans le `describe` **déjà fait** avant chaque `chat.send` — **coût gateway nul**.

| Bande (fill estimé) | Action bridge | Action UI |
|---|---|---|
| < 70 % | rien | jauge verte |
| 70-85 % | rien | jauge ambre + info « la session approche de la compaction » |
| 85-95 % | **`sessions.compact` PRÉVENTIF avant le `chat.send`** (RPC existante, `server.ts:1167-1174`), puis re-`describe`, puis envoi | bandeau « compaction préventive » (déjà un état `compacting`, `convexTypes.ts:196`) |
| > 95 % **ou** `contextBudgetStatus.overflowTokens > 0` | compaction préventive **obligatoire** ; si elle échoue (`already_compacted_recently` / `deferred_background` / `below_threshold`), **ne pas envoyer** : finaliser le tour en `context_length` **avant** toute dépense provider, avec les actions de sortie (Couche 5) | carte actionnable, tour non facturé |

Trois exigences non négociables :
- **Idempotence** : la compaction préventive est marquée sur le tour (`preflightCompacted:true`) pour qu'un re-`describe` en échec ne boucle pas ; au plus **une** tentative par tour.
- **Robustesse Mars** (charte `atrium-bridge-mars-robustness`) : toute erreur de la garde ⇒ on envoie quand même. La garde ne peut jamais faire perdre un tour qui serait passé.
- **SOC2** : la garde ne journalise que `{fillPct, source, action, compactReasonClass}` — jamais de contenu.

*Vérification* : (a) test d'intégration bridge avec un faux gateway rendant un `describe` à 97 % → assertion « `sessions.compact` appelé avant `chat.send` » ; (b) test « compact refuse ⇒ pas de `chat.send`, message finalisé `context_length` » ; (c) test « la garde jette ⇒ `chat.send` a quand même lieu » ; (d) banc live local : session gonflée artificiellement, vérifier le compact préventif et l'absence d'overflow.

### Couche 4 — RÉDUIRE LA PRESSION QU'ATRIUM CRÉE LUI-MÊME

**4.1 Plafond en TOKENS sur la rehydratation** (item D du mémo `atrium-context-overflow-audit`). Aujourd'hui `HARD_MAX_HISTORY_CHARS = 60 000` (`convex/lib/rehydration.ts:19`) et `min(fenêtre × 0.5 × 3, plafond)` (`:88-91`) : un plafond **caractères** avec une hypothèse 3 car/tok optimiste pour du contenu dense (code, JSON, CJK — l'amont utilise 4 car/tok en général mais **2** pour les tool results, `preemptive-compaction.ts:26-27`). Ajouter un plafond sur `history + "\n\n" + userText` exprimé en tokens estimés, contre la fenêtre **live** (`sessionMeta.contextTokens`), avec la valeur **la plus petite** quand plusieurs `contextTokens` sont en jeu (bascule d'agent).

**4.2 Ne pas ré-hydrater dans une session déjà sous pression.** Si le fill estimé > 70 %, la rehydratation est inutile (le gateway a déjà l'historique) et nuisible.

*Vérification* : tests sur `rehydrationBudgetChars` + un nouveau `rehydrationTokenCeiling` (contenu dense → budget réduit) ; fixture « bascule d'agent avec deux fenêtres différentes ⇒ la plus petite gagne ».

### Couche 5 — DÉGRADATION GRACIEUSE ET SORTIE

**5.1 La carte `context_length` porte les actions.** Aujourd'hui elle n'affiche qu'un texte (`src/chat/runStatusView.ts:179`). Y attacher deux boutons câblés sur des mutations **existantes** : *Compacter et réessayer* (`api.agentFiles.compactSession`, `SessionPanel.tsx:152`) et *Nouvelle session à partir d'ici* (`api.chats.resetSession`, `:153`, ou le branchement de conversation déjà livré). Ce n'est pas un conseil de contournement : c'est le rétablissement de l'action légitime, exécutée par Atrium.

**5.2 Retry AUTOMATIQUE borné après compaction réussie.** Étendre `turnRetry` avec une règle distincte : `context_length` **n'est pas** retryable à l'identique (règle actuelle correcte, `convex/turnRetry.ts:62-66`), mais devient retryable **une fois** si et seulement si une compaction a réussi entre-temps et que le tour est à contenu nul (mêmes portes que `provider_internal` : `finalTextLen === 0 && partCount === 0`, `turnRetry.ts:114-117`). Introduire un code distinct, p.ex. `context_length_compacted`, pour ne pas relâcher la règle générale.

**5.3 Délégation automatique** (la voie « l'agent fait le travail », charte `design-agent-does-the-work-both-providers`) : sur `overflowTokens > 0`, Atrium ne compacte pas lui-même le sens — il **demande à l'agent** de déléguer le tour à un sous-agent frais (préambule injecté au dispatch, comme le registre `quote_reply` déjà en place). Fonctionne pour **les deux providers** (OpenClaw et Hermes savent tous deux spawner). **NON PROUVÉ** que le préambule soit systématiquement honoré → à valider en banc live avant d'y compter.

### Couche 6 — OBSERVABILITÉ (compléter l'existant, SOC2)

**6.1** Ajouter à `chat.gateway_pressure` (`bridge/src/core/turn-sink.ts:1397-1423`) : `budgetEstimatedPromptTokens`, `budgetOverflowTokens`, `budgetRoute`, `totalTokensFresh`, `contextSource`, `preflightCompactApplied`. Compteurs + codes stables uniquement.
**6.2** `errorCode` sur `subAgents` (`convex/schema.ts:1354-1380`), alimenté par le classifieur partagé, projeté dans `/api/v1/chat-state` — ferme l'item A du mémo.
**6.3** Un KPI « tours à > 85 % de remplissage » et « overflows terminaux / 1000 tours » dans `get_kpi`, pour prouver l'effet de chaque couche.

---

## 7. Répartition Atrium / opérateur gateway

### Sous notre contrôle (Atrium)

| Mesure | Couche | Effort | Vérification |
|---|---|---|---|
| Consommer `contextBudgetStatus` + `totalTokensFresh` | 1.1-1.2 | S | test `parseSessionMeta` + fixture `sessions.describe` amont |
| Garde anti-absurde sur `activeTokens` + source étiquetée | 1.3-1.4 | S | tests `sessionKnobs` |
| Estimateur Atrium (borne basse) | 2 | M | tests purs + corrélation traces |
| Garde pré-envoi graduée + compact préventif | 3 | L | tests intégration bridge + banc live |
| Plafond tokens rehydratation | 4 | M | tests `rehydration` |
| Actions sur la carte d'erreur | 5.1 | S | test UI + banc live |
| Retry après compaction (`context_length_compacted`) | 5.2 | M | tests `turnRetry` |
| `errorCode` sous-agents | 6.2 | M | test projection chat-state |
| Champs de trace supplémentaires | 6.1 | S | test writer + `get_trace_enrichment` |

### À remonter à l'opérateur du gateway (config, hors Atrium)

| Réglage | Effet | Preuve |
|---|---|---|
| **`agents.defaults.compaction.midTurnPrecheck.enabled = true`** | Ré-arme l'étage C — la garde conçue *exactement* pour « long tool-heavy sessions hit context overflow before normal turn-end compaction can run » | `schema.help.ts:1531-1532`, `attempt.ts:2729-2730` |
| **Faire déclarer au plugin LCM `promptAuthority: "preassembly_may_overflow"`** | Ré-arme l'étage B **et** réalimente `contextBudgetStatus` (donc la jauge fidèle) | `context-engine/types.ts:9-37`, `attempt.ts:4829-4847`, test amont `run.overflow-compaction.loop.test.ts:864-865` |
| Vérifier `turnMaintenanceMode` du plugin | Si `"background"`, la maintenance de tour est différée (`context-engine-maintenance.ts:695-722`) ; en 2026.7.1 cela n'atteint pas le preflight (`agent-runner-memory.ts:962`), mais c'est à surveiller à chaque montée de version | `compact.queued.ts:75-90` |
| Relever `agents.defaults.compaction.reserveTokens` | Déclenche la compaction plus tôt ; borné par `MIN_PROMPT_BUDGET` | `schema.help.ts:1509-1512`, `agent-settings.ts:65-88` |
| `agents.defaults.compaction.truncateAfterCompaction` + `maxActiveTranscriptBytes` | Ajoute un déclencheur **taille de transcrit**, indépendant des compteurs de tokens (donc immunisé au défaut §3.3) | `schema.help.ts:1521-1526`, `agent-runner-memory.ts:832-836` |
| Contrôler la surface d'outils par agent | Les schémas d'outils ne sont pas comptés par l'estimation amont | `preemptive-compaction.ts:258-274` |

Chacun de ces réglages est **vérifiable depuis Atrium** : le log `[context-overflow-precheck] skipped: context engine "…" owns compaction` (`attempt.ts:4850-4852`) prouve l'état de l'étage B, et l'apparition de `contextBudgetStatus` dans `sessions.describe` prouve son ré-armement.

---

## 8. Plan de vérification (ordre d'exécution)

1. **Constat de départ** : `sessions.describe` sur une session prod longue → noter `totalTokens`, `totalTokensFresh`, présence/absence de `contextBudgetStatus`. **Si absent ⇒ étage B confirmé désarmé en prod.**
2. **Fixtures amont** : extraire de `run.overflow-compaction.loop.test.ts` et `tool-result-context-guard.test.ts` les frames de la séquence precheck→compaction→retry, les figer dans `bridge/protocol/openclaw/2026.7.1/` et les rejouer contre le normalizer.
3. **Bancs unitaires** couches 1, 2, 4, 5.2 (purs, rapides).
4. **Banc live local** (`dev.sh`, charte `autonomous-live-local-testing`) : session gonflée jusqu'à 90 % ⇒ prouver le compact préventif ; forcer un refus de compaction ⇒ prouver la finalisation `context_length` **sans** `chat.send`.
5. **Bascule opérateur** : activer `midTurnPrecheck.enabled` sur le gateway de dev, rejouer le banc, mesurer la disparition des overflows terminaux.
6. **KPI avant/après** en prod sur 7 jours (couche 6.3).

---

## 9. NON PROUVÉ — et ce qu'il faut lire pour trancher

| # | Affirmation non prouvée | Comment trancher |
|---|---|---|
| 1 | Que `activeTokens` prod soit *réellement* tombé dans la branche cumulative lors de l'incident du 20/07 (179 k vs > 308 k). La branche existe (`session-store.ts:210-217` + `usage.ts:335`) ; qu'elle ait été empruntée n'est pas démontré. | Requêter `chat.gateway_pressure` du jour : comparer `postTotalTokens` (= `activeTokens`) et `postInputTokens`+`postOutputTokens`. Si `postTotalTokens ≫ contextTokens` ou incohérent avec input+output, la branche cumulative est prouvée. |
| 2 | Le comportement exact du plugin **lossless-claw / LCM** : sa valeur de `promptAuthority`, son `turnMaintenanceMode`, ses raisons de refus de `compact()`. Le plugin **n'est pas dans le dépôt amont** (le point d'extension seul y est : `src/context-engine/`). | Lire le source du plugin, ou l'observer : chercher `[context-overflow-precheck] skipped` dans les logs gateway, et corréler les raisons de compaction via `classifyCompactionReason` sur `/api/v1/compaction-history`. |
| 3 | Que le gateway 2026.7.1 peuple `chat:error.errorKind` (la note Atrium « real 2026.6.11 gateways do not populate errorKind » date de 2026.6.11, `normalizer.ts:1595-1600`). | Capture live 2026.7.1 : compter les `chat:error` portant `errorKind`. |
| 4 | Comparaison Hermes **0.18.2 vs 0.19.0** : ces versions n'existent pas comme tags du dépôt `/tmp/hermes-upstream.okb8T2` (tags datés uniquement, HEAD = `v2026.7.20`). | Confirmer le mapping paquet `hermes-agent` X.Y.Z ↔ tag daté (via `pyproject.toml` / `__version__` aux tags candidats), puis `git diff` ciblé sur `agent/context_compression*.py` et `tui_gateway/server.py`. |
| 5 | Qu'un préambule de délégation automatique (couche 5.3) soit honoré par les deux providers. | Banc live : 5 tours à > 85 % avec préambule, mesurer le taux de spawn effectif. |
| 6 | Le poids réel des schémas d'outils dans le prompt du déploiement (le chiffre 20-30 k vient de la doc Hermes, pas d'une mesure sur l'instance client). | `sessions.describe` avant/après désactivation d'un lot d'outils sur un agent, à transcrit constant. |

---

## Annexe A — Table des sites d'émission amont (v2026.7.1)

| Fonction / constante | Fichier:ligne |
|---|---|
| `PREEMPTIVE_OVERFLOW_ERROR_TEXT` | `src/agents/embedded-agent-runner/run/preemptive-compaction.ts:23-24` |
| `MID_TURN_PRECHECK_ERROR_MESSAGE` | `src/agents/embedded-agent-runner/run/midturn-precheck.ts:20-21` |
| Texte terminal utilisateur | `src/agents/embedded-agent-runner/run.ts:3032-3035` |
| `estimateLlmBoundaryTokenPressure` | `run/preemptive-compaction.ts:258-274` |
| `shouldPreemptivelyCompactBeforePrompt` | `run/preemptive-compaction.ts:311-392` |
| `formatPrePromptPrecheckLog` | `run/preemptive-compaction.ts:395-425` |
| `buildPrePromptContextBudgetStatus` | `run/preemptive-compaction.ts:428-467` |
| `shouldSkipPrecheck` | `run/attempt.ts:4843-4853` |
| `midTurnPrecheckEnabled` | `run/attempt.ts:2729-2730` |
| `installToolResultContextGuard` | `tool-result-context-guard.ts:469-566` |
| `shouldDisableAgentAutoCompaction` | `src/agents/agent-settings.ts:174-184` |
| `shouldRunPreflightCompaction` | `src/auto-reply/reply/memory-flush.ts:163-178` |
| Gate preflight + appel | `src/auto-reply/reply/agent-runner-memory.ts:883-891`, `:931-957` |
| `shouldDeferOwningContextEngineBudgetCompaction` | `compact.queued.ts:75-90` |
| `classifyCompactionReason` | `compact-reasons.ts:28-74` |
| `MAX_OVERFLOW_COMPACTION_ATTEMPTS` | `run.ts:1611` |
| Récupération overflow | `run.ts:2703-3072` |
| Signaux `{stream:"compaction"}` | `embedded-agent-subscribe.handlers.compaction.ts:61-69`, `:151-159` |
| `buildGatewaySessionRow` (→ `contextBudgetStatus`) | `src/gateway/session-utils.ts:2386-2408` |
| `buildGatewaySessionEventFields` (aplatissement agent events) | `src/gateway/session-event-payload.ts:16-90` |
| `deriveContextPromptTokens` / `deriveSessionTotalTokens` | `src/agents/usage.ts:308-336`, `:339-374` |
| Persistance `totalTokens` (repli cumulatif) | `src/agents/command/session-store.ts:206-249` |
| Affichage amont de l'estimation | `src/status/status-message.ts:228-256`, `:958-961` |
| `SessionContextBudgetStatus` (type) | `src/config/sessions/types.ts:97-121` |
| `ContextEngineInfo` / `promptAuthority` | `src/context-engine/types.ts:9-37`, `:210-222` |
| `SAFETY_MARGIN = 1.2` | `src/agents/compaction-planning.ts:17` |
| `MIN_PROMPT_BUDGET_*` | `src/agents/agent-compaction-constants.ts` |

## Annexe B — Table des sites Atrium

| Rôle | Fichier:ligne |
|---|---|
| `describe` pré-envoi (point d'insertion de la garde) | `bridge/src/server.ts:828-880` |
| `parseSessionMeta` (jette `contextBudgetStatus`, `totalTokensFresh`) | `bridge/src/server.ts:586-631` |
| `chat.send` + `beginTurn(pressure)` | `bridge/src/server.ts:1055-1078` |
| `performCompact` / route `/compact` | `bridge/src/server.ts:1167-1174`, `:2940-2960` |
| `performReset` / route `/reset` | `bridge/src/server.ts:1155-1159`, `:2249-2330` |
| `fetchCompactionHistory` | `bridge/src/server.ts:1183-1221` |
| Capture `diagUsage` | `bridge/src/providers/openclaw/normalizer.ts:1030-1039` |
| `CONTEXT_OVERFLOW_TEXT_RE` | `bridge/src/providers/openclaw/normalizer.ts:129-133` |
| Classification de repli `context_length` | `bridge/src/providers/openclaw/normalizer.ts:1596-1607` |
| Champs connus / non consommés (`totalTokensFresh`) | `bridge/src/providers/openclaw/protocol-drift.ts:78` |
| Trace de pression | `bridge/src/core/turn-sink.ts:1375-1424` |
| `reportSessionActiveTokens` | `bridge/src/core/turn-sink.ts:1425-1438`, `convex-writer.ts:1671-1682` |
| Usage Hermes `context_used`/`context_max` | `bridge/src/providers/hermes/ws-turn.ts:601-624` |
| `setSessionActiveTokens` (anti-régression horodatée) | `convex/stream.ts:1877-1905` |
| Schéma `sessionMeta` | `convex/schema.ts:1066-1079` |
| `KNOWN_ERROR_CODES` (allowlist SOC2) | `convex/lib/chatRenderState.ts:58-88` |
| `RETRYABLE_KINDS` | `convex/turnRetry.ts:62-66` |
| Bornes de rehydratation | `convex/lib/rehydration.ts:19`, `:88-91` |
| `effectiveContextUsed` | `src/chat/sessionKnobs.ts:115-126` |
| Carte d'erreur `context_length` | `src/chat/runStatusView.ts:179`, repli client `:213-217` |
| Jauge (seuils 75/90 %) | `src/chat/ConvexChat.tsx:1608-1618` |
| Actions compact/reset | `src/chat/SessionPanel.tsx:152-153` |
| `subAgents` (pas d'`errorCode`) | `convex/schema.ts:1354-1380` |
