# The replay engine

The engine takes a scenario, its resolution, and a driver, and produces a report.
It knows nothing about the platform — the driver does.

## Tier 1 must cost zero

In the nominal case, the engine only executes what the resolution already
contains. No model call, no inference, no natural-language interpretation — the
intent text is used only in the report. This keeps a run's cost negligible and
self-serve pricing viable.

## One intent, several gestures

A step resolves to a **list** of actions, not one: "fill in the shipping
address" or "log in" map to several primitive gestures. Assertions and captures
are evaluated after the step's last gesture, and **re-evaluated while false**
within a bounded window (`--assert-timeout`, 5 s default).

The window relaxes nothing: the assertion is never rewritten or widened — it is
given time to become true. It exists because network idle does not mean
rendering is done: a 3D scene, an entry animation, or a lazily loaded module
lands later. Without it, such applications could not assert any screen.

## Assertions live here, not in drivers

`matchNodes()` matches a locator against the observed tree; `evaluateCheck()`
applies the check. Both are pure functions, testable without a browser, and
**shared by all platforms**. That is the structural guarantee that "the total
equals 42" means exactly the same thing on web and mobile.

Number parsing tolerates French and English formats: `129,00 €`, `$1,234.56`
and `1 234,56 €` compare without the scenario caring. A dot followed by three
digits is treated as a thousands separator — the right bet for displayed
amounts.

`evaluateCheck()` receives a context — the tree, the current address, the
captures already known — not just the tree. That is what lets a check bear on
something other than a node.

### Checking the address

`urlContains` and `urlEquals` are the only two checks **without a target**: a
URL is not a node of the interface. They make the whole family of access-rights
journeys expressible — "an anonymous user is redirected to the login page" —
which has nothing to assert about the screen it lands on except where it landed.

```json
{ "check": "urlContains", "value": "/login" }
{ "check": "urlEquals", "value": "https://app.example.com/login?next=/admin" }
```

The comparison is **raw**: neither trailing slash, nor query string, nor
fragment is normalised. Erasing them would make a redirect to
`/login?next=/admin` look like a redirect to `/login`, when that difference is
precisely what an access-rights journey sets out to prove. `urlContains` covers
the common case where only the path matters.

The value accepts `{{capture}}`, which allows asserting an address built at the
previous step — `/students/{{id}}` after creating a record.

Like any assertion, a URL check is re-evaluated within the `assertTimeout`
window: a redirect that arrives after network rest is seen.

## The safety boundary, made structural

The engine calls the healer **only** on a target resolution failure. A false
assertion never triggers it, and this is not a configuration option: the code
offers no path to do it. A test verifies this explicitly.

The exact order before tier 2:

1. `resolve()` — the cache is enough, continue.
2. Non-ambiguous failure: `settle()`, then a second `resolve()`. This retry
   absorbs rendering instability before spending anything.
3. Still not found: call the healer, within budget.
4. False assertion: **failure**, no matter what.

An ambiguous target is handled separately and **is not retried**: two matching
elements will not collapse into one over time. The cache is under-specified and
must be regenerated.

## The three-state report

`passed` / `healed` / `failed`. Healed is not a silent success — it means the
journey works but the cache changed, and that change awaits human review.

After a failure, the remaining steps are marked `skipped` rather than executed:
application state has diverged; continuing would only produce noise.

## The consistency check

`checkConsistency()` compares a scenario and its resolution before running
anything. It catches silent drift: a step added without regenerating the cache,
a reworded assertion whose machine form still points at the old text, an
orphan resolution left behind by a deleted step.

None of these breaks at runtime — they produce false greens, which is worse.
Run the check in CI before replay.

## The other tiers

The healer exists ([repairing.md](repairing.md)), resolving exists
([resolving.md](resolving.md)), CI integration exists ([ci.md](ci.md)).
Without a healer supplied, a missing target is simply a failure.

Only the mobile drivers remain to be written.
