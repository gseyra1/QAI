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
## ❌ QAI — regression detected

1 journey(s) in 6.8 s.

| | Journey | Result | Duration |
|:-:|---|---|---:|
| ❌ | `checkout-guest` | failed | 6.3 s |

### `checkout-guest`

- ❌ **s8** — payer avec la carte de test
  - `la commande est confirmée` → no element matches the target
  - screenshot: `checkout-guest-s8.png`

> No repair was applied on an assertion failure: it is an application
> regression, not a stale test.
```

A green journey gets **no** detail section: only what needs action appears.

The final line matters. It tells the reviewer *why* nothing was repaired — the one useful piece of information in front of a red.

## Captures

A capture is taken **only on failure** — 300 KiB per step would make a fifty-journey suite unmanageable. Captures land in `.qai/artifacts/`, which the action publishes as `qai-captures`; the comment links to it. The name is fixed and a workflow run refuses two artifacts with the same name: call the action from one job per workflow, not from a matrix or from two jobs of the same workflow.

The engine never writes to disk: it returns bytes and a name, the caller decides where they go. That is what will later allow sending captures somewhere other than a CI artifact without touching the engine.

## Repairing from CI

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
    heal: 'true'
    provider: ./qa/provider.mts
  env:
    DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

`heal` needs a model provider: the `provider` input, or the `provider` key of your `qai.config.json`. Its API key comes from the job's environment. Without either, the run exits 1 with `--heal requires --provider`.

Repaired resolutions are rewritten in the runner's working copy. What you do with them is up to you: commit them to the PR branch, or publish them as an artifact. The comment flags the repair; the diff is in the rewritten file. Add `strict: 'true'` if a repair should block the merge instead of passing.

## Options

| Input | Default | Role |
|---|---|---|
| `base-url` | — | required |
| `scenarios` | `qai.config.json` | files, directories, or glob |
| `config` | discovered | path to the configuration file |
| `states` | — | `StateProvider` module, for state declared by `given` |
| `provider` | — | `ModelProvider` module, required by `heal` unless `qai.config.json` names one |
| `heal` | `false` | repair stale targets (needs a provider) |
| `strict` | `false` | a repair fails the job |
| `comment` | `true` | post the report |
| `github-token` | `github.token` | token for posting the comment |
| `version` | `latest` | QAI version installed from npm |
| `package` | — | npm install spec used instead of `tilmiqai@<version>` |

`states` and `provider` modules are loaded as ESM (`.mts`/`.mjs`, or `"type": "module"`). The action runs Node 22; a `.ts`/`.mts` module needs 22.18 or later.

## Installing another build

`package` replaces `tilmiqai@<version>` with another `npm install` spec —
typically a tarball packed earlier in the job. QAI's own self-test runs each
pull request's code through the action this way:

```yaml
- id: pack
  run: |
    npm ci && npm run build
    name=$(npm pack --pack-destination "$RUNNER_TEMP" --json \
      | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].filename')
    echo "tarball=$RUNNER_TEMP/$name" >> "$GITHUB_OUTPUT"
- uses: gseyra1/QAI@main
  with:
    base-url: http://127.0.0.1:8899/
    package: ${{ steps.pack.outputs.tarball }}
```

The spec must install a built `tilmiqai` package, or the job fails at install.
A git URL does not qualify: `dist/` is not committed and QAI has no `prepare`
script to build it. `version` is ignored, with a warning when it is not
`latest`. Chromium is installed for the Playwright QAI resolves, not for
another version your project may pin.

`version` and `package` decide which code runs in the job, with its
environment and token: never set them from pull-request-controlled data (a
title, a branch name, a comment).

## Without GitHub

The CLI produces the markdown; the rest is yours:

```bash
qai run --base-url $URL --format markdown --out report.md
```

Or JUnit, which GitLab, Jenkins and Azure ingest natively — that is what makes
journeys show up in the "Tests" tab instead of drowning in a log:

```bash
qai run --base-url $URL --format junit --out report.xml
```

**One JUnit suite is one journey, one case is one step.** That is the
projection that keeps the useful information — which step gave way, on which
assertion — where one case per journey would reduce everything to a boolean.
The case name carries the intent, not just the id: `s4` teaches nothing to
whoever reads the "Tests" tab.

A skipped step becomes `<skipped/>`. A **healed** step stays green, with the
repair note in `<system-out>` — except under `--strict`, where it becomes a
`<failure>`: the report must say the same thing as the exit code.

A watchdog set to `warn` lands in `<system-err>` on a step that stayed green.
That is the only place it can land: `warn` does not change the verdict, which
is the point.
