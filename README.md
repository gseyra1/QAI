# tilmiqai 🎯

> Catch UI regressions in the pull request — from scenarios written as **intent**, never as selectors.

[![npm version](https://img.shields.io/npm/v/tilmiqai.svg)](https://www.npmjs.com/package/tilmiqai)
[![npm downloads](https://img.shields.io/npm/dm/tilmiqai.svg)](https://www.npmjs.com/package/tilmiqai)
[![CI](https://github.com/gseyra1/QAI/actions/workflows/ci.yml/badge.svg)](https://github.com/gseyra1/QAI/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/tilmiqai.svg)](LICENSE)

```
checkout-guest — FAILED   1.2 s

  ✓ s1…s7
  ✖ s8   pay with the test card
        order is confirmed → no element matches the target
  ⊘ s9   check the order appears in tracking

No repair was applied: a false assertion is a regression, not a stale test.
```

## Features

- ⚡ **Free to replay** — the normal path makes **zero model calls**. You only pay when your UI actually changes.
- 🩹 **Self-healing, auditable** — a renamed button is repaired and lands as a **4-line diff** in your PR, with the reason attached.
- 🛡️ **Never touches assertions** — repairs can change *how* an element is reached, never *what* is asserted. Two independent barriers enforce it.
- 📱 **Write once, run on mobile later** — scenarios contain no selectors, so the same file will replay on iOS and Android.
- 🔌 **Bring your own model** — no vendor SDK bundled. Implement one method, set a spend cap.
- 💬 **Talks to the developer** — posts the report as a pull-request comment and updates it in place.

## Installation

```bash
npm install --save-dev tilmiqai && npx playwright install chromium
```

```bash
yarn add -D tilmiqai && yarn playwright install chromium
```

```bash
pnpm add -D tilmiqai && pnpm exec playwright install chromium
```

Requires **Node.js ≥ 22**.

## Quick start

**1.** Describe a critical path in `qa/checkout.qai.yaml`. Intent only — no CSS, no XPath:

```yaml
id: checkout
title: A visitor can order without an account
tags: [critical-path]

steps:
  - id: s1
    do: open the shop home page
  - id: s2
    do: add the first item to the cart
    expect: the cart badge shows 1 item
```

**2.** Let QAI resolve it against your running app. It proposes, then **verifies every target against the real page** before accepting it:

```bash
npx qai resolve qa/checkout.qai.yaml --base-url http://localhost:3000 --provider ./qa/provider.ts
```

**3.** Replay it — no model involved, so this costs nothing and runs on every commit:

```bash
npx qai run qa/ --base-url http://localhost:3000
```

Commit both files. The scenario is reviewed like code; the resolution is the cache that makes repairs auditable.

## How it works

Two files per journey, and the split is the whole design:

| File | Written by | Contains |
|---|---|---|
| `checkout.qai.yaml` | you | the **intent**, never a selector |
| `.qai/resolutions/checkout.web.json` | `qai resolve` | the **cache**, one per platform |

Porting to mobile means generating a new resolution — not rewriting your tests.

Three execution tiers:

| Tier | Trigger | Model calls |
|---|---|---|
| **1 — replay** | every pull request | **none** |
| **2 — repair** | a target went missing | 1 per broken step |
| **3 — resolve** | creating a scenario | ~1.5 per step |

## CLI

```
qai run     <scenarios…> --base-url <url> [--heal --provider <module>]
qai check   <scenarios…>
qai resolve <scenarios…> --base-url <url> --provider <module>
```

`<scenarios…>` accepts files, directories or a shell glob. Everything can also live in `qai.config.json`.

| Option | Default | Description |
| --- | --- | --- |
| `--base-url <url>` | — | Root of the application under test. |
| `--provider <module>` | — | Module default-exporting a `ModelProvider`. Required for `resolve` and `--heal`. |
| `--states <module>` | — | Module default-exporting a `StateProvider`, for the `given` block. |
| `--config <path>` | `qai.config.json` | Looked up by walking parent directories. |
| `--workers <n>` | `4` | Journeys replayed in parallel. Each gets a fresh browser. |
| `--assert-timeout <ms>` | `5000` | Window in which a still-false assertion is re-evaluated. Never loosens what is asserted — it only allows for rendering that finishes after network idle. |
| `--heal` | `false` | Repair stale targets and rewrite the resolutions. |
| `--max-cost <n>` | — | Spend cap, in your model's pricing units. |
| `--artifacts <dir>` | `.qai/artifacts` | Where failure screenshots are written. |
| `--format <f>` | `text` | `text`, `json` or `markdown`. |
| `--out <path>` | stdout | Write the report to a file. |
| `--strict` | `false` | A repair fails the command instead of passing. |
| `--headed` | `false` | Show the browser. |

**Exit codes:** `0` passed or repaired, `1` failed or inconsistent.

## GitHub Action

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
```

Replays the suite, uploads failure screenshots as an artifact, posts the report as a PR comment — updating the existing one instead of stacking a new comment per run — and propagates the exit code.

Add `heal: 'true'` to repair stale targets, `strict: 'true'` to block the merge on a repair. Full reference: [docs/ci.md](docs/ci.md).

## Bring your own model

QAI bundles no vendor SDK. You implement one method and your API key never leaves your environment:

```typescript
import type { ModelProvider, ModelRequest, ModelResponse, Pricing } from 'tilmiqai';

export default {
  name: 'my-model',
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const answer = await callYourModel({
      system: request.system,
      messages: request.messages,
      schema: request.responseSchema,   // structured output is required
    });
    return {
      output: answer.object,
      usage: { inputTokens: answer.in, outputTokens: answer.out },
    };
  },
} satisfies ModelProvider;

export const pricing: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };
```

Two constraints, both load-bearing. The response must be a **structured object**, never prose — that is what makes any model swappable without touching QAI. And `usage` is **mandatory**: without token accounting no spend cap is possible, and cost control is existential for this product.

See [docs/modele.md](docs/modele.md) and [examples/provider-exemple.ts](examples/provider-exemple.ts).

## Configuration

```json
{
  "scenarios": ["qa/"],
  "baseUrl": "http://localhost:3000",
  "provider": "./qa/provider.ts",
  "states": "./qa/states.ts",
  "workers": 4,
  "maxCost": 2
}
```

Paths resolve **relative to the config file**, not the working directory. CLI flags always win. See [docs/configuration.md](docs/configuration.md).

## TypeScript

Types ship with the package — no `@types/…` needed.

```typescript
import type { ModelProvider, StateProvider, Scenario, ScenarioReport } from 'tilmiqai';
```

### Embedding the engine

The engine is exported too, so QAI runs inside the test runner you already
have — vitest, jest, or a plain script — instead of asking you to adopt a
second one.

```typescript
import { chromium } from 'playwright';
import { loadScenario, loadResolution, runScenario, PlaywrightWebDriver } from 'tilmiqai';

const scenario = await loadScenario('qa/checkout.qai.yaml');
const resolution = await loadResolution('qa/.qai/resolutions/checkout.web.json');
const driver = new PlaywrightWebDriver(() => chromium.launch());

await driver.launch({ entry: 'http://localhost:3000/' });
const report = await runScenario({ scenario, resolution, driver });
await driver.dispose();

expect(report.status).toBe('passed'); // 'healed' and 'failed' are the other two
```

`runSuite` adds the parallelism, the driver lifecycle and the starting state;
`checkConsistency` catches a scenario that drifted away from its resolution.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Five-minute walkthrough on a demo shop, healthy then broken |
| [Scenario format](docs/scenario-format.md) | The format and why it has no selectors |
| [Engine](docs/engine.md) | Replay, the safety boundary, the three-state report |
| [Resolving](docs/generation.md) | How a resolution is produced and verified |
| [Repairing](docs/reparation.md) | The two barriers, and the diff you review |
| [Starting state](docs/etats.md) | `given`, sessions and fixtures |
| [Model](docs/modele.md) | Plugging your own model and capping spend |
| [CI](docs/ci.md) · [Config](docs/configuration.md) | Pull-request integration and `qai.config.json` |

## Status

Web is implemented and covered by 100 tests, including full journeys driven through a real browser. **Mobile drivers are not built yet** — the scenario format and driver contract are designed for them, nothing more.

`resolve` and `--heal` are verified end to end against a real application using scripted models: the loop, the verification, the produced file and the resulting diff. The *quality* of a real model's proposals depends on the model you plug in and is not measured here.

## Contributing

```bash
git clone https://github.com/gseyra1/QAI.git && cd QAI
npm install && npx playwright install chromium
npm test
```

```bash
npm run demo          # demo shop on :8899
npm run qai -- run examples/ --base-url http://127.0.0.1:8899/
```

Issues and pull requests welcome at [github.com/gseyra1/QAI](https://github.com/gseyra1/QAI/issues).

## License

MIT © [Mouaad GSEYRA](https://github.com/gseyra1) — Tilmicode. See [LICENSE](LICENSE).
