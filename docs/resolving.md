# Resolving

`qai resolve` takes a hand-written scenario and produces its resolution. This is
tier 3 — the product's entry point, and the only moment a test is created.

```bash
npm run qai -- resolve my-journey.qai.yaml \
  --base-url http://localhost:3000 \
  --provider ./my-provider.mts \
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
| The fallback names another element | "fallback "x" is the identifier of another element" |
| The fallback names nothing | "fallback "x" designates no element on this screen" |

A target that only works through its `data-testid` is not portable to mobile.
It is refused at resolving time rather than discovered in phase 2.

**A fallback must designate the element the primary locator found.** Its
`testId`/`accessibilityId` is compared with that element's own identifier. A
fallback is only used the day the primary stops matching; pointing at a
neighbour — the cell around a button, seen with a real model on iOS — the
gesture would then land elsewhere with no error, and the next check could
still pass. Repairs go through the same check. `fallback.selector` is not
checked.

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

## Two trees must agree

The model is shown the pruned tree. Replay reads the full one, where unnamed
elements (an icon, a spacer, an empty cell) still match a target: judged on the
pruned tree alone, `{ "role": "text" }` was unique while resolving and ambiguous
on replay, on identical data.

With the built-in drivers (web and iOS), each look reads the full tree once and
derives the pruned tree from it by the drivers' own rules (`src/driver/prune.ts`).
Tests check that the derived tree, and the text the model receives, are exactly
what `observe({ interactiveOnly: true })` returns, on every demo page and every
iOS source fixture. An element carries the same id in both trees, and every
capture and assertion is verified on both:

- A capture is judged on the model's tree first, as before, then must find the
  same element on the full tree.
- An assertion must hold on both trees and read the same elements on both: the
  first match for `textEquals`, `numberEquals` and `stateIs`; for `visible` and
  `textContains`, every element it reads on the model's tree must be among those
  it reads on the full tree. `absent` and `countAtLeast` only have to hold on
  both. Only the elements a check reads are compared, never their containers: a
  wrapper that pruning removes shifts a container's position without changing
  what is read.
- Nothing the pruned tree alone would refuse is accepted.

A check false on the model's tree gets the usual reason, read on that tree. A
check true there that the full tree contradicts gets one fixed message, which
quotes nothing from the full tree:

> replay would read another element: replay also sees the unnamed and hidden
> elements your tree leaves out. Name the element with { "contains": "..." } on a
> stable part of its name, or put it within a named container, rather than using
> nth.

Measured with DeepSeek: told only to target by name, the model copied the value
into the name. A capture target missing or ambiguous on the model's own tree
keeps the single "target not found or ambiguous" message: splitting the two made
the model copy values.

"Already true before the gesture" (below) counts a check true on either tree, and
the self-comparison warning is computed on both. With these drivers, a
verification-only step does not read the screen before it, since it has no
gesture.

The agreement applies to the built-in drivers only. A third-party driver is
resolved as before: one `interactiveOnly` read per look, and every capture and
assertion judged on that tree alone, with the same messages and warnings.

One limit follows: a bare value whose only identity is its position, after an
unnamed element of the same role, has no `nth` that reads it on both trees. It
resolves only if it is the first element of its role in some named container
(or in the page) with no unnamed one before it; a named container that also
holds the unnamed element does not help. Otherwise the step fails at resolving
(it used to resolve, then fail on replay), or the model puts the value in the
name, which is reported as a capture located by its own value.

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
and a URL check compares the screen identifier: both are kept as written. The
model's instructions follow the platform: on iOS it is told to navigate by deep
link (or `"."` to relaunch) and that the location is
`"<bundle id>/<navigation bar title>"`.

**A generated `urlEquals` is rewritten the same way.** Same bug, same fix, same
rules (shared code): a literal absolute URL on the base origin becomes relative
to the base — `"orders?id=3"`, `"/login"` outside the base path, `"."` for the
base itself. A path-absolute value is rewritten too, as `navigate` is: resolved
at replay against a prefixed base, `"/"` would mean the origin root, not the
app. Generated under `http://host/`, `"/"` becomes `"."` and `"/orders"`
becomes `"orders"`; under `http://host/app/`, `"/app/orders"` becomes
`"orders"` and `"/login"` stays as is. `urlContains` is never rewritten. Replay resolves it against its own base and compares strictly, so
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

So is a `urlContains` that **cannot fail**: one naming the host (`localhost:4173/orders`
pins this host and port), or one contained in the base itself (`""`, `/`,
`localhost`), which every page of the application shares.

**A target located by the value it asserts is reported, not refused.**
`textEquals "1"` on `{ "role": "text", "name": "1" }` compares nothing: once
found, the element's text *is* its name. It still fails when the value changes
(assertion targets are never repaired), but as "no element matches" instead of
"expected 1, observed 2", and today's data is frozen in the file. Applies when
the target's own `name` contains the expected value (or, for `numberEquals`,
the same number); containers' names and fields compared by their value are
exempt.

**A capture located by the value it reads is reported too.** Reading
`{ "role": "text", "name": "39,00 €" }` returns 39,00 € by construction: the
first price change breaks it. Applies when the locator's name fully determines
the value read; a partial label (`contains: "Référence"`) reads something and
is not reported.

Why not refuse: measured with a real model, refusing made things worse. It
dropped the value for a `visible` on a structural target — green when the
displayed status was wrong — captured the wrong element, or stopped converging
within 5 attempts. Both show up as warnings in the `qai resolve` output; the
model never sees them.

**An assertion already true before the gesture is sent back once.** On a step
with an intent, each assertion is also evaluated against the screen the step
started from (with the step's own captures; `noFailedRequests` and
`noConsoleErrors` excepted). True there, it does not depend on the gesture.
Measured with DeepSeek: a step resolved by a `navigate` that reloads the app,
with an assertion true anyway — green, proving nothing. Legitimate invariants
exist ("the header still shows the shop name", "no error is shown" as
`absent`), so it is not refused: it goes back to the model once, before acting
when it can (the only moment the gestures can still be fixed), otherwise after.
The model asserts what the step changes, or resends the check unchanged if it is
a deliberate invariant; then it is accepted with a warning, as is any answer
that still holds before (no second turn). At most one extra turn per assertion;
before acting only when a turn is left after the answer to repair the checks;
never on the last attempt (warning instead), never on a verification-only step.
It is a question, not a rejection: when the answer is refused, the questioned
proposal is kept, with the warning, and the attempts left go to repairing the
checks. An accepted answer is final, because its gestures are played: it can only
fail the step if the model made them worse.

**A capture the expectation names is not frozen as a literal.** "the loan list
contains the reference "{{reference}}"" came back as `textContains "EMP-4418"`:
today's value, which keeps passing at replay whatever the capture reads. When
the expectation names `{{name}}` and the check's value does not use it:

| The check's value | Outcome |
|---|---|
| equals the capture's current value (as a number for `numberEquals`) | rewritten to `{{name}}`, note |
| equals it, under 3 characters, or equals two captures at once | asked once: `{{name}}`, or resent unchanged; kept as is with a warning |
| contains it | refused, with the exact rewrite: `write {{reference}} in place of "EMP-4418": "{{reference}} — en cours"` |
| is only part of it (the capture read `Référence EMP-4418`) | warning: the fix belongs to the capture, with `after`/`before`, at a step already resolved |

The target gets the same treatment: "the list contains {{reference}}" written as
`visible` on `{ "contains": "CMD-7797" }` is green at resolving and red on the
next order. A name holding the captured value is rewritten to `{{name}}`, every
named capture included, even when the check's value already uses it. A name that
is only part of the capture, or holds one too short or numeric to rewrite, is a
warning. A capture's `from` holding a capture its description names gets the same
treatment. A rewrite is a `note` in the output: it was fixed and checked again, so
`--strict` does not stop on it. A check comparing a capture with the element it was
just read from cannot fail, and is always a warning.

Containment counts on word boundaries only, and from 3 characters: "1" inside
"Livraison en 1 jour" proves nothing, so a shorter value is reported, never
refused. Equality with every named capture is tried before containment, the
longest value first: `EMP-4418` is `{{reference}}`, not `{{prefix}}-4418`.
Values from `{{env.…}}` are masked as `[secret]` in the message.

**A value inside a sentence is captured between fixed words.** A capture reads
a whole element, and "Order CMD-1042 is confirmed" is one element. `after` and
`before` keep what stands between two literals:

```json
{ "from": { "role": "text" }, "extract": "text", "after": "Order ", "before": " is confirmed" }
```

`before` is searched after `after`, either one can stand alone, and the result
is trimmed. A bound missing from the text fails the capture rather than
returning the whole sentence, at resolving (the model is shown the text it read)
and at replay. Bounds are literals, not a regular expression: they read well in
a diff, and they do not describe the shape of the data. A bound holding a number
is reported: it may be the data itself.

A capture that reads a whole text of two words or more, or a number out of a text
holding several, is asked about once, with its description: measured with a real
model, it never bounded a value on the prompt alone. "Chaise de bureau" is a whole
text, and the model says so.

This question cannot make a step worse. It comes on top of the attempts, only when
an attempt is left, and costs at most two model calls per step, since a bound
copied wrong gets one correction. Only the bounds of that capture are taken from
the answer, and they must pass every check again. Anything else in the answer is
ignored. A failed call, or bounds refused twice, leaves the capture whole, with a
warning.

**An action target whose name holds a number is reported.** "Panier 1" no longer
exists when the cart changes, and the prompt alone does not stop the copy. "Étape
2" is a real label, so it is a warning, not a refusal. A name with no digit
("Chaise de bureau") is not detected.

A text over 120 characters has no accessible name on the web: observation drops
it to keep the tree small, so it cannot be captured.

**Every proposal is checked key by key against the shape
[schema/resolution.schema.json](../schema/resolution.schema.json) allows.** A
locator takes `role`, `name`, `nth` and `within` only; checks, actions,
gestures and captures take exactly their own fields. A missing field is named
(`textContains needs a "value"`) rather than surfacing later as `"undefined"
not found`. Two shapes the schema allows are refused because they prove
nothing: a `value` on `visible`/`absent` (never compared — the reviewer would
believe it was) and `countAtLeast 0` (true on any screen).

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
the environment the registry masks it as `[secret]` in every report. Wrong value,
and invisible to whoever reviews it.

## The output file

Serialized with a fixed key order: its diff is what a developer reads when a
repair is proposed. An unstable order would make that diff unreadable and ruin
the trust argument.

Nothing is written if any step fails: a partial resolution would produce greens
that prove nothing.

The file carries a format `version` (up to 4). It goes up when the observation
changes (v2), when a new field appears (v4: `after` and `before` on a capture)
or when the meaning of a stored field changes (v3: relative
`urlEquals` values resolved against the base, empty `actions` for
verification-only steps). A file is written with the lowest version its content
needs, so a heal does not make it unreadable for a teammate on an older QAI. A
QAI older than the file refuses it. `qai check` and `qai run` warn about v1
files only: a v2 file is a valid v3 and v4 file.

`qai resolve --strict` writes nothing when a warning remains, and exits 1.
Without it, warnings are printed and the file is written. It turns every signal
of this page into a stop, including a label that really holds a number, so it
suits a pipeline that resolves unattended better than a first draft. It is a flag
only: `strict` in `qai.config.json` speaks of repairs at replay.

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
