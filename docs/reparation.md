# L'auto-réparation

Quand une cible ne se résout plus, `qai run --heal` demande au modèle de la
relocaliser, **vérifie la proposition contre l'application**, puis réécrit le
fichier de résolution. Le développeur relit le diff et fusionne.

```bash
npm run qai -- run mon-parcours.qai.yaml \
  --base-url https://preview-42.mon-app.dev \
  --heal --provider ./mon-fournisseur.ts --max-cost 1
```

C'est la même boucle que la génération, appliquée à une seule cible — observer,
proposer, vérifier avec `resolve()`, réessayer sur échec.

## La règle non négociable, doublée

Le réparateur ne peut pas toucher aux assertions. Deux barrières indépendantes :

1. **Le moteur** ne l'appelle que sur un échec de *résolution de cible*. Une
   assertion fausse ne le convoque jamais — c'est une régression.
2. **Son schéma de sortie** n'expose que `target` et `note`. Même sollicité à
   tort, il ne pourrait rien rendre d'autre.

Un réparateur autorisé à retoucher les assertions apprendrait à faire passer les
bugs. C'est la seule chose qui sépare un outil de test d'un outil qui ment.

## Deux contextes, deux comportements

| Situation | Réparation | Si elle échoue |
|---|---|---|
| Cible introuvable, pas de repli | obligatoire | l'étape échoue |
| Cible atteinte par son seul repli technique | opportuniste | le parcours continue, avec un avertissement |

Le second cas mérite une explication. Quand le ciblage sémantique meurt mais que
le `data-testid` tient encore, le parcours fonctionne : échouer serait crier au
loup. Mais se taire laisserait chaque locator dégrader silencieusement vers un
identifiant technique, et **la portabilité mobile mourir sans que personne ne
s'en aperçoive**. QAI répare donc pour restaurer le ciblage sémantique, et à
défaut le signale :

```
⚠ « Ajouter au panier » n'a été atteint que par son repli technique :
  l'accessibilité de l'application s'est dégradée et ce ciblage ne survivra
  pas au portage mobile
```

## Le diff, qui est tout l'argument

Une réparation d'un libellé produit exactement ceci :

```diff
-          "target": { "primary": { "role": "button", "name": "Commander en tant qu'invité" } }
+          "target": { "primary": { "role": "button", "name": "Continuer sans compte" } }
-      "healedAt": null
+      "healedAt": "2026-07-29T17:58:01.263Z",
+      "healNote": "Le libellé du bouton est passé de « Commander en tant qu'invité » à « Continuer sans compte »."
```

Quatre lignes, avec la raison attachée. Ce n'est pas un détail cosmétique : si
une réparation d'un mot produisait trois cents lignes de diff, personne ne
relirait, et « la réparation est auditable » deviendrait un slogan creux. Le
fichier est donc imprimé en JSON compact — petits objets sur une ligne — et un
test vérifie qu'une réparation ne dépasse pas six lignes de diff.

C'est ce qui nous distingue des outils qui réparent en silence dans leur cloud :
l'historique complet des adaptations vit dans votre dépôt, relisible et
révocable.

## Les garde-fous

- **Un réessai après repos** précède toute réparation : l'instabilité de rendu
  ne doit pas coûter un appel de modèle.
- **Une cible ambiguë n'est jamais réessayée** — deux correspondants ne se
  réduiront pas à un avec le temps. Elle part en réparation comme les autres :
  le réparateur reçoit l'ambiguïté et doit la lever avec `within` ou `nth`.
- **Le budget est borné** — trois réparations par parcours par défaut, plus le
  plafond de dépense du fournisseur. Une dérive massive n'est pas un test
  périmé, c'est une application qui a changé de nature.
- **Une réparation ne peut ni ajouter ni supprimer une étape.** Contourner ce
  qui ne passe plus est la définition même du faux négatif.

## Ce qui reste à faire

La boucle est vérifiée de bout en bout contre une vraie application, avec un
modèle scripté. La qualité des propositions d'un vrai modèle n'est pas mesurée —
elle dépend du modèle que vous branchez.
