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
  "assertTimeout": 5000,
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

**Une clé inconnue est ignorée en silence.** `assertTimeout` n'existe que depuis
la 0.1.0 : posée dans un projet qui utilise une version antérieure, elle ne
produit aucune erreur et aucun effet. Vérifiez la version avant de conclure
qu'un réglage ne sert à rien.

**Un fichier présent mais invalide fait échouer la commande.** L'ignorer ferait
tourner la suite avec des réglages que personne n'a voulus — un champ mal typé
est ignoré individuellement, mais un JSON cassé arrête tout.
