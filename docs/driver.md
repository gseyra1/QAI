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
| `dialog` | `dialog` | `.alert`, `.sheet` | `AlertDialog` |
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
- the XCUITest driver: `appium driver install xcuitest`;
- a running server: `appium` (default `http://127.0.0.1:4723`).

```bash
qai run qa/ --platform ios --app com.example.app --device "iPhone 16"
qai resolve qa/login.qai.yaml --platform ios --app build/Acme.app --provider ./qa/provider.ts
```

Resolutions land in `.qai/resolutions/<id>.ios.json`, next to the web ones.
One device plays one journey at a time: `--workers` must be 1.

### Session

`--app` is a bundle id (`appium:bundleId`, app already installed) or a path to
a `.app`, `.ipa` or zipped `.app` (`appium:app`, installed by Appium; relative
paths resolve from the current directory). `--device` is a UDID
(`appium:udid`) or a device name (`appium:deviceName`). The session uses
`platformName: iOS` and `appium:automationName: XCUITest`. `dispose()` deletes
the session and never throws on a session already gone.

### What is observed

`GET /session/:id/source` (the XCUITest XML page source) is parsed into the
normalized tree with the role table above, and:

- **name** — the accessibility label; for an empty text field, its
  placeholder; then the `name` attribute (identifier, else label);
- **testId** — the accessibility identifier, when it differs from the label.
  It is the target of `fallback.accessibilityId`; `fallback.testId` and
  `fallback.selector` are web-only and ignored here;
- **heading** — a `StaticText` (or `Other`) carrying the `Header` trait;
- **state** — `visible`, `enabled`, switch value `1`/`0` as `checked`, the
  `Selected` trait as `selected`;
- **value** — never the value of a `SecureTextField`, as `type=password` on
  the web. A text field whose value equals its placeholder is empty;
- **location** — `<bundle id>/<visible navigation bar title>`, or the bundle id
  alone without a navigation bar. iOS has no URL: `urlContains` checks this;
- the keyboard and the status bar are left out: keys are pressed with `press`,
  and the clock would keep the screen from ever settling.

### Actions

| Action | Protocol |
|---|---|
| `click` | `mobile: tap` at the centre of the resolved node |
| `fill` | find the exact node by positional XPath, then element click, clear, send keys |
| `select` | send the **displayed label** to the `PickerWheel` (XCTest `adjustToPickerWheelValue`) |
| `press` | send `Enter`/`Return`, `Tab`, `Backspace`/`Delete`, `Space` or one character to the active element |
| `swipe` | `mobile: swipe` with the direction |
| `scrollTo` | `mobile: scroll` toward the target until it is visible, 8 scrolls at most |
| `navigate` | an absolute URL opens as `mobile: deepLink` into the app; `.` relaunches it (`mobile: terminateApp` + `mobile: activateApp`); a relative path is refused |
| `expectDialog` | after the next gesture, `/alert/accept` or `/alert/dismiss` (prompt text via `POST /alert/text`) |
| `hover`, `upload` | refused — `hover` at planning (`capabilities.hover: false`) |

`click` taps coordinates rather than an element: one documented command, and
the coordinates come from the very tree `resolve()` just validated.

**Dialogs.** After every gesture and while settling, `GET /alert/text` tells
whether an alert is open. An armed `expectDialog` answers it; with nothing
armed, it is **dismissed**, as on the web. Consequence: an alert's text cannot
be asserted on iOS today.

**`settle()`** polls the page source until two consecutive reads are
identical, or the timeout (5 s by default) runs out. iOS exposes no in-flight
requests: a tree that stops changing is the only observable sign of rest.

**`applyState()`** — there are no cookies or local storage to install:
non-empty `cookies` or `storage` are refused with an explicit error. `entry` is
opened as a deep link.

Network and console observation (`drainObservations`) is not available.

## Writing a new driver

Implement `Driver` from `src/driver/types.ts`, then pass the same test suite
as the web driver: `src/driver/web/PlaywrightWebDriver.test.ts` covers
normalization, geometry, exclusion of hidden nodes, states, resolution,
ambiguity, fallback, observable action, refused capability. It is the de facto
conformance test of the contract.
