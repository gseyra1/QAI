# Changelog

All notable changes to `tilmiqai`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer](https://semver.org/); before 1.0, a minor version may break.

## [0.4.1] - 2026-10-17

First npm release since 0.3.0: it ships 0.4.0 and 0.3.1, never published on
their own — read both.

### Added

- **Generation sends back, once, an assertion already true before the
  gesture.** On a step with an intent, each assertion is also evaluated on the
  screen the step started from. True there, it proves nothing about the step
  (measured: a `navigate` reload with an assertion true anyway). It goes back to
  the model before acting when possible, so the gestures can still be fixed,
  otherwise after. Resent unchanged (a deliberate invariant), or still true
  before, it is accepted with a warning. One extra turn per assertion at most;
  before acting only if a turn is left to repair the checks after it; never on
  the last attempt, nor on a verification-only step, nor for
  `noFailedRequests` / `noConsoleErrors`. It is asked as a question, not a
  rejection, and never fails a step: if the answer is refused and no turn
  repairs it, the questioned proposal is kept, with the warning.
- **Generation no longer freezes a capture as a literal.** When the
  expectation names `{{name}}` and the check does not use it: a value equal to
  the capture's current value is rewritten to `{{name}}` (warning); a value
  containing it is refused with the exact rewrite; a value that is only part of
  it is reported. Under 3 characters, equality is asked once as a question
  (`1` may be another number) and never rewritten, containment only reported.
  Containment needs word boundaries; equality is tried on every named capture
  before containment, longest value first.
- **Action input `package`**: install any npm spec (a local `.tgz`) instead of
  `tilmiqai@<version>`. The selftest now builds the branch and runs the Action
  on that tarball, so a pull request tests its own code; a separate workflow
  still tests the published `latest`.
- **iOS first-session checklist** in `docs/driver.md`: what to check, and send
  back, on the first real device or simulator run.

Measured with DeepSeek: the question catches what it should and raised no
false alarm, but a model can insist on a check that proves nothing — then only
the warning remains. Read the `warning:` lines of `qai resolve`.

### Changed

- The library example's last step (`s5`) is now verification-only: it no
  longer invents a gesture to state what the screen already shows. The demo
  library shows the loan reference in its own node (a capture reads a whole
  node; a value inside a sentence cannot be isolated), so `s5` now checks
  `{{reference}}` instead of a frozen `EMP-4418`. Resolution regenerated with
  DeepSeek, format v3.

### Fixed

- The first checks turn after the actions now tells the model why the captures
  and assertions proposed with the gestures were rejected. It used to ask again
  without the reason. A verification-only step, which proposed nothing yet,
  gets no such list.

## [0.4.0] - 2026-10-02

Tagged, never published to npm: ships with 0.4.1.

Resolution format v3 (portable URL checks, verification-only steps), an
**experimental** iOS driver, and generation that refuses more of what proves
nothing.

Upgrading from 0.3.0, the last version on npm: read [0.3.1](#031---2026-09-29)
too — it was never published, and its changes reach npm with this release.

### Added

- **iOS driver (experimental).** `IosDriver` drives an iOS app through Appium +
  XCUITest over W3C WebDriver. **Never run on a device or simulator**: it is
  tested against a fake Appium server that checks every HTTP call. Expect rough
  edges, and please report device results.
  - CLI: `--platform ios --app <bundle-id|path.app/.ipa> [--device <udid|name>] [--appium-url <url>] [--platform-version <v>] [--capabilities <json>]`.
    Same keys in `qai.config.json`: `platform`, `app`, `device`, `appiumUrl`,
    `platformVersion`, `capabilities`.
  - `--capabilities` / `capabilities` pass extra session capabilities (WDA
    signing, `appium:noReset`, `appium:newCommandTimeout`). The flag is merged
    over the config, key by key. Keys QAI sets itself (`platformName`,
    `automationName`, `app`, `bundleId`, `udid`, `deviceName`,
    `platformVersion`, prefixed or not, also inside `appium:options`) are
    refused.
  - Resolutions are written to `.qai/resolutions/<id>.ios.json`, next to the
    web ones.
  - Prerequisites (not dependencies): macOS + Xcode, Appium 2/3, XCUITest
    driver ≥ 4.17.
  - Limits: one journey at a time (`workers` forced to 1); `--headed` refused;
    `hover`, `upload` and `expectDialog` refused; network and console not
    observed, so `noFailedRequests`/`noConsoleErrors` fail and active
    `watchdogs` are refused; StateProvider `cookies`/`storage` refused,
    `entry` opens as a deep link.
  - The generation prompt follows the platform: deep links, location
    `"<bundle id>/<navigation bar title>"`, `swipe` offered.
- **Verification-only steps.** A step may omit `do` when it has
  `expect`/`capture`. Its resolution has `"actions": []`, and it replays with
  no gesture.
- **Portable URL checks.** A generated `urlEquals` on the app's own origin is
  stored relative (`"/login"`, `"orders?id=3"`, `"."`) and resolved against
  `--base-url` at replay. A path-absolute value (`"/"`, `"/orders"`) is
  rewritten by the same rule as `navigate`.
- **Mixed suites.** A journey with no step for the platform being run is
  skipped by `resolve`/`check`/`run`, with a line on stderr. A selection left
  empty fails.
- **Generation warns** (never refuses) when an assertion's target is located by
  the value it asserts (`textEquals "1"` on `{ role: text, name: "1" }`), or a
  capture by the value it reads. Refusing pushed a real model toward worse
  checks.
- **Generation refuses, and sends back to the model:**
  - a `urlContains` holding an absolute app URL, or one that cannot fail
    (`""`, `/`, the host, a value contained in the base);
  - a `fallback.testId`/`accessibilityId` that is not the identifier of the
    element the primary locator found (repairs too);
  - any key outside the resolution schema, at every level, with the key named;
  - a `value` on `visible`/`absent` (never compared) and `countAtLeast 0`
    (true on any screen).
- `qai --version`.
- GitHub Action: `provider` input, passed to `--provider`.
- A module given to `--states`/`--provider` that fails to load as ESM gets a
  hint: use `.mts`/`.mjs` or `"type": "module"`; `.ts`/`.mts` needs
  Node ≥ 22.18.
- Exports: `IosDriver`, `IosDriverError`, `IosDriverOptions`,
  `IosDriverErrorCode`, `runsOn`, `OBSERVATION_VERSION`.
- `CHANGELOG.md`.

### Changed

- A missing check value is named (`textContains needs a "value"`) instead of
  reported as `"undefined" not found`.
- iOS: a navigation bar no longer gets a test id (its identifier is the screen
  title). `Backspace`/`Delete` send `\u0008\u007F`, WebDriverAgent's own
  delete sequence.
- Report wording off the web: the fallback warning no longer says "will not
  survive the mobile port", and the summary no longer blames a `warn`
  watchdog when the suite has no web entry.
- `npm run measure` (repo only) prints in English.
- Examples: `library-loan` moved to `examples/library/` (it targets the library
  demo, `npm run demo -- --app library`), so `run examples/` passes against
  the shop. `cart-confirmation` says "the cart holds at least one item", which
  is what its `countAtLeast 1` checks.
- CI runs the tests on Node 22 and 24.

### Fixed

- When `resolve` ran out of attempts in the checks phase, the last refusal was
  missing from the report.

### BREAKING CHANGES

- **Resolution format v3.** `RESOLUTION_VERSION` 2 → 3. A file is stamped v3
  only when it needs it (a relative `urlEquals` or empty `actions`), otherwise
  v2. **QAI ≤ 0.3.x refuses v3 files** ("resolution is v3, this QAI reads up to
  v2"). v2 files keep working, and v2 no longer triggers the stale-resolution
  warning.
- **Scenario loader: unknown keys are refused**, at the top level, in `given`
  and in steps, with a near-miss hint (`unknown key "Do" — did you mean
  "do"?`). Ignored, a misspelled `do` next to an `expect` turned the step into a
  verification-only step and dropped its gesture. Also refused at load:
  `do: ""` or `do:` with no value, `per_platform: {}`, an empty `per_platform`
  entry, a `per_platform` key other than `web`, `mobile`, `ios`, `android`.
- **`runScenario({ …, baseUrl })`.** New `RunInput.baseUrl`. Without it, a
  relative `urlEquals` is compared raw and fails. `runSuite` and the CLI pass
  it already; direct embedders must too. `generateResolution` also takes
  `baseUrl`; without it, absolute URLs are kept and a warning is reported.
- **`runScenario` and `generateResolution` throw before any gesture or model
  call** when the resolution was written for another platform than
  `driver.platform`, or when the scenario has no step on that platform. They
  used to run and could end green.
- **Observation checks fail on drivers without `drainObservations`.**
  `noFailedRequests`/`noConsoleErrors` fail with "not observable on
  <platform>" instead of passing vacuously. Affects custom drivers.
- **Replay: a `textContains` with an empty value fails** (typically a
  `{{capture}}` that came back empty). It was true on any text.
- **`IssueKind` widened** with `'unexpected-actions' | 'empty-step' |
  'platform-mismatch' | 'not-on-platform' | 'relative-navigate'`: exhaustive
  `switch`es stop compiling. `checkConsistency` / `qai check` reject pairs
  0.3.0 accepted:
  - a verification-only step whose resolution still has actions;
  - a step that neither acts nor verifies on the platform;
  - a resolution for another platform;
  - a relative `navigate` off the web.
- **CLI exits 1 on:** `--app`, `--device`, `--appium-url`,
  `--platform-version` or `--capabilities` without `--platform ios`; an unknown
  `platform` in `qai.config.json`; an unknown `--format` (it used to write the
  text report under the requested name).
- **Generation refuses more** (see Added). A `resolve` or `--heal` that passed
  with 0.3.x can now need more attempts, or fail. Replay of existing files is
  unaffected.
- `GenerateStepReport` gains `warnings`. What was accepted but deserves a read
  (an absolute URL kept without a base, a target located by its own value) moved
  out of `rejections`; `qai resolve` prints it as `warning:`.

### Upgrade

1. Upgrade QAI everywhere that reads your resolutions (CI, the GitHub Action
   `version` input if pinned, teammates) **before** committing files stamped
   v3, or scenarios with verification-only steps: 0.3.x refuses those with
   `step "sN" has neither do nor per_platform`, without an upgrade hint.
2. Run `npx qai check` on your suite and fix what the loader now refuses
   (unknown keys, empty `do`, empty or unknown `per_platform`).
3. Teams mixing 0.3.x and 0.4.x on a base URL with a path prefix: pass
   `--base-url` with a trailing slash. A relative `navigate` (`"."`) is stamped
   v2, but 0.3.0 resolves it against a prefix without a trailing slash
   differently — the run fails, it does not pass.
4. Embedders: pass `baseUrl` to `runScenario` (and `generateResolution`);
   expect throws on a platform mismatch; handle the new `IssueKind` values.
   Custom drivers: implement `drainObservations()` or don't use
   `noFailedRequests`/`noConsoleErrors`.
5. `--states`/`--provider` modules are loaded as ESM. In a `"type":
   "commonjs"` project (what `npm init -y` writes), rename `.ts` to `.mts`. A
   `.ts`/`.mts` module needs Node ≥ 22.18.
6. Existing v1/v2 resolutions need no regeneration. A v1 file still triggers
   the "regenerate with qai resolve" warning.
7. iOS: see [docs/driver.md](docs/driver.md#ios-driver--experimental).

## [0.3.1] - 2026-09-29

Not published to npm; shipped with 0.4.1.

### Added

- `examples/provider-deepseek.ts`: a provider for a JSON-mode model without
  schema-constrained output. The schema travels in the system message, and a
  malformed answer is sent back to the model like any refusal.
- A second demo app, `npm run demo -- --app library`, whose vocabulary never
  reached the prompt, with its journey `library-loan`.
- A step warning when a secret is too short (≤ 2 characters) to be redacted.

### Changed

- **Portable navigation.** A generated same-origin `navigate` is stored relative
  to `--base-url` (its path prefix kept), and rewritten before it is played, so
  what is versioned is what was verified. The web driver normalises its base
  with a trailing slash.
- **`{{env.NAME}}` is refused** in generation when the intent does not name
  `NAME`.
- **`--attempts` default 3 → 5**: a failing step can cost up to 5 model calls
  during `resolve`. `resolve` prints `(N attempts)` beside every step that
  needed more than one.
- A provider that throws (non-JSON, empty or truncated answer) costs one
  attempt instead of aborting the remaining scenarios.
- `SecretRegistry.add()` returns `boolean` (was `void`).

## [0.3.0] - 2026-09-03

### Added

- URL checks: `urlContains`, `urlEquals`.
- Typed values from the environment (`{{env.NAME}}`), treated as secrets and
  redacted from every report and from what reaches the model.
- `--tags` selection, JUnit report (`--format junit`).
- Actions: `select` by label, `expectDialog` for native dialogs, `upload`
  (confined to the scenario's folder, symlinks resolved).
- Network and console observation: `noFailedRequests`, `noConsoleErrors`, and
  `watchdogs` (`off`/`warn`/`fail`).
- Nearest labels suggested when a target goes missing.
- The engine is exported for embedding (`runScenario`, `runSuite`,
  `checkConsistency`, …).

### Changed

- **Resolution format v2**: the observed accessible names now match Chromium
  (text of generic containers, descendants' names, hidden subtrees, `<br>`). A
  v1 resolution warns instead of failing silently; regenerate it with
  `qai resolve`.
- A missing resolution is reported instead of stopping the command.
- A misspelled or non-object `watchdogs` block stops the command.
- Runtime messages in English.

[0.4.1]: https://github.com/gseyra1/QAI/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/gseyra1/QAI/compare/v0.3.0...v0.4.0
[0.3.1]: https://github.com/gseyra1/QAI/compare/d9b5430...43ceebe
[0.3.0]: https://github.com/gseyra1/QAI/tree/v0.3.0
