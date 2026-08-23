# Self-repair

When a target no longer resolves, `qai run --heal` asks the model to relocate
it, **verifies the proposal against the application**, then rewrites the
resolution file. The developer reviews the diff and merges.

```bash
npm run qai -- run my-journey.qai.yaml \
  --base-url https://preview-42.mon-app.dev \
  --heal --provider ./my-provider.ts --max-cost 1
```

Same loop as resolving, applied to a single target — observe, propose, verify
with `resolve()`, retry on failure.

## The non-negotiable rule, enforced twice

The healer cannot touch assertions. Two independent barriers:

1. **The engine** invokes it only on a *target resolution* failure. A failing
   assertion never triggers it — that is a regression.
2. **Its output schema** exposes only `target` and `note`. Even invoked by
   mistake, it could return nothing else.

A healer allowed to edit assertions would learn to make bugs pass. That is the
only thing separating a testing tool from a lying one.

## Two contexts, two behaviors

| Situation | Repair | On failure |
|---|---|---|
| Target not found, no fallback | mandatory | the step fails |
| Target reached only through its technical fallback | opportunistic | the journey continues, with a warning |

The second case: when semantic targeting dies but the `data-testid` still
holds, the journey works — failing would be crying wolf. But staying silent
would let every locator quietly degrade to a technical id, and **mobile
portability die unnoticed**. So QAI repairs to restore semantic targeting, and
warns when it cannot:

```
⚠ "Ajouter au panier" was only reached through its technical fallback:
  the application's accessibility has degraded and this targeting will
  not survive the mobile port
```

## The diff is the whole argument

Repairing a label produces exactly this:

```diff
-          "target": { "primary": { "role": "button", "name": "Commander en tant qu'invité" } }
+          "target": { "primary": { "role": "button", "name": "Continuer sans compte" } }
-      "healedAt": null
+      "healedAt": "2026-08-23T21:12:09.114Z",
+      "healNote": "The guest checkout button label changed from 'Commander en tant qu'invité' to 'Continuer sans compte'."
```

Four lines, reason attached. Not cosmetic: if a one-word repair produced three
hundred lines of diff, nobody would review it, and "repairs are auditable"
would be an empty slogan. The file is therefore printed as compact JSON —
small objects on one line — and a test verifies a repair never exceeds six
diff lines.

Unlike tools that repair silently in their cloud, the full history of
adaptations lives in your repo, reviewable and revertible.

## Guardrails

- **One retry after a pause** precedes any repair: render flakiness must not
  cost a model call.
- **An ambiguous target is never retried** — two matches will not collapse
  into one over time. It goes straight to repair: the healer receives the
  ambiguity and must resolve it with `within` or `nth`.
- **The budget is bounded** — three repairs per journey by default, plus the
  provider's spend cap. Massive drift is not a stale test; it is an
  application that changed nature.
- **A repair can neither add nor remove a step.** Working around what no
  longer passes is the definition of a false negative.

## Remaining work

The loop is verified end to end against a real application, with a scripted
model. The quality of a real model's proposals is not measured — it depends
on the model you plug in.
