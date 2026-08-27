# The configuration file

`qai.config.json`, found by walking **upward** from the current directory —
like the rest of the Node toolchain, because a team runs its tests from
anywhere in the repo.

```json
{
  "scenarios": ["qa/"],
  "tags": [],
  "baseUrl": "http://localhost:3000",
  "states": "./qa/states.ts",
  "provider": "./qa/provider.ts",
  "workers": 4,
  "maxCost": 2,
  "assertTimeout": 5000,
  "artifacts": ".qai/artifacts",
  "strict": false,
  "watchdogs": { "consoleErrors": "off", "requestFailures": "off", "allow": [] }
}
```

Then, from any directory:

```bash
qai run
```

**Command-line options always override the file** — override `--base-url` per
environment without duplicating the configuration.

## Selecting by tag

`tags` — or `--tags critical-path,billing` — keeps only the journeys carrying
**at least one** of the requested tags. It is a union, not an intersection: the
useful reading is "the blocking set plus billing".

```bash
qai run --tags critical-path       # on a pull request
qai run                            # the whole suite, at night
```

The filter applies to `check` and `resolve` too, so that the consistency check
and the generation bear on exactly the same set as the replay.

**A filter that keeps nothing fails the command.** Exiting 0 would mean a
misspelled tag turns a CI job green without having run anything.

## The watchdogs

`watchdogs` reports what no assertion declares but nobody really accepts: a
failed request, a console error. Three levels per watchdog — `off`, `warn`,
`fail` — and an `allow` list of tolerated fragments.

The default is `off` everywhere, and the climb happens in two steps:

```json
"watchdogs": { "requestFailures": "warn" }   ... then "fail"
```

Setting them straight to `fail` would break whole suites on the day of the
upgrade, on pre-existing errors — and the team would learn to switch them off,
which costs more than never having set them.

**`allow` is shared by both watchdogs.** A fragment is looked for in the URL
for `requestFailures` and in the text for `consoleErrors`, so one list covers
both — and a fragment written for one will silence the other too if it occurs
there. That is intended, since the same noisy third party usually produces both
kinds of noise, but it is worth knowing before widening the list.

**An unknown level stops the command.** Ignoring it fell back to `off`, so a
typo on `fail` disarmed the very watchdog you meant to arm, and the suite went
green without anyone asking. Same treatment as an unreadable numeric setting.

Behaviour in detail in [docs/engine.md](engine.md).

## Rules

**Paths resolve relative to the file**, not the current directory. Otherwise,
running QAI from a subfolder would silently break the resolution of `states`
and `provider`.

**An unknown key is silently ignored.** `assertTimeout` only exists since
0.1.0: set in a project running an older version, it produces no error and no
effect. Check the version before concluding a setting does nothing.

**A file that exists but is invalid fails the command.** Ignoring it would run
the suite with settings nobody chose — a mistyped field is dropped
individually, but broken JSON stops everything.
