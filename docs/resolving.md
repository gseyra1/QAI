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
`driver.resolve()`. Three possible refusals, each with its message:

| Refusal | What the model gets back |
|---|---|
| No match | "no element matches this target" |
| Multiple matches | "ambiguous target, N elements match — disambiguate with `within` or `nth`" |
| Only the technical fallback worked | "the semantic targeting is wrong" |

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

## What is not left to the prompt

All of these are guaranteed mechanically, because they can be. A rule stated in
the system prompt holds most of the time, which is not the same thing.

**A generated `navigate` is rewritten relative to the base.** The model copies
the URL it sees, development port included. Written as-is into a versioned
file, it replays only on the machine that produced it — and verification cannot
catch that, since the absolute URL works perfectly at resolving time. The path
is made relative to `--base-url`, not to its origin: an application served
under a prefix keeps it, and the relative form follows the base wherever it is
mounted. The rewrite happens **before** the action is executed, so what gets
versioned is what was actually played.

An absolute URL to **another** origin is kept as is. That is a deliberate
navigation out of the application, not an address copied by accident.

Both rewrites are web only. On iOS a `navigate` is a deep link or a relaunch
and a URL check compares the screen identifier: both are kept as written.

**A generated `urlEquals` is rewritten the same way.** Same bug, same fix, same
rules (shared code): a literal absolute URL on the base origin becomes relative
to the base — `"orders?id=3"`, `"/login"` outside the base path, `"."` for the
base itself. Replay resolves it against its own base and compares strictly, so
the asserted address is unchanged. Templates (`{{…}}`) and other origins are
kept. The rewrite happens **before** verification, so the stored value is the
one proven against the screen. Without `--base-url` (a harness calling
`generateResolution` without `baseUrl`) the value is kept and a warning is
reported. Repairing never touches checks.

**A `urlContains` holding an absolute address of the application is refused**
back to the model, never rewritten. An absolute substring anchors the origin
and the start of the path; any relative form loses that anchor —
`http://host/orders` turned into `orders` would match `/login?next=/orders`,
the very redirect an access check must catch. The model picks `urlEquals` or a
fragment it stands behind.

**A verification-only step gets no actions; a step with an intent gets at least
one.** For a step with no intent on the platform being resolved, phase A is
skipped: the model is only asked for captures and assertions on the current
screen, and a proposal carrying actions is refused. For a step with an intent,
an empty `actions` list is refused. A step that has no intent there and nothing
to verify fails without a model call. The prompt mentions it; the code enforces
it.

**`{{env.NAME}}` is refused when the intent does not name NAME.** The model
readily generalises the secrets rule to any value it has to type: "fill in the
address with the client-fr data set" came back as `{{env.QAI_USER}}`. The noisy
case — the variable does not exist — fails on its own. The silent case is the
dangerous one: if CI does define `QAI_USER` for the login journey, the login is
typed into the address field with no error, and because the value comes from
the environment the registry masks it as `***` in every report. Wrong value,
and invisible to whoever reviews it.

## The output file

Serialized with a fixed key order: its diff is what a developer reads when a
repair is proposed. An unstable order would make that diff unreadable and ruin
the trust argument.

Nothing is written if any step fails: a partial resolution would produce greens
that prove nothing.

The file carries a format `version` (up to 3). It goes up when the observation
changes (v2) or when the meaning of a stored field changes (v3: relative
`urlEquals` values resolved against the base, empty `actions` for
verification-only steps). A file is written with the lowest version its content
needs: v3 only when it uses one of those, v2 otherwise, so a heal does not make
it unreadable for a teammate on an older QAI. A QAI older than the file refuses
it. `qai check` and `qai run` warn about v1 files only: a v2 file is a valid v3
file.

## The limits, plainly

The loop is verified end to end against a real application, but with a **fake
model** replaying a known resolution. Proven: the sequencing, the verification,
the error feedback, the output file, and that the generated resolution replays
green. Not proven: the quality of a real model's proposals — that depends on
the model you plug in.

Attempts per step are bounded — 5 by default, `--attempts <n>` — and the spend
cap applies to the whole resolving run.

`qai resolve` prints `(N attempts)` beside every step that needed more than
one. Watch that number: a prompt rule that is degrading shows up as a rising
attempt count well before it shows up as a failure, and the budget would
otherwise absorb it in silence.

## And tier 2

Repairing is this same loop applied to a single target instead of a whole
journey: observe, propose, verify with `resolve()`. That is `ModelHealer` —
see [repairing.md](repairing.md).
