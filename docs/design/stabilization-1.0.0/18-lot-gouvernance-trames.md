# Lot — le manifeste de couverture dit la vérité, et le processus qui l'y maintient

Lot de fondation du processus de gouvernance des trames protocole, validé sur six
points par le mainteneur avant exécution.

## Le défaut

La garde de couverture validait la **forme** des déclarations — chaque entrée a un
statut et une justification — et ne touchait jamais le code de production. Une
déclaration pouvait donc devenir fausse dans les deux sens, et les deux sont arrivés la
même semaine : un champ resté déclaré « non lu » après son implémentation
(`TaskSummary.progressSummary`), et sept champs de livraison cron restés « ignorés »
après que la chaîne du verdict de livraison s'est mise à consommer chacun d'eux. Un
inventaire faux est pire qu'aucun.

## La mesure qui l'a établi

Un balayage du code contre la déclaration, sur 26 champs (les 18 lacunes déclarées,
les 7 champs cron, un témoin cohérent) : 8 contradictions franches, 7 cas « code
présent mais flux absent », 11 cohérentes. Les 7 intermédiaires ont affiné la
conception : un lecteur écrit mais jamais alimenté n'est ni une consommation ni une
absence — il doit être **déclaré** (`knownReaders`), sinon la garde ne sait pas dire
la vérité sur cet état-là.

## La chaîne de correction

- **Le registre est le manifeste existant, enrichi** — pas un fichier parallèle. Les
  entrées gagnent `anchor` (mécanisme repris tel quel de la couverture des capacités
  Hermes : token vérifié dans la source débarrassée des commentaires), `knownReaders`,
  `proof` (corpus doré / banc / test déterministe justifié), `verifiedVersions`
  (sous-ensemble obligatoire des versions validées) et `contrib`. Le méta-schéma
  (`bridge/protocol/coverage.schema.json`) documente la forme ; la garde en épingle
  les énumérations pour que la documentation ne devienne pas une fiction.
- **La vérité est cliquetée champ par champ** (`truth-ratchet.json`, plancher figé
  dans la garde) : un `handled` cliqueté ancre une consommation réelle et porte une
  preuve ; un `gap`/`ignored` cliqueté n'est pas consommé, ou déclare chaque lecteur
  que le balayage trouve. Les huit contradictions sont corrigées avec ancres et
  preuves ; le littéral de synthèse du détecteur de dérive suit (166/413/17).
- **Le processus vit dans le dépôt** comme deux skills versionnées :
  `frame-discovery` (instruire UNE trame : sources amont épinglées, dossier, décision,
  chaîne complète, preuve, registre) et `upstream-contrib` (quatre portes avant toute
  ouverture, registre des contributions, synchronisation `gh`, rapport d'états).
- **Le registre des contributions amont** (`bridge/protocol/contrib/registry.json`)
  devient la deuxième exception nommée à la règle « pas de suivi de travail dans le
  dépôt », amendée aux trois endroits où elle vit — même argument que la première :
  hors du dépôt, un registre dérive.
- **La délégation est bornée et écrite** dans la skill : ouverture d'issues/PR sur les
  deux dépôts amont uniquement, après les quatre portes ; le push n'est permis que
  vers les forks de contribution — levée explicite et datée d'une règle par ailleurs
  absolue ; jamais de contenu conversationnel ni de noms d'instance dans une repro.

## Constats de revue

- Le premier passage de la garde a été prouvé rouge par quatre neutralisations : la
  dérive d'origine rejouée (le champ redevient « ignoré » → la garde nomme les deux
  fichiers qui le consomment), l'ancre supprimée, le cliquet rétréci, une version de
  preuve jamais validée.
- Le fichier du cliquet posé dans `coverage/` a cassé la bijection
  répertoires↔manifestes — la garde existante avait raison, le cliquet a déménagé à
  côté plutôt que d'affaiblir l'invariant.
- Le balayage a montré qu'un token générique ne peut pas porter la vérité :
  `idempotencyKey` existe côté Atrium pour un usage sortant sans rapport avec le champ
  résultat Talk. Les drapeaux `scan` sont donc **curés**, et la curation est motivée
  dans le fichier du cliquet.

## Les limites qui restent

- Les preuves des huit reclassements sont **déterministes, pas encore gagnées au
  banc** — admis et justifié entrée par entrée ; la sollicitation live reste due.
- L'angle mort assumé de la garde de forme demeure : un champ ajouté en amont à un
  schéma entièrement « ignoré » passe sans examen (contrôle compensatoire déclaré
  ailleurs). La vérité cliquetée ne couvre que les champs instruits.
- `2026.7.2` n'existe pas encore en amont ; la `beta.5` est vendorisée en
  préparation, ses champs nouveaux entrent en file de découverte comme lacunes —
  l'attestation, elle, ne se gagnera qu'au banc sur une passerelle réelle.
- L'atterrissage du compte rendu cron dans sa conversation (note 17) reste dû.
