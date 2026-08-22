# Dans la boucle de pull request

QAI casse le build quand une régression passe — mais casser un build sans rien
dire n'aide personne. L'action GitHub poste le rapport **là où le développeur
travaille**, et le met à jour à chaque exécution plutôt que d'empiler les
commentaires.

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
```

C'est tout. Les parcours sont lus depuis `qai.config.json`, les captures
d'échec publiées en artefact, le commentaire posté ou mis à jour, et le job
échoue si l'application a régressé.

## Le commentaire

```markdown
## ❌ QAI — régression détectée

1 parcours en 1.6 s.

| | Parcours | Résultat | Durée |
|:-:|---|---|---:|
| ❌ | `checkout-guest` | échec | 1.2 s |

### `checkout-guest`

- ❌ **s8** — payer avec la carte de test
  - `la commande est confirmée` → aucun élément ne correspond à la cible
  - [capture de l'écran au moment de l'échec](…)

> Aucune réparation n'a été appliquée sur un échec d'assertion : c'est une
> régression de l'application, pas un test périmé.
```

Un parcours vert n'a **pas** de section de détail. Un commentaire qui déroule
cinquante parcours réussis ne se lit pas, donc ne se lit pas du tout : seul ce
qui demande une action apparaît.

La dernière ligne n'est pas décorative. Elle dit au relecteur *pourquoi* rien
n'a été réparé, ce qui est la seule information utile face à un rouge.

## Les captures

Une capture n'est prise **qu'à l'échec** — 300 Kio par étape rendraient une
suite de cinquante parcours ingérable. Elles atterrissent dans
`.qai/artifacts/`, que l'action publie sous le nom `qai-captures`, et le
commentaire y renvoie.

Le moteur n'écrit rien sur disque : il rend les octets et un nom, l'appelant
décide où ils vont. C'est ce qui permettra plus tard de les envoyer ailleurs
qu'en artefact de CI sans toucher au moteur.

## Réparer depuis la CI

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
    heal: 'true'
```

`--heal` exige un fournisseur de modèle : l'action ne le passe pas en entrée,
il vient de la clé `provider` de votre `qai.config.json` (et sa clé d'API, de
l'environnement du job).

Les résolutions réparées sont réécrites dans le dépôt de travail du runner. À
vous d'en faire ce que vous voulez : les commiter sur la branche de la PR, ou
les publier en artefact. Le commentaire signale la réparation ; le diff, lui,
est dans le fichier réécrit. Ajoutez `strict: 'true'` si une réparation doit
bloquer la fusion plutôt que passer.

## Options

| Entrée | Défaut | Rôle |
|---|---|---|
| `base-url` | — | obligatoire |
| `scenarios` | `qai.config.json` | fichiers, dossiers ou motif |
| `config` | découvert | chemin du fichier de configuration |
| `states` | — | module `StateProvider`, pour l'état déclaré par `given` |
| `heal` | `false` | réparer les cibles périmées |
| `strict` | `false` | une réparation fait échouer le job |
| `comment` | `true` | poster le rapport |
| `github-token` | `github.token` | jeton pour poster le commentaire |
| `version` | `latest` | version de QAI |

## Sans GitHub

Le CLI produit le markdown, le reste vous appartient :

```bash
qai run --base-url $URL --format markdown --out rapport.md
```
