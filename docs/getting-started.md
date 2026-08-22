# Prise en main

Ce guide fait tourner QAI de bout en bout sur une boutique de démonstration, y
compris sur une version volontairement cassée. Comptez cinq minutes.

## Installation

```bash
npm install
npx playwright install chromium
npm test
```

Toute la suite doit passer. Elle inclut un parcours de commande complet joué
dans un vrai navigateur, et une génération de résolution de bout en bout.

## 1. Lancer la boutique de démonstration

Dans un premier terminal :

```bash
npm run demo
```

Elle écoute sur `http://127.0.0.1:8899/`. C'est une boutique minimale — recherche,
fiche produit, panier, tunnel invité, suivi de commande — qui sert de cobaye.

## 2. Vérifier la cohérence avant de jouer

```bash
npm run qai -- check examples/checkout-guest.qai.yaml
```

Cette commande ne lance aucun navigateur. Elle compare le scénario et sa
résolution et refuse de continuer s'ils ont dérivé : étape ajoutée sans
régénération du cache, assertion reformulée dont la forme machine est restée sur
l'ancien texte, résolution orpheline. Aucun de ces cas ne casse à l'exécution —
ils produisent des faux verts, ce qui est pire.

## 3. Rejouer le parcours

```bash
npm run qai -- run examples/checkout-guest.qai.yaml \
  --base-url http://127.0.0.1:8899/ \
  --states ./examples/states-exemple.ts
```

`--states` fournit l'état déclaré par le bloc `given` du scénario — sans lui,
QAI refuse de jouer un parcours qui exige un état (voir [etats.md](etats.md)).

```
1 parcours — RÉUSSI   1.6 s

  ✓ checkout-guest         RÉUSSI  1.2 s

Tout est vert.
```

Un parcours vert ne détaille pas ses étapes : le détail n'apparaît qu'à
l'échec, là où il sert.

Ce rejeu n'a coûté aucun appel de modèle. Tout ce dont il avait besoin était
déjà dans `examples/.qai/resolutions/checkout-guest.web.json`.

## 4. Casser l'application et recommencer

Dans un second terminal, la même boutique avec une régression du tunnel invité —
la commande part, le backend la rejette, et l'interface n'affiche rien :

```bash
npm run demo -- --bug guest-confirm --port 8898
```

```bash
npm run qai -- run examples/checkout-guest.qai.yaml \
  --base-url http://127.0.0.1:8898/ \
  --states ./examples/states-exemple.ts
```

```
1 parcours — ÉCHEC   6.8 s

  ✖ checkout-guest         ÉCHEC   6.4 s
    ✖ s8   payer avec la carte de test
          capture « commande » : cible introuvable ou ambiguë
          la commande est confirmée → aucun élément ne correspond à la cible
          un numéro de commande est affiché → aucun élément ne correspond à la cible

1 parcours en échec.
```

Code de sortie 1, donc la CI casse la pull request.

Deux choses méritent d'être remarquées. L'échec porte sur une **assertion**,
donc le réparateur n'a même pas été convoqué — même avec `--heal`, il n'a pas
le droit de toucher à ce qui est vérifié. Si le bouton avait simplement changé
de libellé, QAI aurait réparé, affiché un `~` et proposé le diff de résolution
en revue. **Il distingue un test périmé d'une application cassée**, et c'est
toute la différence entre un outil de test et un outil auquel on fait
confiance.

Ensuite, les étapes après `s8` n'ont pas été exécutées : après un échec, l'état
de l'application a divergé et poursuivre ne produirait que du bruit. Les 6
secondes, elles, sont la fenêtre d'assertion : l'échec n'est prononcé qu'après
avoir laissé au rendu le temps d'arriver (`--assert-timeout`, 5 s par défaut).

## 5. Écrire votre propre scénario

Un scénario décrit des intentions, jamais des sélecteurs :

```yaml
id: login
title: Un client existant se connecte
tags: [critical-path]

given:
  state: visiteur-anonyme

steps:
  - id: s1
    do: ouvrir la page de connexion
  - id: s2
    do: saisir l'identifiant "client@test.fr" et le mot de passe de test
  - id: s3
    do: valider le formulaire
    expect: le menu affiche le nom du compte
```

Le format complet est décrit dans [scenario-format.md](scenario-format.md), et
[schema/scenario.schema.json](../schema/scenario.schema.json) le valide.

## 6. Le faire jouer

Un scénario seul ne suffit pas : il lui faut sa résolution. `qai resolve` la
produit, en confrontant chaque proposition du modèle à votre application avant
de l'accepter.

```bash
npm run qai -- resolve mon-parcours.qai.yaml \
  --base-url http://localhost:3000 \
  --provider ./mon-fournisseur.ts \
  --max-cost 2
```

Le fournisseur est le vôtre : QAI n'embarque aucun SDK de modèle. Partez de
[examples/provider-exemple.ts](../examples/provider-exemple.ts) — une méthode à
écrire. Le détail de la boucle est dans [generation.md](generation.md).

Ensuite, `check` puis `run` comme aux points 2 et 3.

## 7. Laisser QAI réparer un test périmé

Troisième mode de la boutique : un libellé change, sans aucune régression.

```bash
npm run demo -- --bug rename-guest --port 8897
```

```bash
npm run qai -- run examples/checkout-guest.qai.yaml \
  --base-url http://127.0.0.1:8897/ \
  --states ./examples/states-exemple.ts \
  --heal --provider ./mon-fournisseur.ts --max-cost 1
```

```
1 parcours — RÉPARÉ   5.1 s

  ~ checkout-guest         RÉPARÉ  4.7 s
    ~ s6   lancer la commande en tant qu'invité
          réparé : Le libellé du bouton de commande invité est passé de
          « Commander en tant qu'invité » à « Continuer sans compte ».

1 réparation(s) : relire les diffs de résolution avant de fusionner.
dépense modèle : 0.0023 (1 appels)
```

Sortie authentique — un appel de modèle, un quart de centime. Le fichier de
résolution est réécrit et le diff tient en quelques lignes avec la raison
attachée. Comparez avec le point 4 : là, l'échec portait sur une assertion et
le réparateur n'a même pas été convoqué. **C'est la différence entre un test
périmé et une application cassée** — voir [reparation.md](reparation.md).

## 8. Jouer toute la suite

`run` et `check` acceptent des fichiers, des dossiers ou un motif du shell, et
exécutent les parcours en parallèle :

```bash
npm run qai -- run examples/ --base-url http://127.0.0.1:8899/ --states ./examples/states-exemple.ts --workers 4
```

```
2 parcours — RÉUSSI   1.8 s

  ✓ checkout-guest         RÉUSSI  1.2 s
  ✓ compte-connecte        RÉUSSI  536 ms

Tout est vert.
```

Chaque parcours obtient un navigateur neuf : partager le navigateur ferait fuiter
cookies et stockage d'un parcours à l'autre, et le coût de démarrage est le prix
de l'isolement.

`--states` fournit l'état déclaré par le bloc `given` d'un scénario — voir
[etats.md](etats.md). Sans lui, `compte-connecte` échoue : il exige une session
ouverte.

## Ce qui n'existe pas encore

- **Les drivers mobiles.** L'intégration CI, elle, existe : voir
  [ci.md](ci.md).
