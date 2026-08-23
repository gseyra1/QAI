# Getting started

This guide runs QAI end to end against a demo shop, including a deliberately
broken build. Five minutes.

## Installation

```bash
npm install
npx playwright install chromium
npm test
```

The whole suite must pass. It includes a full checkout journey played in a real
browser, and an end-to-end resolving run.

## 1. Start the demo shop

In a first terminal:

```bash
npm run demo
```

It listens on `http://127.0.0.1:8899/`: a minimal shop — search, product page,
cart, guest checkout, order tracking — that serves as the test subject.

## 2. Check consistency before running

```bash
npm run qai -- check examples/checkout-guest.qai.yaml
```

No browser involved. `check` compares the scenario with its resolution and
refuses to continue if they have drifted — drift produces false greens, not
runtime errors. Details in [engine.md](engine.md).

## 3. Replay the journey

```bash
npm run qai -- run examples/checkout-guest.qai.yaml \
  --base-url http://127.0.0.1:8899/ \
  --states ./examples/states-example.ts
```

`--states` provides the state declared by the scenario's `given` block —
without it, QAI refuses to run a journey that requires one (see
[state.md](state.md)).

```
1 journey(s) — PASSED   1.6 s

  ✓ checkout-guest         PASSED  1.2 s

All green.
```

(Step intents appear in the scenario's own language — here French. The tool
itself speaks English.)

A green journey does not list its steps: detail only appears on failure, where
it is useful.

This replay cost zero model calls. Everything it needed was already in
`examples/.qai/resolutions/checkout-guest.web.json`.

## 4. Break the app and run again

In a second terminal, the same shop with a guest-checkout regression — the
order is submitted, the backend rejects it, the UI shows nothing:

```bash
npm run demo -- --bug guest-confirm --port 8898
```

```bash
npm run qai -- run examples/checkout-guest.qai.yaml \
  --base-url http://127.0.0.1:8898/ \
  --states ./examples/states-example.ts
```

```
1 journey(s) — FAILED   6.8 s

  ✖ checkout-guest         FAILED  6.4 s
    ✖ s8   payer avec la carte de test
          capture "commande": target not found or ambiguous
          la commande est confirmée → no element matches the target
          un numéro de commande est affiché → no element matches the target

1 journey(s) failed.
```

Exit code 1, so CI fails the pull request.

Two things to note. The failure is on an **assertion**, so the healer was never
invoked — even with `--heal`, it is not allowed to touch what is being
verified. Had the button merely changed label, QAI would have repaired it,
shown a `~`, and put the resolution diff up for review. **It tells a stale test
from a broken application** — the difference between a test tool and a tool you
trust.

Steps after `s8` did not run: after a failure the application state has
diverged, and continuing would only produce noise. The 6 seconds are the
assertion window: failure is only declared after giving the render time to
arrive (`--assert-timeout`, 5 s by default).

## 5. Write your own scenario

A scenario describes intents, never selectors:

```yaml
id: login
title: An existing customer signs in
tags: [critical-path]

given:
  state: visiteur-anonyme

steps:
  - id: s1
    do: open the login page
  - id: s2
    do: enter the username "client@test.fr" and the test password
  - id: s3
    do: submit the form
    expect: the menu shows the account name
```

The full format is in [scenario-format.md](scenario-format.md), validated by
[schema/scenario.schema.json](../schema/scenario.schema.json).

## 6. Make it runnable

A scenario alone is not enough: it needs its resolution. `qai resolve`
produces it, checking every model proposal against your application before
accepting it.

```bash
npm run qai -- resolve my-journey.qai.yaml \
  --base-url http://localhost:3000 \
  --provider ./my-provider.ts \
  --max-cost 2
```

The provider is yours: QAI ships no model SDK. Start from
[examples/provider-example.ts](../examples/provider-example.ts) — one method to
write. The loop is detailed in [resolving.md](resolving.md).

Then `check` and `run`, as in steps 2 and 3.

## 7. Let QAI repair a stale test

Third demo mode: a label changes, with no regression.

```bash
npm run demo -- --bug rename-guest --port 8897
```

```bash
npm run qai -- run examples/checkout-guest.qai.yaml \
  --base-url http://127.0.0.1:8897/ \
  --states ./examples/states-example.ts \
  --heal --provider ./my-provider.ts --max-cost 1
```

```
1 journey(s) — HEALED   9.4 s

  ~ checkout-guest         HEALED  9.0 s
    ~ s6   lancer la commande en tant qu'invité
          healed: The guest checkout button label changed from 'Commander en
          tant qu'invité' to 'Continuer sans compte'.

1 repair(s): review the resolution diffs before merging.
model spend: 0.0020 (1 calls)
```

Authentic output — one model call, a fifth of a cent. The resolution file is
rewritten; the diff is a few lines with the reason attached, ready for
review — see [repairing.md](repairing.md).

## 8. Run the whole suite

`run` and `check` accept files, directories, or a shell glob, and run journeys
in parallel:

```bash
npm run qai -- run examples/ --base-url http://127.0.0.1:8899/ --states ./examples/states-example.ts --workers 4
```

```
2 journey(s) — PASSED   1.7 s

  ✓ checkout-guest         PASSED  1.2 s
  ✓ compte-connecte        PASSED  534 ms

All green.
```

Each journey gets a fresh browser: sharing one would leak cookies and storage
between journeys, and the startup cost is the price of isolation.

`--states` provides the state declared by a scenario's `given` block — see
[state.md](state.md). Without it, `compte-connecte` fails: it requires an open
session.

## Not there yet

- **Mobile drivers.** CI integration does exist: see [ci.md](ci.md).
