# Prise en main

Ce guide fait tourner QAI de bout en bout sur une boutique de démonstration, y
compris sur une version volontairement cassée. Comptez cinq minutes.

## Installation

```bash
npm install
npx playwright install chromium
npm test
```

Les 53 tests doivent passer. Ils incluent un parcours de commande complet joué
dans un vrai navigateur.

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
npm run qai -- run examples/checkout-guest.qai.yaml --base-url http://127.0.0.1:8899/
```

```
checkout-guest — RÉUSSI   1.2 s
Un visiteur non connecté peut commander un article

  ✓ s1   ouvrir la page d'accueil de la boutique
  ✓ s2   rechercher "chaise de bureau"
  ✓ s3   ouvrir le premier article de la liste
  ✓ s4   ajouter l'article au panier
  ✓ s5   cliquer sur l'icône panier dans l'en-tête
  ✓ s6   lancer la commande en tant qu'invité
  ✓ s7   renseigner l'adresse de livraison avec le jeu de données "client-fr"
  ✓ s8   payer avec la carte de test
  ✓ s9   vérifier que la commande apparaît dans le suivi
```

Ce rejeu n'a coûté aucun appel de modèle. Tout ce dont il avait besoin était
déjà dans `examples/.qai/resolutions/checkout-guest.web.json`.

## 4. Casser l'application et recommencer

Dans un second terminal, la même boutique avec une régression du tunnel invité —
la commande part, le backend la rejette, et l'interface n'affiche rien :

```bash
npm run demo -- --bug guest-confirm --port 8898
```

```bash
npm run qai -- run examples/checkout-guest.qai.yaml --base-url http://127.0.0.1:8898/
```

```
checkout-guest — ÉCHEC   1.2 s

  ✓ s1…s7
  ✖ s8   payer avec la carte de test
        capture « commande » : cible introuvable ou ambiguë
        la commande est confirmée → aucun élément ne correspond à la cible
        un numéro de commande est affiché → aucun élément ne correspond à la cible
  ⊘ s9   vérifier que la commande apparaît dans le suivi

Aucune réparation appliquée : une assertion fausse est une régression.
```

Code de sortie 1, donc la CI casse la pull request.

Deux choses méritent d'être remarquées. La dernière ligne n'est pas décorative :
l'échec porte sur une assertion, donc le réparateur n'a même pas été convoqué.
Si le bouton avait simplement changé de libellé, QAI aurait réparé, affiché un
`~` et proposé le diff de résolution en revue. **Il distingue un test périmé
d'une application cassée**, et c'est toute la différence entre un outil de test
et un outil auquel on fait confiance.

Ensuite, l'étape `s9` est marquée ignorée plutôt qu'exécutée : après un échec,
l'état de l'application a divergé et poursuivre ne produirait que du bruit.

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

## Ce qui n'existe pas encore

Ce guide s'arrête ici parce que la suite n'est pas écrite :

- **La génération de résolutions.** Aujourd'hui le fichier
  `.qai/resolutions/*.json` s'écrit à la main. C'est l'étage 3 — l'agent explore
  l'application et le produit — et il reste à faire. Sans lui, un scénario écrit
  au point 5 ne peut pas encore être joué.
- **L'étage 2, la réparation.** L'interface `Healer` est définie et le moteur
  l'appelle au bon endroit, mais aucune implémentation n'existe.
- **L'intégration CI** et le commentaire de pull request.
- **Les drivers mobiles.**

Ce qui fonctionne : le format, le driver web, le rejeu déterministe, les
assertions, les captures et le contrôle de cohérence.
