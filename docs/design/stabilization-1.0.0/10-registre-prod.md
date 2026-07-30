# Registre des défaillances PRODUCTION (juillet 2026) — preuve terrain

Source : rapports de feedback prod (instance `client-1`, agent `agent-1` sauf mention),
traces `/api/v1/traces`, anomalies, logs gateway. Chaque entrée est traçable à une
référence de rapport ou à un identifiant de trace. Ce document existe pour ancrer la
priorisation du programme 1.0.0 sur ce que les utilisateurs ont RÉELLEMENT vécu — les
agents de reconnaissance lisent le code, pas la production.

Contexte business : les clients se détournent d'Atrium en le jugeant trop
instable. Le volume d'usage prod est faible (KPI : trafic quasi nul la plupart des
heures), donc **chaque incident vécu compte double** — il n'est pas noyé dans la masse,
il EST l'expérience de l'utilisateur.

## Tableau des incidents (du plus récent au plus ancien)

| Date | Réf. rapport | Symptôme utilisateur | Cause établie | Statut |
|---|---|---|---|---|
| 23/07 | (rapport du mainteneur, capture) | Pas de chrono sur un bloc de résultat en cours de traitement | Angle mort : le chrono ne couvrait ni les tours délégués dont la bulle porte déjà du texte. Révélé par l'entrelacement 0.68.0 (le parent se finalise plus tôt) | Corrigé (0.68.10 draftée) |
| 22/07 | ms767taran… | « Dans la liste de chat, je ne vois pas l'indicateur qui montre que l'agent travaille, alors que sur la page si » | Le signal busy de la sidebar ne lisait que les messages en streaming ; un sous-agent actif (parent finalisé) n'allumait rien | Corrigé (0.68.9 publiée) |
| 22/07 | ms79pj7vea… + ms7afet26q… | « ça fout la merde ça ! » / « c'est quoi ça encore ? » — Context overflow en pleine session de travail (compte rendu de réunion), puis échec de la reprise | Session à 262-265k tokens actifs. La compaction différée (LCM) n'a pas dégonflé avant le mur. Injections knowledge massivement hors sujet (~4k/tour) | **NON CORRIGÉ** — remède actuel : réinitialiser la session à la main |
| 21/07 (soir) | ms72saeh4p… | Erreur affichée en plein travail (classement d'un cahier des charges CNRS) | `server_error` du transport OpenAI. Logs gateway : `model-fallback/decision … next=none` — aucun modèle de secours armé. Auto-retry Atrium retenu à raison (4 outils déjà exécutés) | Atténué (fallback modèle armé sur les 2 gateways le 22/07) |
| 21/07 (matin) | ms746b01zr… | Réponse complète barrée d'un badge d'erreur + message de suivi silencieusement avalé | Course announce×envoi : le gateway a tué le tour réel au profit de la livraison du sous-agent ; verrou de session au finalize | Corrigé (0.68.5) |
| 20/07 | ms7a06nam… | Erreur interne du provider, tour perdu | Panne transitoire OpenAI | Corrigé (classe `provider_internal` auto-retryable, 0.68.3) |
| 20/07 | 2 rapports | Context overflow ×2 sur le même chat (comparateur d'écrans) | Débordement EN PLEIN TOUR (16 web_search + 5 web_fetch dans un seul tour). **Jauge affichée mensongère** : 179k affichés alors que l'estimation réelle du prompt dépassait le budget de 308k | **NON CORRIGÉ** |
| 19/07 | 3 rapports | Bulles assistant complètes mais VIDES après 7-8 min d'attente | Clôture propre du run sans contenu ni travail (sentinelle NO_REPLY / grâce de fin vide) — zone morte du garde | Corrigé (0.68.0, classe `empty_response_silent`) |
| 17/07 | ms74k8ryfd… | Tours en échec, 0 octet | Jeton OAuth per-agent invalidé côté OpenAI | Traité (re-login) |
| 17/07 | ms711d3fy4… | Conversations longues systématiquement en échec de compaction | Le host refusait l'override du summaryModel du plugin lossless-claw | Traité (config gateway) |

## Ce que ce registre dit de la priorisation

1. **Le débordement de contexte est la seule classe encore ACTIVE et non corrigée.**
   Trois occurrences en trois jours (20/07 ×2, 22/07 ×2), toutes avec le même
   dénouement : l'utilisateur perd son tour et doit réinitialiser à la main. C'est
   aussi la plus coûteuse socialement — elle frappe en plein travail utile (compte
   rendu de réunion à diffuser aux associés, comparateur d'achat). **Priorité 1
   incontestable.**

2. **La jauge de contexte MENT.** Incident du 20/07 : 179k affichés, mur à ~308k de
   budget réel. Un utilisateur ne peut pas s'autoréguler avec un instrument faux — et
   nous-mêmes avons diagnostiqué de travers au premier passage (une proposition de
   plafond à 160k a été émise puis réfutée par sondes). Une mesure fidèle est un
   prérequis de toute défense en profondeur.

3. **Les défauts de trames/ordre ont TOUS été découverts par un utilisateur, jamais
   par nous.** 19/07, 21/07, 22/07, 23/07 : quatre classes distinctes, quatre fois
   c'est un utilisateur qui a signalé. Aucune n'a été détectée par un test, une alerte ou une
   sonde. C'est exactement le trou que l'auto-découverte des trames doit fermer :
   le système doit se plaindre AVANT l'utilisateur.

4. **Les corrections tiennent** : aucune classe corrigée n'est revenue. Le problème
   n'est pas la qualité des correctifs, c'est le DÉLAI DE DÉTECTION et le fait que
   chaque défaut soit découvert en production, par le client.

5. **Un défaut hors périmètre Atrium mais qui abîme la confiance** : le 22/07, l'agent
   a modifié un mémo validé au lieu du compte rendu et le mail aux associés était déjà
   parti quand l'utilisateur l'a repris. C'est du comportement d'agent (briefing
   gateway), pas du protocole — mais pour le client, « Atrium a fait n'importe quoi ».
   À traiter côté briefing/validation d'actions à effet de bord, sinon le programme
   technique ne suffira pas à récupérer la confiance.

## Signaux d'infrastructure relevés au passage (côté gateway, pas Atrium)

- `before_prompt_build handler from openclaw-knowledge failed: timed out after 15000ms`
  à CHAQUE tour sur le gateway jerome (pgvector répond pourtant en ~500 ms) : **+15 s
  de latence silencieuse par tour**. Jamais remonté à l'utilisateur, jamais alerté.
- Injections knowledge hors sujet massives (Yi King, gouvernance de sangha) dans des
  conversations sans rapport — pollution du contexte qui **alimente directement le
  débordement**.
- LCM (lossless-claw) : 264 conversations pour 42 résumés, condensation hiérarchique
  jamais exécutée, lanes fragmentées par rollover (réparées le 20/07).

Ces trois points ne sont pas du code Atrium, mais ils causent des symptômes qu'Atrium
encaisse et affiche. Le programme doit dire explicitement ce qu'Atrium peut absorber
(défense en profondeur, mesure fidèle, dégradation gracieuse) et ce qui doit remonter
à l'opérateur (config gateway), plutôt que de laisser la frontière floue.
