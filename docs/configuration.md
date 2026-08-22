# Le fichier de configuration

`qai.config.json`, cherché **en remontant** depuis le répertoire courant —
comme les autres outils de la chaîne Node, parce qu'une équipe lance ses tests
depuis n'importe où dans le dépôt.

```json
{
  "scenarios": ["qa/"],
  "tags": [],
  "baseUrl": "http://localhost:3000",
  "states": "./qa/states.ts",
  "provider": "./qa/provider.ts",
  "workers": 4,
  "maxCost": 2,
  "assertTimeout": 5000,
  "artifacts": ".qai/artifacts",
  "strict": false,
  "watchdogs": { "consoleErrors": "off", "requestFailures": "off", "allow": [] }
}
```

Puis, quel que soit le dossier :

```bash
qai run
```

**Les options de la ligne de commande priment toujours** sur le fichier, ce qui
permet de surcharger `--base-url` par environnement sans dupliquer la
configuration.

## Sélectionner par tag

`tags` — ou `--tags critical-path,paiement` — ne retient que les parcours qui
portent **au moins un** des tags demandés. C'est l'union, pas l'intersection :
la lecture utile est « le lot bloquant plus le paiement ».

```bash
qai run --tags critical-path       # en pull request
qai run                            # la suite entière, la nuit
```

Le filtre s'applique aussi à `check` et `resolve`, pour que le contrôle de
cohérence et la génération portent sur exactement le même lot que le rejeu.

**Un filtre qui ne retient rien fait échouer la commande.** Sortir en 0 ferait
qu'un tag mal orthographié rendrait un job de CI vert sans avoir rien joué.

## Les garde-fous

`watchdogs` relève ce qu'aucune assertion ne déclare mais que personne
n'accepte vraiment : une requête en échec, une erreur console. Trois niveaux
par garde-fou — `off`, `warn`, `fail` — et une liste `allow` de fragments
tolérés.

Le défaut est `off` partout, et la montée se fait en deux temps :

```json
"watchdogs": { "requestFailures": "warn" }   ... puis "fail"
```

Les poser d'emblée en `fail` ferait échouer des suites entières le jour de la
mise à jour, sur des erreurs préexistantes — et l'équipe apprendrait à les
désactiver, ce qui coûte plus cher que de ne jamais les avoir posés.

Détail du comportement dans [docs/engine.md](engine.md).

## Deux règles

**Les chemins se lisent relativement au fichier**, pas au répertoire courant.
Sans ça, lancer QAI depuis un sous-dossier casserait silencieusement la
résolution de `states` et `provider`.

**Une clé inconnue est ignorée en silence.** `assertTimeout` n'existe que depuis
la 0.1.0 : posée dans un projet qui utilise une version antérieure, elle ne
produit aucune erreur et aucun effet. Vérifiez la version avant de conclure
qu'un réglage ne sert à rien.

**Un fichier présent mais invalide fait échouer la commande.** L'ignorer ferait
tourner la suite avec des réglages que personne n'a voulus — un champ mal typé
est ignoré individuellement, mais un JSON cassé arrête tout.
