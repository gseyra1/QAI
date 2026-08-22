# Format de scénario QAI

Ce document définit le format dans lequel les tests sont écrits. C'est la
décision la plus structurante du produit : une fois que des clients auront
écrit des scénarios, ce format ne pourra plus changer sans casser leur travail.

## L'idée centrale : séparer l'intention de sa résolution

Un test QAI est constitué de **deux fichiers de nature différente**, et c'est
cette séparation qui rend possibles à la fois la portabilité web/mobile et le
modèle de coûts.

**Le scénario** (`*.qai.yaml`) décrit *ce que l'utilisateur veut faire*. Il est
écrit par un humain ou généré par l'agent, versionné dans git, relu en revue de
code. Il ne contient **jamais** de sélecteur CSS, de XPath, d'identifiant
technique ni de coordonnée. Il est indépendant de la plateforme.

**La résolution** (`.qai/resolutions/<scenario>.<plateforme>.json`) décrit
*comment cette intention a été satisfaite la dernière fois, sur cette
plateforme*. Elle est produite par la machine, versionnée elle aussi, mais
régénérable et jetable.

```
checkout-guest.qai.yaml          ← une intention
  └── checkout-guest.web.json    ← sa résolution sur le web
  └── checkout-guest.ios.json    ← sa résolution sur iOS
  └── checkout-guest.android.json
```

Trois conséquences découlent directement de cette séparation :

1. **Portage mobile sans réécriture.** Ajouter le support d'une app mobile
   consiste à générer un nouveau fichier de résolution, pas à réécrire les
   tests. C'est le différenciateur produit, et il tient entièrement dans cette
   ligne.

2. **Coût d'exécution nul en régime nominal.** La résolution contient tout ce
   qu'il faut pour rejouer le parcours sans appeler de modèle. Le modèle
   n'intervient qu'à la création et à la casse.

3. **Réparation auditable.** Comme la résolution est versionnée, une
   auto-réparation apparaît sous forme de diff git dans la pull request. Le
   client voit exactement ce que l'agent a modifié, au lieu de faire confiance
   à une boîte noire. C'est un argument commercial obtenu gratuitement.

## Anatomie d'un scénario

```yaml
id: checkout-guest
title: Un visiteur non connecté peut commander un article
tags: [critical-path, revenue]

given:
  fixtures: [catalogue-standard]
  state: visiteur-anonyme

steps:
  - id: s1
    do: ouvrir la page d'accueil de la boutique

  - id: s2
    do: rechercher "chaise de bureau"
    expect: la liste de résultats contient au moins un article

  - id: s3
    do: ouvrir le premier article de la liste
    capture:
      article: le nom de l'article
      prix: le prix affiché

  - id: s4
    do: ajouter l'article au panier
    expect: l'indicateur du panier affiche 1 article

  - id: s5
    do: ouvrir le panier
    expect:
      - le panier contient "{{article}}"
      - le total est égal à {{prix}}
```

### Les clés en anglais, le contenu dans la langue de l'équipe

La structure (`id`, `do`, `expect`) est en anglais par convention. Le corps des
étapes est en langage naturel, dans **la langue que l'équipe utilise déjà**. Une
équipe francophone écrit ses scénarios en français, sans perte : c'est le modèle
qui interprète l'intention, pas un parseur. C'est un avantage direct sur les
outils américains du marché, qui supposent tous l'anglais.

### `id` — l'ancre de la résolution

Chaque étape porte un identifiant stable. Il est attribué à la création et ne
change **jamais**, même si le texte de l'étape est reformulé.

C'est un point subtil mais critique : si les étapes étaient identifiées par leur
position, insérer une étape en milieu de parcours invaliderait le cache de
toutes les suivantes, et un scénario de trente étapes coûterait une résolution
complète à chaque édition. L'identifiant stable rend le coût d'une modification
proportionnel à la modification.

### `capture` — pour ne pas figer les données

`capture` extrait une valeur de l'écran et la rend disponible aux étapes
suivantes via `{{nom}}`. C'est ce qui permet d'écrire des assertions qui ont du
sens (« le total est égal au prix vu sur la fiche produit ») plutôt que des
constantes qui cassent au premier changement de catalogue.

### `expect` — y compris sur l'adresse

Une attente se formule en langage naturel, et le modèle choisit la forme
machine. Elle peut porter sur l'adresse aussi bien que sur l'écran :

```yaml
  - id: s2
    do: ouvrir /admin sans être connecté
    expect: l'utilisateur est redirigé vers la page de connexion
```

se résout en `{ "check": "urlContains", "value": "/connexion" }`. Le scénario ne
mentionne toujours aucune URL : c'est une intention, et le chemin exact reste un
détail de résolution — il changera sans que le scénario bouge.

### `given` — l'état de départ

Un scénario ne construit pas son propre contexte à coups de clics : il déclare
l'état dont il a besoin. Les `fixtures` sont des jeux de données nommés, définis
ailleurs et spécifiques à l'environnement. C'est le poste de coût caché du test
de bout en bout, et le traiter comme un citoyen de première classe dès le
départ évite la dette la plus fréquente du domaine.

## Divergence entre plateformes

Le format vise la portabilité par défaut, mais certains parcours divergent
réellement — un survol n'existe pas sur mobile, un tunnel de paiement en une
page sur le web peut se dérouler sur trois écrans dans l'app. Sans échappatoire,
la promesse de portabilité casse au premier contact avec la réalité et l'équipe
abandonne le format.

Deux mécanismes, tous deux **explicites et visibles en revue** :

```yaml
  # Affiner une étape par plateforme, en gardant une intention commune
  - id: s5
    do: ouvrir le panier
    per_platform:
      web: cliquer sur l'icône panier dans l'en-tête
      mobile: ouvrir l'onglet Panier de la barre de navigation

  # Restreindre une étape à certaines plateformes
  - id: s7
    do: survoler la vignette pour afficher l'aperçu rapide
    only: [web]
```

La règle de conception : `do` seul est le cas normal, `per_platform` et `only`
sont des exceptions qu'on doit pouvoir compter. Si un scénario en est constellé,
c'est que les deux applications ont des parcours réellement différents et qu'il
faut deux scénarios — mieux vaut le rendre visible que le maquiller.

> **Ne jamais renommer `per_platform` en `on`.** C'est tentant, c'est plus court,
> et ça casse tout : YAML 1.1 — qu'implémentent PyYAML et de nombreux parseurs —
> interprète la clé `on` comme le booléen `true`. Le bloc de divergence
> disparaîtrait silencieusement, sans erreur, et les scénarios mobiles
> tomberaient sur l'intention générique sans que personne ne le voie. Pour la
> même raison, les mots `yes`, `no`, `off`, `y` et `n` sont proscrits comme clés
> du format.

## La frontière de sécurité de l'auto-réparation

C'est la règle qui protège la crédibilité du produit, et elle n'est pas
négociable :

> **La réparation peut changer *comment* on atteint un élément.
> Elle ne peut jamais changer *ce qui est affirmé* sur lui.**

Si l'étape `s4` échoue parce que l'indicateur du panier a changé de place,
l'agent a le droit de le retrouver. S'il le retrouve et qu'il affiche `0`, c'est
un **échec**, pas une réparation. Un système d'auto-réparation qui a le droit de
toucher aux assertions ne détecte plus de régressions : il apprend à faire
passer les bugs.

Trois garde-fous complètent la règle :

- **Une réparation est bornée.** Au-delà d'un nombre d'étapes réparées dans un
  même run, l'exécution s'arrête et remonte à un humain. Une dérive massive
  signifie que l'application a changé de nature, pas que le test est périmé.
- **Une réparation ne peut pas supprimer d'étape.** Contourner une étape qui ne
  passe plus est précisément la définition d'un faux négatif.
- **Une réparation est un diff.** Elle apparaît dans la revue, avec une capture
  avant/après. Personne n'a à croire l'agent sur parole.

## Les trois étages d'exécution

Le format est conçu pour que chaque étage soit possible sans le réécrire :

| Étage | Déclencheur | Coût modèle | Fréquence attendue |
|---|---|---|---|
| Rejeu déterministe | résolution présente et valide | nul | ~95 % des runs |
| Réparation | une étape échoue à se résoudre | proportionnel à la casse | à chaque évolution d'UI |
| Exploration agentique | création d'un scénario, découverte | élevé | rare, à forte valeur |

C'est cette répartition qui rend un tarif self-serve viable là où des
concurrents ont échoué sur leurs coûts d'infrastructure.

## Ce que le format n'a pas, volontairement

- **Pas de boucles ni de conditions.** Un scénario est un parcours linéaire. Le
  jour où on a besoin de logique, c'est qu'on écrit un programme, et un mauvais.
  Deux scénarios valent mieux qu'un `if`.
- **Pas de sélecteurs, même en échappatoire.** Autoriser un `selector:` « juste
  pour les cas difficiles » suffirait à tuer la portabilité mobile : le champ
  serait utilisé partout en six mois. Les cas difficiles se traitent dans la
  couche de résolution, pas dans l'intention.
- **Pas d'assertions techniques** (codes HTTP, contenu de base de données) dans
  le scénario d'interface. Ça viendra, mais dans un type de test distinct.
