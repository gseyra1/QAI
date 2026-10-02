# The driver contract

A driver is the only place in the system that knows which platform it runs on.
Everything above it — replay engine, repair stage, assertion evaluation —
neither knows nor cares whether it drives a browser or an iOS simulator. That
boundary is what makes "one scenario, two platforms" hold.

## Four responsibilities, not five

| Method | Role |
|---|---|
| `observe()` | render the current screen as a normalized tree, plus a capture on demand |
| `resolve()` | translate a cached target into a concrete element, or say precisely why it fails |
| `act()` | execute an action |
| `settle()` | wait for quiescence before observing or declaring a failure |

**Assertion evaluation is deliberately absent.** It lives in the engine,
applied to a `UISnapshot`. If each driver implemented its own assertions, web
and mobile would drift apart on what "the total equals 42" means, and
portability would silently break.

`settle()` belongs in the contract rather than being improvised in the engine:
it is the anti-flakiness filter placed **before** the repair stage. Without it,
every not-yet-rendered element would trigger a model call and pollute the
repair history with timing noise.

## What `resolve()` must distinguish

Its result decides what the repair stage does next:

| Result | Meaning | Next |
|---|---|---|
| `found`, `usedFallback: false` | cache valid | replay, zero cost |
| `found`, `usedFallback: true` | semantic locator failed, fallback worked | works, but the app's accessibility has degraded — report it |
| `no-match` | nothing matches | tier 2: the model relocates |
| `ambiguous` | several legitimate candidates | **do not act** — the cache is under-specified, regenerate it |
| `not-visible` | found but off-screen or hidden | scroll, then retry |

`ambiguous` tempts you to pick the first element. Don't: the day the app adds
a second "Valider" button, a test that "passes" by silently clicking the wrong
one is worse than no test at all. The driver refuses to choose and reports the
match count.

## Uploading a file

```json
{ "kind": "upload", "target": { … }, "files": ["fixtures/statement.csv"] }
```

The paths are **relative to the scenario file**, and it is the engine that makes
them absolute just before acting — at generation and at replay alike, from the
same base. The resolution file is versioned: writing an absolute path into it
would produce a cache that only replays on the machine that wrote it.

**A path that leaves the scenario directory is refused**, absolute paths and
`..` included, and nothing is sent. Actions are not always written by hand:
they come from a model reading the screen, and a screen is untrusted input. An
upload the engine did not frame would let a scenario hand the application under
test any file on the machine — a private key, a `.env`. The refusal names the
expected directory so it can be corrected.

The target is the `input[type=file]` itself, almost always hidden behind a
styled button. `setInputFiles` accepts it where a click would fail. An input
with no accessible name has nothing to target semantically: the resolution will
go through its technical fallback, and this is the case where that fallback is
legitimate rather than a sign of degradation.

## Native dialogs are declared before the gesture

Playwright **auto-dismisses** `confirm()`, `alert()` and `prompt()` as long as
nobody is listening. A "delete then confirm" journey therefore ran without any
error and without deleting anything: the worst case, a green that proves
nothing.

`expectDialog` arms the answer to the **next** dialog, once only:

```json
[
  { "kind": "expectDialog", "response": "accept" },
  { "kind": "click", "target": { "primary": { "role": "button", "name": "Delete" } } }
]
```

The order is not negotiable. The dialog blocks the page from the click onwards:
there is no instant *after* the gesture where one could still answer.

With no policy armed, the driver dismisses — the previous behaviour, so that
existing resolutions do not change meaning. A policy armed that nobody consumed
becomes a step **warning**: the click succeeded but the expected dialog never
appeared, which almost always means the confirmation disappeared from the
application.

`expectDialog` exists for dialogs outside the page tree. On iOS an app alert
is in the tree, so it is clicked by label instead; see the iOS section.

## `select` targets the label, not the value

Playwright's `selectOption("std")` matches the option's **value** — a technical
detail the user never sees. An intent-based tool must target what is displayed:
the driver therefore tries the label first ("Standard delivery"), and falls back
to the value if no label matches.

The options are read in one go before choosing, rather than trying and catching
the error: a failed `selectOption` burns a full timeout — thirty seconds per
`select` on resolutions written by value.

A mobile driver will apply the same rule to its own native picker: what is
targeted is the label read on screen.

## Role mapping

This table decides whether portability is real. QAI's vocabulary is the
intersection of what the three platforms expose natively.

| QAI | Web (ARIA) | iOS (XCUIElementType) | Android |
|---|---|---|---|
| `button` | `button` | `.button` | `Button` |
| `link` | `link` | `.link` | `TextView` + `URLSpan` |
| `text` | text content | `.staticText` | `TextView` |
| `heading` | `heading` | `.staticText` + `header` trait | `AccessibilityHeading` |
| `image` | `img` | `.image`, `.icon` | `ImageView` |
| `textbox` | `textbox` | `.textField`, `.secureTextField`, `.textView` | `EditText` |
| `searchbox` | `searchbox` | `.searchField` | `SearchView` |
| `combobox` | `combobox` | `.pickerWheel` | `Spinner` |
| `checkbox` | `checkbox` | `.checkBox` | `CheckBox` |
| `radio` | `radio` | `.radioButton` | `RadioButton` |
| `switch` | `switch` | `.switch`, `.toggle` | `Switch` |
| `slider` | `slider` | `.slider` | `SeekBar` |
| `list` | `list` | `.table`, `.collectionView` | `RecyclerView` |
| `listitem` | `listitem` | `.cell` | direct child of the list |
| `table` / `row` / `cell` | same | — (a `.table` is a `list`) | `GridView` |
| `tab` / `tablist` | same | `.button` inside `.tabBar` / `.tabBar` | `TabLayout.Tab` |
| `dialog` | `dialog` | `.alert`, `.sheet` (action sheet) | `AlertDialog` |
| `menu` / `menuitem` | same | `.menu` / `.menuItem` | `Menu` / `MenuItem` |
| `progressbar` | `progressbar` | `.progressIndicator`, `.activityIndicator` | `ProgressBar` |
| `alert` | `alert` | — (an `.alert` is modal: `dialog`) | `Toast`, `Snackbar` |
| `group` | `group` | `.other`, and any type not listed | `ViewGroup` |

The accessible name follows the same principle: `aria-label` and accname
computation on the web, `accessibilityLabel` on iOS, `contentDescription` then
`text` on Android. The same scenario finds "Ajouter au panier" on all three.

Two mappings are imperfect: `link` has no native equivalent on mobile, and
`heading` exists on iOS only as a trait on a `staticText`. Not blocking,
because **portability lives in the scenario, not in the locator**: the intent
"open the cart" produces a `link` resolution on the web and a `button`
resolution on iOS, in two separate files. The vocabulary only needs to be
expressible on both sides, not identical.

## The honest mobile limit

Semantic resolution assumes the app under test is properly accessible. On the
web, that failure is visible and fixable. On mobile, an app without
`accessibilityLabel` or `contentDescription` degrades resolution to the
accessibility identifier, then to the vision fallback.

This is the real porting difficulty, and it is as much product as technical:
either help customers label their apps correctly — valuable in itself, as
accessibility regulation tightens — or accept a more expensive vision tier on
mobile. Decide before promising price parity between the two platforms.

## iOS driver — EXPERIMENTAL

`IosDriver` (`src/driver/ios/`) drives an iOS app through an
[Appium](https://appium.io) server running the XCUITest driver, over the W3C
WebDriver protocol. **Status: experimental — not yet validated on a device.**
It was written against the documented protocol and is tested against a fake
Appium server that checks every HTTP call; expect rough edges on a real app.

### Prerequisites

None of these is a QAI dependency — like a browser for the web driver:

- macOS with Xcode and an iOS simulator (or a provisioned device);
- Appium 2 or 3: `npm i -g appium`;
- the XCUITest driver, 4.17 or later: `appium driver install xcuitest`;
- a running server: `appium` (default `http://127.0.0.1:4723`);
- for deep links (`navigate` to a URL, a StateProvider `entry`): iOS 16.4+ and
  Xcode 14.3+, as `mobile: deepLink` requires.

```bash
qai run qa/ --platform ios --app com.example.app --device "iPhone 16"
qai resolve qa/login.qai.yaml --platform ios --app build/Acme.app --provider ./qa/provider.ts
```

Resolutions land in `.qai/resolutions/<id>.ios.json`, next to the web ones. A
resolution written for another platform is refused by `check` and `run`. One
device plays one journey at a time: `--workers` must be 1 (a `workers` value
from `qai.config.json` is brought down to 1). `--headed` is refused.

`qai resolve` on iOS is as experimental as the driver: the model is prompted
for the web and may propose a relative `navigate`, a `hover` or an
`expectDialog`; each is rejected before any gesture and the model retries. So is
a `urlContains` that only names the app (`com.example.app`): every location
starts with it, so it would be true on every screen. A step with no intent on
iOS (verification only) is resolved and replayed with no gesture, as on the web.

A journey with no step for iOS (`platforms: [web]`, or `only: [web]` on every
step) is skipped by `resolve`, `check` and `run`, with a line on stderr; it is
never reported as passed, and a selection left with no journey fails.
`runScenario` and `generateResolution` refuse it, and `runScenario` refuses a
resolution written for another platform, before any gesture.

### Session

`--app` is a bundle id (`appium:bundleId`, app already installed) or a path to
a `.app`, `.ipa` or zipped `.app` (`appium:app`, installed by Appium). Appium
reads that path **on the server host**: a relative path is resolved from the
current directory, and refused when `--appium-url` is not on this machine — pass
an absolute path on the server host, or a URL. After an install, the bundle id
is read from `mobile: activeAppInfo`; SpringBoard in the foreground is refused.
`--device` is a UDID (`appium:udid`) or a device name (`appium:deviceName`). The
session uses `platformName: iOS` and `appium:automationName: XCUITest`.
`dispose()` deletes the session and never throws on a session already gone.

### What is observed

`GET /session/:id/source` (the XCUITest XML page source) is parsed into the
normalized tree with the role table above, and:

- **name** — the accessibility label; for an empty text field, its
  placeholder; then the `name` attribute (identifier, else label);
- **testId** — the accessibility identifier, when it differs from the label.
  `fallback.accessibilityId` and `fallback.testId` both target it, and are
  counted like the primary locator: an identifier carried by several elements
  is ambiguous. `fallback.selector` is web-only and ignored;
- **heading** — a `StaticText` (or `Other`) carrying the `Header` trait;
- **state** — `visible` means **rendered**, as on the web: present with a
  non-empty frame, even below the fold. XCUITest's own `visible` attribute
  means on screen; it only decides whether `scrollTo` must scroll. `enabled`,
  switch value `1`/`0` as `checked`, the `Selected` trait as `selected`;
- **value** — never the value of a `SecureTextField`, as `type=password` on
  the web. A text field whose value equals its placeholder is empty;
- **location** — `<bundle id>/<on-screen navigation bar title>`, or the bundle
  id alone without a navigation bar. iOS has no URL: `urlContains` and
  `urlEquals` compare against this string as written — no base, so a relative
  value is never resolved;
- the keyboard and the status bar are left out: keys are pressed with `press`,
  and the clock would keep the screen from ever settling.

`resolve()` counts matches on the same tree `observe()` returns, so `nth` means
the same element to the model and to the driver.

### Actions

| Action | Protocol |
|---|---|
| `click` | find the node by XPath, then W3C Element Click |
| `fill` | find the node by XPath, then element click, clear, send keys |
| `select` | send the **displayed label** to the `PickerWheel` (XCTest `adjustToPickerWheelValue`) |
| `press` | send `Enter`/`Return`, `Tab`, `Backspace`/`Delete`, `Space` or one character to the active element |
| `swipe` | `mobile: swipe` with the direction |
| `scrollTo` | `mobile: scrollToElement` on the node when it is off screen, then a re-read: still off screen fails |
| `navigate` | an absolute URL opens as `mobile: deepLink` into the app; `.` and `/` relaunch it (`mobile: terminateApp` + `mobile: launchApp`); any other path — and `host:port` without a scheme — is refused, at `check` time too |
| `hover`, `upload`, `expectDialog` | refused — at planning, from `capabilities` (`hover: false`, `dialogs: false`) |

The XPath is the node's position in the source **plus its identity**
(`[@name="…"]`, else `[@label="…"]`): WebDriverAgent evaluates it on a fresh
snapshot, so a reloaded list cannot slip another row under the gesture. Nothing
is tapped by coordinates: Element Click lets XCTest compute a reachable point,
scroll to the element and fail if something — the keyboard — covers it.

**Alerts.** An app alert or action sheet (`UIAlertController`) is part of the
app's tree: it is observed as a `dialog`, its text is assertable, and it is
answered by clicking its button by label, in a step of its own. The driver
**never** calls `/alert/accept` or `/alert/dismiss`: WebDriverAgent picks the
button by position (the last button of an alert is "Cancel" when there are
three; a sheet is reported as an alert on iPhone), so no answer chosen blindly
is safe. While an app alert is open, a gesture aimed outside it is refused,
naming the alert. An alert **outside the app** (system permission prompt) is
not in the app's tree: the gesture that raised it, or the next one, fails
naming it — grant permissions before the run.

**`settle()`** polls the page source until two consecutive projected trees are
identical, or the timeout (5 s by default) runs out. iOS exposes no in-flight
requests: a tree that stops changing is the only observable sign of rest.

**`applyState()`** — there are no cookies or local storage to install:
non-empty `cookies` or `storage` are refused with an explicit error. `entry` is
opened as a deep link.

**Network and console** are not observed (no `drainObservations`).
`noFailedRequests` and `noConsoleErrors` therefore **fail** on iOS with "not
observable", are rejected during generation, and active `watchdogs` are refused
by the CLI — they would otherwise pass without having looked.

## Writing a new driver

Implement `Driver` from `src/driver/types.ts`, then pass the same test suite
as the web driver: `src/driver/web/PlaywrightWebDriver.test.ts` covers
normalization, geometry, exclusion of hidden nodes, states, resolution,
ambiguity, fallback, observable action, refused capability. It is the de facto
conformance test of the contract.
