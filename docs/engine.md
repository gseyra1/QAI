# Le moteur de rejeu

Le moteur prend un scénario, sa résolution et un driver, et produit un rapport.
Il ignore totalement la plateforme : c'est le driver qui la connaît.

## L'étage 1, celui qui doit coûter zéro

En régime nominal, le moteur ne fait qu'exécuter ce que la résolution contient
déjà. Aucun appel de modèle, aucune inférence, aucune interprétation du langage
naturel — le texte de l'intention n'est utilisé que pour l'affichage du rapport.
C'est ce qui rend le coût d'un run négligeable et un tarif self-serve viable.

## Une intention, plusieurs gestes

Une étape se résout en une **liste** d'actions, pas une seule : « renseigner
l'adresse de livraison » ou « se connecter » correspondent à plusieurs gestes
primitifs. Les assertions et les captures sont évaluées après le dernier geste
de l'étape, et **réévaluées tant qu'elles sont fausses** dans une fenêtre bornée
(`--assert-timeout`, 5 s par défaut).

Cette fenêtre n'assouplit rien : l'assertion n'est ni réécrite ni élargie, on lui
laisse le temps d'être vraie. Elle existe parce que le repos réseau ne signe pas
la fin du rendu — une scène 3D, une animation d'entrée ou un module chargé à la
demande arrivent après. Sans elle, ces applications ne peuvent affirmer aucun
écran.

## Les assertions vivent ici, pas dans les drivers

`matchNodes()` apparie un locator contre l'arbre observé, et `evaluateCheck()`
applique le contrôle. Les deux sont des fonctions pures, testables sans
navigateur, et **communes à toutes les plateformes**. C'est la garantie
structurelle que « le total est égal à 42 » veut dire exactement la même chose
sur le web et sur mobile.

La lecture des nombres tolère les formats français et anglais : `129,00 €`,
`$1,234.56` et `1 234,56 €` se comparent sans que le scénario ait à s'en
soucier. Un point suivi de trois chiffres est traité comme séparateur de
milliers — le pari juste sur des montants affichés.

`evaluateCheck()` reçoit un contexte — l'arbre, l'adresse courante, les captures
déjà connues — et non le seul arbre. C'est ce qui permet à une vérification de
porter sur autre chose qu'un nœud.

### Vérifier l'adresse

`urlContains` et `urlEquals` sont les deux seules vérifications **sans cible** :
une URL n'est pas un nœud de l'interface. Elles rendent exprimable la famille
entière des parcours de droits d'accès — « l'utilisateur anonyme est redirigé
vers la connexion » — qui n'a rien à affirmer sur l'écran d'arrivée sinon
l'endroit où il a atterri.

```json
{ "check": "urlContains", "value": "/connexion" }
{ "check": "urlEquals", "value": "https://app.exemple.fr/connexion?next=/admin" }
```

La comparaison est **brute** : ni barre finale, ni paramètre de requête, ni
fragment ne sont normalisés. Les effacer ferait passer une redirection vers
`/connexion?next=/admin` pour une redirection vers `/connexion`, alors que la
différence est précisément ce qu'un parcours de droits cherche à prouver.
`urlContains` couvre le cas courant où seul le chemin compte.

La valeur accepte `{{capture}}`, ce qui permet d'affirmer une adresse construite
à l'étape précédente — `/eleves/{{id}}` après la création d'une fiche.

Comme toute assertion, une vérification d'URL est réévaluée dans la fenêtre
`assertTimeout` : une redirection qui arrive après le repos réseau est vue.

## Ce que l'application a fait, pas seulement ce qu'elle affiche

Le driver écoute passivement le réseau et la console pendant chaque étape. Rien
n'est bloqué ni modifié : `drainObservations()` rend ce qui s'est accumulé et
vide le tampon, ce qui découpe l'observation par étape sans que le driver ait à
connaître la notion d'étape.

Cette information est la seule qui sépare deux écrans identiques : une liste
vide parce qu'il n'y a rien à montrer, et une liste vide parce que l'appel qui
la remplit a rendu 500. Sans elle, le rapport dit « élément introuvable » là où
la cause est ailleurs.

Les requêtes en échec et les erreurs console apparaissent dans le rapport
**uniquement sur une étape cassée ou signalée** — partout ailleurs elles
gonfleraient le rapport sans rien apprendre.

### Deux niveaux, tous deux optionnels

**Assertion d'étape**, déclarée comme les autres :

```json
{ "check": "noFailedRequests", "allow": ["/api/telemetrie"] }
{ "check": "noConsoleErrors" }
```

**Garde-fou de suite**, dans `qai.config.json` :

```json
"watchdogs": { "consoleErrors": "warn", "requestFailures": "fail", "allow": ["/analytics"] }
```

Le défaut est `off` sur les deux. Ce n'est pas de la timidité : les poser
d'emblée en `fail` ferait échouer des suites entières le jour de la mise à
jour, sur des erreurs préexistantes. La montée se fait en deux temps — `warn`,
puis `fail` une fois le bruit connu inscrit dans `allow`.

`allow` existe pour la même raison : une intégration tierce bruyante ne doit
pas apprendre à l'équipe à désactiver le garde-fou, ce qui coûterait plus cher
que de ne jamais l'avoir posé.

**Ces vérifications sortent de la fenêtre de réévaluation.** Une erreur console
ne devient pas fausse en attendant, et les y laisser ferait patienter chaque
étape bruyante pendant tout le délai d'assertion.

## La frontière de sécurité, rendue structurelle

Le moteur n'appelle le réparateur **que** sur un échec de résolution de cible.
Une assertion fausse ne le déclenche jamais, et ce n'est pas une option de
configuration : le code n'offre aucun chemin pour le faire. Un test le vérifie
explicitement.

L'ordre exact devant l'étage 2 :

1. `resolve()` — le cache suffit, on continue.
2. Échec non ambigu : `settle()` puis un second `resolve()`. Ce réessai absorbe
   l'instabilité de rendu avant d'engager le moindre coût.
3. Toujours introuvable : appel du réparateur, dans la limite du budget.
4. Assertion fausse : **échec**, quoi qu'il arrive.

Une cible ambiguë est traitée à part et **n'est pas réessayée** : deux éléments
qui correspondent ne se réduiront pas à un avec le temps. Le cache est
sous-spécifié, il faut le régénérer.

## Le rapport à trois états

`passed` / `healed` / `failed`. « Réparé » n'est pas un succès silencieux — il
signifie que le parcours fonctionne mais que le cache a changé, et que ce
changement attend une relecture humaine.

Après un échec, les étapes suivantes sont marquées `skipped` plutôt
qu'exécutées : l'état de l'application a divergé, poursuivre ne produirait que
du bruit.

## Le contrôle de cohérence

`checkConsistency()` compare un scénario et sa résolution avant même de lancer
quoi que ce soit. Il détecte la dérive silencieuse : une étape ajoutée sans
régénération du cache, une assertion reformulée dont la forme machine est restée
sur l'ancien texte, une résolution orpheline après suppression d'une étape.

Aucun de ces cas ne casse à l'exécution — ils produisent des faux verts, ce qui
est pire. Le contrôle doit tourner en CI avant le rejeu.

## Ce qui n'existe pas encore

L'interface `Healer` est définie et le moteur l'appelle correctement, mais
**aucune implémentation n'existe** : l'étage 2 reste à écrire. Sans réparateur
fourni, une cible introuvable produit simplement un échec.

Manque également la génération de résolutions (étage 3) : aujourd'hui le cache
s'écrit à la main. Et l'intégration CI avec commentaire de pull request.

Le CLI, lui, existe : voir [getting-started.md](getting-started.md).
