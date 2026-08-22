# Le contrat de driver

Un driver est l'unique endroit du système qui sait sur quelle plateforme on
tourne. Tout ce qui est au-dessus — moteur de rejeu, étage de réparation,
évaluation des assertions — ignore s'il pilote un navigateur ou un simulateur
iOS. C'est cette frontière qui rend la promesse « un scénario, deux plateformes »
tenable.

## Quatre responsabilités, pas cinq

| Méthode | Rôle |
|---|---|
| `observe()` | rendre l'écran courant sous forme d'arbre normalisé, plus une capture à la demande |
| `resolve()` | traduire une cible du cache en élément concret, ou dire précisément pourquoi elle échoue |
| `act()` | exécuter une action |
| `settle()` | attendre le repos avant d'observer ou de conclure à un échec |

**L'évaluation des assertions est délibérément absente.** Elle vit dans le
moteur, appliquée sur un `UISnapshot`. Si chaque driver implémentait ses propres
assertions, le web et le mobile finiraient par diverger sur ce que signifie « le
total est égal à 42 », et la portabilité tomberait sans que personne ne le
remarque avant un client mécontent.

`settle()` mérite d'exister au niveau du contrat plutôt que d'être bricolé dans
le moteur : c'est le filtre anti-instabilité placé **devant** l'étage de
réparation. Sans lui, chaque élément pas encore rendu déclencherait un appel de
modèle et polluerait l'historique des réparations avec du bruit de timing.

## Ce que `resolve()` doit distinguer

C'est la méthode la plus chargée de sens, parce que son résultat décide de la
suite pour l'étage de réparation :

| Résultat | Signification | Suite |
|---|---|---|
| `found`, `usedFallback: false` | cache valide | rejeu, coût nul |
| `found`, `usedFallback: true` | le locator sémantique a échoué, le repli a marché | fonctionne, mais l'accessibilité de l'app s'est dégradée — à signaler |
| `no-match` | rien ne correspond | étage 2 : le modèle relocalise |
| `ambiguous` | plusieurs candidats légitimes | **ne pas agir** — le cache est sous-spécifié, à régénérer |
| `not-visible` | trouvé mais hors écran ou masqué | faire défiler, puis réessayer |

`ambiguous` est le cas qu'on est tenté de traiter en prenant le premier
élément. C'est un piège : le jour où l'application ajoute un second bouton
« Valider », un test qui « passe » en cliquant silencieusement sur le mauvais
vaut moins que pas de test du tout. Le driver refuse de choisir et remonte le
nombre de correspondances.

## `select` vise le libellé, pas la valeur

`selectOption("std")` de Playwright apparie la **value** de l'option — un
détail technique que l'utilisateur ne voit jamais. Un outil d'intention doit
viser ce qui est affiché : le driver essaie donc d'abord le libellé
(« Livraison standard »), et retombe sur la valeur si aucun libellé ne
correspond.

Les options sont lues d'un coup avant de choisir, plutôt que d'essayer puis de
rattraper l'erreur : un échec de `selectOption` consomme un délai d'attente
complet, soit trente secondes par `select` sur les résolutions écrites par
valeur.

Un driver mobile appliquera la même règle sur son propre sélecteur natif : ce
qui est ciblé est le libellé lu à l'écran.

## La correspondance des rôles

C'est le tableau qui décide si la portabilité est réelle. Le vocabulaire de QAI
est l'intersection de ce que les trois plateformes exposent nativement.

| QAI | Web (ARIA) | iOS (XCUIElementType) | Android |
|---|---|---|---|
| `button` | `button` | `.button` | `Button` |
| `link` | `link` | `.link` | `TextView` + `URLSpan` |
| `text` | contenu textuel | `.staticText` | `TextView` |
| `heading` | `heading` | `.staticText` + trait `header` | `AccessibilityHeading` |
| `image` | `img` | `.image` | `ImageView` |
| `textbox` | `textbox` | `.textField` | `EditText` |
| `searchbox` | `searchbox` | `.searchField` | `SearchView` |
| `combobox` | `combobox` | `.pickerWheel` | `Spinner` |
| `checkbox` | `checkbox` | `.checkBox` | `CheckBox` |
| `radio` | `radio` | `.radioButton` | `RadioButton` |
| `switch` | `switch` | `.switch` | `Switch` |
| `slider` | `slider` | `.slider` | `SeekBar` |
| `list` | `list` | `.table`, `.collectionView` | `RecyclerView` |
| `listitem` | `listitem` | `.cell` | enfant direct de la liste |
| `table` / `row` / `cell` | idem | `.table` / `.cell` / `.staticText` | `GridView` |
| `tab` / `tablist` | idem | `.button` dans `.tabBar` / `.tabBar` | `TabLayout.Tab` |
| `dialog` | `dialog` | `.alert`, `.sheet` | `AlertDialog` |
| `menu` / `menuitem` | idem | `.menu` / `.menuItem` | `Menu` / `MenuItem` |
| `progressbar` | `progressbar` | `.progressIndicator` | `ProgressBar` |
| `alert` | `alert` | `.alert` | `Toast`, `Snackbar` |
| `group` | `group` | `.other` | `ViewGroup` |

Le nom accessible suit le même principe : `aria-label` et le calcul accname sur
le web, `accessibilityLabel` sur iOS, `contentDescription` puis `text` sur
Android. Un même scénario retrouve donc « Ajouter au panier » sur les trois.

Deux correspondances sont imparfaites et il vaut mieux le savoir maintenant :
`link` n'a pas d'équivalent natif sur mobile, et `heading` n'existe sur iOS que
comme trait d'un `staticText`. Ce n'est pas bloquant, parce que **la portabilité
vit dans le scénario, pas dans le locator** : l'intention « ouvrir le panier »
produit une résolution `link` sur le web et `button` sur iOS, dans deux fichiers
distincts. Le vocabulaire n'a besoin d'être commun que pour être exprimable des
deux côtés, pas identique.

## La limite honnête du mobile

La résolution sémantique suppose que l'application testée est correctement
accessible. Sur le web, l'échec se voit et se corrige. Sur mobile, une app sans
`accessibilityLabel` ni `contentDescription` dégrade la résolution vers
l'identifiant d'accessibilité, puis vers le repli vision.

C'est la vraie difficulté du portage, et elle est produit autant que technique :
il faudra soit accompagner les clients vers un étiquetage correct — ce qui a une
valeur en soi, l'accessibilité étant de plus en plus contrainte réglementairement
— soit assumer un étage vision plus coûteux sur mobile. À arbitrer avant de
promettre une parité de tarif entre les deux plateformes.

## Écrire un nouveau driver

Implémenter `Driver` depuis `src/driver/types.ts`, puis faire passer la même
suite de tests que le driver web. Les douze cas de
`src/driver/web/PlaywrightWebDriver.test.ts` ne testent rien de spécifique au
navigateur : normalisation, géométrie, exclusion des nœuds masqués, états,
résolution, ambiguïté, repli, action observable, capacité refusée. Ils
constituent de fait le test de conformité du contrat.
