# Estimation des coûts

Ce document chiffre ce que coûte QAI à faire tourner, pour servir de base à la
tarification. Les tailles d'arbre sont **mesurées**, pas estimées — reproduire
avec `npm run measure -- --url <votre-app>`.

## Ce qui coûte, et ce qui ne coûte rien

| Étage | Déclencheur | Appels de modèle |
|---|---|---|
| 1 — rejeu déterministe | chaque pull request | **aucun** |
| 2 — réparation | une cible devient introuvable | 1 par étape cassée |
| 3 — génération de résolution | création d'un scénario | ~1,5 par étape |

L'essentiel du volume — le rejeu — ne consomme aucun jeton. Ne coûtent que les
moments rares : quand l'interface bouge, et quand on crée un test.

## Le poids de l'arbre, mesuré

Un appel de modèle envoie l'arbre d'interface de l'écran courant. Sa taille
détermine donc le prix, et elle dépend de la page bien plus que du modèle.

| Page | Nœuds | Arbre complet | Interactif seul, sans géométrie |
|---|---:|---:|---:|
| Formulaire simple | 8 | 1 139 car. | 639 car. |
| **Page d'accueil réelle** (Next.js 16) | 520 | 77 431 car. | **21 627 car.** |
| Tableau de 150 lignes | 1 530 | 237 057 car. | 116 515 car. |
| Liste de 150 cartes (composants) | 1 818 | 251 431 car. | **77 860 car.** |

La ligne « page d'accueil réelle » est mesurée sur une application de
production — pas une page synthétique. Elle donne **~6 200 jetons**, soit le
quart de l'écran de référence retenu plus bas. Les chiffres qui suivent sont
donc **prudents** : une page ordinaire coûte nettement moins.

Deux corrections apportées pendant cette mesure valent d'être notées, parce
qu'elles rapportent 72 % sur une application moderne : le nom accessible n'est
plus déduit du contenu pour les conteneurs génériques (chaque `div`
d'emballage dupliquait le texte de ses descendants), et les emballages anonymes
à enfant unique sont aplatis. Sur une page à composants, l'arbre transmis passe
de 277 589 à 77 860 caractères.

> **Caractères ≠ jetons.** La suite raisonne sur une conversion prudente de
> **3,5 caractères par jeton**, plausible pour du JSON. Avant de figer un
> budget contractuel, recompter avec le décompte de jetons du fournisseur
> branché — c'est une mesure gratuite et exacte.

Écran chargé retenu comme référence : **~22 000 jetons** d'arbre.

## Coût d'un appel

Un appel de réparation transporte : instructions et schéma de réponse (~1 500
jetons, stables), l'arbre (~22 000 jetons, différent à chaque écran), et rend un
objet de ciblage (~300 jetons).

| Modèle | Entrée /Mjetons | Sortie /Mjetons | Un appel |
|---|---:|---:|---:|
| Opus 5 | 5 $ | 25 $ | **0,125 $** |
| Sonnet 5 | 3 $ | 15 $ | **0,075 $** |
| Haiku 4.5 | 1 $ | 5 $ | **0,025 $** |

Sans les deux corrections d'arbre ci-dessus, le même appel coûtait 0,41 $ sur
Opus 5. L'optimisation de l'arbre est le levier principal, avant le choix du
modèle.

**Le cache de prompt n'aide presque pas ici**, et c'est contre-intuitif : il ne
s'applique qu'au préfixe stable, soit 1 500 jetons sur 23 500. L'arbre, qui
représente 94 % de la charge, change à chaque écran. Concevoir autour du cache
serait une erreur d'optimisation — c'est la taille de l'arbre qu'il faut
travailler.

## Coût par unité de travail

| Unité | Détail | Opus 5 | Sonnet 5 | Haiku 4.5 |
|---|---|---:|---:|---:|
| Un rejeu | étage 1 | 0 $ | 0 $ | 0 $ |
| Une étape réparée | 1 appel | 0,13 $ | 0,08 $ | 0,03 $ |
| Un scénario de 9 étapes généré | ~14 appels | 1,80 $ | 1,10 $ | 0,36 $ |

## Un client type, par mois

Hypothèses : 50 scénarios, 20 pull requests par jour, 5 étapes réparées par jour
(interface qui bouge normalement), 10 nouveaux scénarios par mois.

| Poste | Volume mensuel | Coût (Sonnet 5) |
|---|---|---:|
| Rejeu | 30 000 runs | 0 $ |
| Réparations | 150 appels | 11 $ |
| Nouveaux scénarios | 10 | 11 $ |
| Calcul navigateur | ~40 h de conteneur | 20–50 $ |
| **Total** | | **≈ 45–75 $** |

Le coût marginal ressort donc autour de **1 à 1,50 $ par parcours et par mois**.

## Ce que ça implique pour la tarification

Trois faits à garder pour l'arbitrage tarifaire :

1. **QA Wolf facture 40 à 70 $ par parcours et par mois** pour un service
   managé. Notre coût marginal est trente à cinquante fois inférieur. La marge
   n'est pas le sujet ; le prix se fixera sur la valeur, pas sur le coût.
2. **Le coût ne suit pas le nombre de runs**, il suit le nombre de *parcours* et
   la *fréquence de changement de l'interface*. Facturer à l'exécution punirait
   exactement le comportement qu'on veut encourager — tester à chaque PR. Un
   tarif par parcours actif colle à la structure de coût.
3. **Le calcul navigateur dépasse les jetons** dans ce modèle. C'est
   contre-intuitif pour un produit « IA » et ça oriente l'optimisation : la
   parallélisation et le temps de conteneur comptent plus que le choix du
   modèle.

Deux risques à surveiller. Un client dont l'application change beaucoup fait
grimper les réparations — un plafond par période, déjà implémenté
(`BudgetedProvider`), protège la marge. Et sur mobile, une application mal
étiquetée dégrade vers la vision, dont le coût par appel est bien supérieur :
la parité de tarif web/mobile ne va pas de soi.

## Le modèle est choisi par le client

QAI n'embarque aucun SDK de fournisseur. Le client implémente `ModelProvider`
(voir [docs/modele.md](modele.md)) avec le modèle de son choix et déclare son
tarif ; `BudgetedProvider` applique alors un plafond en jetons, en appels ou en
dépense. Les trois colonnes ci-dessus ne sont donc pas un choix de notre part,
mais l'ordre de grandeur que le client arbitre lui-même.
