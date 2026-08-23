# In the pull request loop

QAI breaks the build when a regression slips through — but a silent broken build helps no one. The GitHub action posts the report **where the developer works**, and updates it on each run instead of stacking comments.

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
```

That's it. Journeys are read from `qai.config.json`, failure captures are published as an artifact, the comment is posted or updated, and the job fails if the application regressed.

## The comment

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

A green journey gets **no** detail section: only what needs action appears.

The final line matters. It tells the reviewer *why* nothing was repaired — the one useful piece of information in front of a red.

## Captures

A capture is taken **only on failure** — 300 KiB per step would make a fifty-journey suite unmanageable. Captures land in `.qai/artifacts/`, which the action publishes as `qai-captures`; the comment links to it.

The engine never writes to disk: it returns bytes and a name, the caller decides where they go. That is what will later allow sending captures somewhere other than a CI artifact without touching the engine.

## Repairing from CI

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
    heal: 'true'
```

`--heal` requires a model provider: the action does not take it as an input — it comes from the `provider` key of your `qai.config.json` (and its API key, from the job's environment).

Repaired resolutions are rewritten in the runner's working copy. What you do with them is up to you: commit them to the PR branch, or publish them as an artifact. The comment flags the repair; the diff is in the rewritten file. Add `strict: 'true'` if a repair should block the merge instead of passing.

## Options

| Input | Default | Role |
|---|---|---|
| `base-url` | — | required |
| `scenarios` | `qai.config.json` | files, directories, or glob |
| `config` | discovered | path to the configuration file |
| `states` | — | `StateProvider` module, for state declared by `given` |
| `heal` | `false` | repair stale targets |
| `strict` | `false` | a repair fails the job |
| `comment` | `true` | post the report |
| `github-token` | `github.token` | token for posting the comment |
| `version` | `latest` | QAI version |

## Without GitHub

The CLI produces the markdown; the rest is yours:

```bash
qai run --base-url $URL --format markdown --out report.md
```
