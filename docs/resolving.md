# Resolving

`qai resolve` takes a hand-written scenario and produces its resolution. This is
tier 3 — the product's entry point, and the only moment a test is created.

```bash
npm run qai -- resolve my-journey.qai.yaml \
  --base-url http://localhost:3000 \
  --provider ./my-provider.ts \
  --max-cost 2
```

## What makes the loop reliable

A free-running agent drifts. This one is not free: **every proposal is checked
against the real application before being accepted**, and failure comes back to
the model in the vocabulary it just used.

Each step goes through two verification phases.

**Phase A — actions, before acting.** Every proposed target goes through
`driver.resolve()`. Three possible refusals, each with its message (runtime
messages are in French today):

| Refusal | What the model gets back |
|---|---|
| No match | « aucun élément ne correspond à cette cible » |
| Multiple matches | « cible ambiguë, N éléments — précise avec `within` ou `nth` » |
| Only the technical fallback worked | « le ciblage sémantique est faux » |

The last one matters: a target that only works through its `data-testid` is not
portable to mobile. It is refused at resolving time rather than discovered in
phase 2.

**Phase B — captures and assertions, after acting.** A capture must match
exactly one element and extract a readable value. An assertion must **pass on
the resulting screen**:

> We are recording a known-good state. An assertion false at resolving time is
> a test false forever.

This is the strongest ground truth in the system, and it costs nothing: the
assertion engine already exists and is reused as is.

Invented assertions are also refused. The model may only emit keys present in
the scenario, copied exactly — otherwise the file fills up with checks nobody
asked for.

## Why two phases

Actions change application state; captures and assertions only exist
afterwards. Checking everything before acting is impossible; checking
everything after would make a wrong action unrecoverable. A phase B failure
therefore does not replay the actions: only the checks are retried, against the
screen actually obtained.

## What the model sees

Not JSON. An indented tree, one line per element:

```
group
  link "Boutique"
  link "Panier 1"
    text "1"
  searchbox "Rechercher un produit"
  list "Résultats"
    listitem
      link "Chaise de bureau"
```

Braces, quotes, and repeated field names make up most of a JSON payload's bytes
and carry no information. The tree is paid for on every call: its density is an
architecture decision.

## The output file

Serialized with a fixed key order: its diff is what a developer reads when a
repair is proposed. An unstable order would make that diff unreadable and ruin
the trust argument.

Nothing is written if any step fails: a partial resolution would produce greens
that prove nothing.

## The limits, plainly

The loop is verified end to end against a real application, but with a **fake
model** replaying a known resolution. Proven: the sequencing, the verification,
the error feedback, the output file, and that the generated resolution replays
green. Not proven: the quality of a real model's proposals — that depends on
the model you plug in.

Attempts per step are bounded (3 by default) and the spend cap applies to the
whole resolving run.

## And tier 2

Repairing is this same loop applied to a single target instead of a whole
journey: observe, propose, verify with `resolve()`. That is `ModelHealer` —
see [repairing.md](repairing.md).
