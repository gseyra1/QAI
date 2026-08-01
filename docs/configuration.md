# Le fichier de configuration

`qai.config.json`, cherché **en remontant** depuis le répertoire courant —
comme les autres outils de la chaîne Node, parce qu'une équipe lance ses tests
depuis n'importe où dans le dépôt.

```json
{
  "scenarios": ["qa/"],
  "baseUrl": "http://localhost:3000",
  "states": "./qa/states.ts",
  "provider": "./qa/provider.ts",
  "workers": 4,
  "maxCost": 2,
  "artifacts": ".qai/artifacts",
  "strict": false
}
```

Puis, quel que soit le dossier :

```bash
qai run
```

**Les options de la ligne de commande priment toujours** sur le fichier, ce qui
permet de surcharger `--base-url` par environnement sans dupliquer la
configuration.

## Deux règles

**Les chemins se lisent relativement au fichier**, pas au répertoire courant.
Sans ça, lancer QAI depuis un sous-dossier casserait silencieusement la
résolution de `states` et `provider`.

**Un fichier présent mais invalide fait échouer la commande.** L'ignorer ferait
tourner la suite avec des réglages que personne n'a voulus — un champ mal typé
est ignoré individuellement, mais un JSON cassé arrête tout.
