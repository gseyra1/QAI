# La génération de résolutions

`qai resolve` prend un scénario écrit à la main et produit sa résolution. C'est
l'étage 3 — la porte d'entrée du produit, et le seul moment où l'on crée un
test.

```bash
npm run qai -- resolve mon-parcours.qai.yaml \
  --base-url http://localhost:3000 \
  --provider ./mon-fournisseur.ts \
  --max-cost 2
```

## Ce qui rend la boucle fiable

Un agent laissé libre dérive. Celui-ci ne l'est pas : **chaque proposition est
confrontée à l'application réelle avant d'être acceptée**, et l'échec revient au
modèle formulé dans le vocabulaire qu'il vient d'employer.

Par étape, deux phases de vérification.

**Phase A — les actions, avant d'agir.** Chaque cible proposée passe par
`driver.resolve()`. Trois refus possibles, chacun avec son message :

| Refus | Ce qui revient au modèle |
|---|---|
| Aucune correspondance | « aucun élément ne correspond à cette cible » |
| Plusieurs correspondances | « cible ambiguë, N éléments — précise avec `within` ou `nth` » |
| Seul le repli technique a marché | « le ciblage sémantique est faux » |

Ce dernier compte : accepter une cible qui ne fonctionne que par son `data-testid`
produirait un test non portable sur mobile. On le refuse à la génération plutôt
que de le découvrir en phase 2.

**Phase B — les captures et les assertions, après avoir agi.** Une capture doit
désigner exactement un élément et en extraire une valeur lisible. Une assertion,
elle, doit **passer sur l'écran obtenu** :

> On enregistre un état connu comme bon. Une assertion fausse au moment de la
> génération serait un test faux pour toujours.

C'est la vérité terrain la plus forte du système, et elle ne coûte rien : le
moteur d'assertions existe déjà, on le réutilise tel quel.

Les assertions inventées sont également refusées. Le modèle ne peut produire que
les clés présentes dans le scénario, recopiées exactement — sans quoi le fichier
se remplirait de contrôles que personne n'a demandés.

## Pourquoi deux phases

Les actions changent l'état de l'application ; les captures et les assertions
n'existent qu'après. Vérifier les deux avant d'agir serait impossible, et tout
vérifier après empêcherait de rattraper une action fausse. Un échec de phase B
ne rejoue donc pas les actions : il ne reprend que les contrôles, contre l'écran
réellement obtenu.

## Ce que le modèle voit

Pas du JSON. Un arbre indenté, une ligne par élément :

```
group
  link "Boutique"
  link "Panier 1"
    text "1"
  searchbox "Rechercher un produit"
  list "Résultats"
    listitem
      link "Chaise de bureau"
```

Accolades, guillemets et noms de champs répétés représentent l'essentiel des
octets d'un JSON sans porter d'information. Or l'arbre est ce qu'on paie à
chaque appel : sa densité est un choix d'architecture, pas de confort.

## Le fichier produit

Sérialisé avec un ordre de clés fixe, parce que son diff est ce qu'un
développeur relira quand une réparation lui sera proposée. Un ordre instable
rendrait ce diff illisible et ruinerait l'argument de confiance.

Rien n'est écrit si une seule étape échoue : une résolution partielle produirait
des verts qui ne prouvent rien.

## Les limites, franchement

La boucle est vérifiée de bout en bout contre une vraie application, mais avec
un **modèle factice** qui rejoue une résolution connue. Ce qui est prouvé :
l'enchaînement, la vérification, le retour d'erreur, le fichier produit, et le
fait que la résolution générée rejoue vert. Ce qui ne l'est pas : la qualité des
propositions d'un vrai modèle, qui dépend du modèle branché.

Le nombre de tentatives par étape est borné (3 par défaut) et le plafond de
dépense s'applique à l'ensemble de la génération.

## Et l'étage 2

Réparer, c'est cette même boucle appliquée à une seule cible au lieu d'un
parcours entier : observer, proposer, vérifier avec `resolve()`. C'est
`ModelHealer` — voir [reparation.md](reparation.md).
