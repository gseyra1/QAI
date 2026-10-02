# tilmiqai 🎯

> Catch UI regressions in the pull request — from scenarios written as **intent**, never as selectors.

[![npm version](https://img.shields.io/npm/v/tilmiqai.svg)](https://www.npmjs.com/package/tilmiqai)
[![npm downloads](https://img.shields.io/npm/dm/tilmiqai.svg)](https://www.npmjs.com/package/tilmiqai)
[![CI](https://github.com/gseyra1/QAI/actions/workflows/ci.yml/badge.svg)](https://github.com/gseyra1/QAI/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/tilmiqai.svg)](LICENSE)

```
1 journey(s) — FAILED   6.8 s

  ✖ checkout-guest         FAILED  6.4 s
    ✖ s8   payer avec la carte de test
          la commande est confirmée → no element matches the target

1 journey(s) failed.
```

A false assertion is a regression, not a stale test — no repair was applied,
the pull request goes red. (Step intents stay in the scenario's own language —
here French. The tool speaks English.)

## Features

- ⚡ **Free to replay** — the normal path makes **zero model calls**. You only pay when your UI actually changes.
- 🩹 **Self-healing, auditable** — a renamed button is repaired and lands as a **4-line diff** in your PR, with the reason attached.
- 🛡️ **Never touches assertions** — repairs can change *how* an element is reached, never *what* is asserted. Two independent barriers enforce it.
- 📱 **Write once, replay on web and iOS** — scenarios contain no selectors; the same file gets one resolution per platform. iOS is experimental, Android next.
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

Requires **Node.js ≥ 22** (≥ 22.18 to load a `.ts` provider or states module).

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
npx qai resolve qa/checkout.qai.yaml --base-url http://localhost:3000 --provider ./qa/provider.mts
```

**3.** Replay it — no model involved, so this costs nothing and runs on every commit:

```bash
npx qai run qa/ --base-url http://localhost:3000
```

Commit both files. The scenario is reviewed like code; the resolution is the cache that makes repairs auditable.

`--provider` and `--states` modules are loaded as **ESM**: name them `.mts` or `.mjs`, or set `"type": "module"` in their `package.json` (`npm init -y` writes `"commonjs"`). A `.ts`/`.mts` module needs Node ≥ 22.18.

## How it works

Two files per journey, and the split is the whole design:

| File | Written by | Contains |
|---|---|---|
| `checkout.qai.yaml` | you | the **intent**, never a selector |
| `.qai/resolutions/checkout.web.json` | `qai resolve` | the **cache**, one per platform |

Porting to mobile means generating a new resolution — not rewriting your tests.

**iOS (experimental, not yet validated on a device):** `qai run qa/ --platform ios --app com.example.app` drives the app through Appium + XCUITest — prerequisites and limits in [docs/driver.md](docs/driver.md#ios-driver--experimental).

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

iOS (experimental): --platform ios --app <bundle-id|path.app> instead of --base-url
```

`<scenarios…>` accepts files, directories or a shell glob. Everything can also live in `qai.config.json`.

| Option | Default | Description |
| --- | --- | --- |
| `--base-url <url>` | — | Root of the application under test. |
| `--platform <p>` | `web` | `web` or `ios` (experimental, needs Appium). |
| `--app <id\|path>` | — | iOS (experimental): bundle id, or a `.app`/`.ipa` path. |
| `--device <udid\|name>` | Appium's choice | iOS (experimental): device or simulator. |
| `--appium-url <url>` | `http://127.0.0.1:4723` | iOS (experimental): Appium server. |
| `--platform-version <v>` | — | iOS (experimental): iOS version to run on (`appium:platformVersion`). |
| `--capabilities <json>` | — | iOS (experimental): extra Appium session capabilities, as a JSON object. Merged over the config's `capabilities`, key by key. Keys QAI sets itself are refused. |
| `--states <module>` | — | Module default-exporting a `StateProvider`, for the `given` block. |
| `--provider <module>` | — | Module default-exporting a `ModelProvider`, and exporting `pricing` when `--max-cost` is set. Required for `resolve` and `--heal`. |
| `--tags <a,b>` | — | Only the journeys carrying at least one of these tags. |
| `--workers <n>` | `4` | Journeys replayed in parallel. Each gets a fresh browser. 1 on iOS. |
| `--heal` | `false` | Repair stale targets and rewrite the resolutions. |
| `--max-cost <n>` | — | Spend cap, in your model's pricing units. |
| `--attempts <n>` | `5` | Attempts per step during `resolve`. |
| `--assert-timeout <ms>` | `5000` | Window in which a still-false assertion is re-evaluated. Never loosens what is asserted — it only allows for rendering that finishes after network idle. |
| `--resolution <path>` | `.qai/resolutions/` next to the scenario | Force the resolution path. Single scenario only. |
| `--config <path>` | `qai.config.json` | Looked up by walking parent directories. |
| `--artifacts <dir>` | `.qai/artifacts` | Where failure screenshots are written. |
| `--format <f>` | `text` | `text`, `json`, `markdown` or `junit`. Anything else exits 1. |
| `--out <path>` | stdout | Write the report to a file. |
| `--run-url <url>` | — | Link to the CI run, inserted into the markdown report. |
| `--json` | — | Alias for `--format json`. |
| `--strict` | `false` | A repair fails the command instead of passing. |
| `--headed` | `false` | Show the browser. Refused on iOS. |
| `--version` | — | Print the QAI version. |
| `--help` | — | Print the usage. |

**Exit codes:** `0` passed or repaired, `1` failed or inconsistent.

## GitHub Action

```yaml
- uses: gseyra1/QAI@main
  with:
    base-url: ${{ steps.deploy.outputs.preview-url }}
```

Replays the suite, uploads failure screenshots as an artifact, posts the report as a PR comment — updating the existing one instead of stacking a new comment per run — and propagates the exit code.

Add `heal: 'true'` with `provider: ./qa/provider.mts` to repair stale targets, `strict: 'true'` to block the merge on a repair. Full reference: [docs/ci.md](docs/ci.md).

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

See [docs/model.md](docs/model.md) and [examples/provider-example.ts](examples/provider-example.ts).

## Configuration

```json
{
  "scenarios": ["qa/"],
  "baseUrl": "http://localhost:3000",
  "provider": "./qa/provider.mts",
  "states": "./qa/states.mts",
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
import {
  checkConsistency,
  loadScenario,
  loadResolution,
  runScenario,
  PlaywrightWebDriver,
} from 'tilmiqai';

const scenario = await loadScenario('qa/checkout.qai.yaml');
const resolution = await loadResolution('qa/.qai/resolutions/checkout.web.json');
// Drift between the scenario and its cached resolution is a false green.
expect(checkConsistency(scenario, resolution, 'web')).toEqual([]);

const driver = new PlaywrightWebDriver(() => chromium.launch());

await driver.launch({ entry: 'http://localhost:3000/' });
// Optional, but needed for relative urlEquals checks (format v3): without it they fail.
const report = await runScenario({ scenario, resolution, driver, baseUrl: 'http://localhost:3000/' });
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
| [Resolving](docs/resolving.md) | How a resolution is produced and verified |
| [Repairing](docs/repairing.md) | The two barriers, and the diff you review |
| [Starting state](docs/state.md) | `given`, sessions and fixtures |
| [Model](docs/model.md) | Plugging your own model and capping spend |
| [CI](docs/ci.md) · [Config](docs/configuration.md) | Pull-request integration and `qai.config.json` |
| [iOS driver](docs/driver.md#ios-driver--experimental) | Experimental: prerequisites, session, limits |
| [Changelog](CHANGELOG.md) | Breaking changes and upgrade steps |

## Status

- **Web** — implemented, covered by the test suite (`npm test`), including full journeys driven through a real browser.
- **iOS** — **experimental**. Tested against a fake Appium server that checks every HTTP call; **never run on a device or simulator**. Expect rough edges, and please report device results.
- **Android** — not started.

`resolve` and `--heal` are verified end to end against a real application using scripted models: the loop, the verification, the produced file and the resulting diff. The *quality* of a real model's proposals depends on the model you plug in and is not measured here.

## Contributing

```bash
git clone https://github.com/gseyra1/QAI.git && cd QAI
npm install && npx playwright install chromium
npm test
```

```bash
npm run demo                                  # demo shop on :8899
npm run qai -- run examples/ --base-url http://127.0.0.1:8899/ --states ./examples/states-example.ts

npm run demo -- --app library --port 8896     # demo library on :8896
npm run qai -- run examples/library/ --base-url http://127.0.0.1:8896/
```

One folder per demo app: `examples/` targets the shop, `examples/library/` the library.

Issues and pull requests welcome at [github.com/gseyra1/QAI](https://github.com/gseyra1/QAI/issues).

## License

MIT © [Mouaad GSEYRA](https://github.com/gseyra1) — Tilmicode. See [LICENSE](LICENSE).
