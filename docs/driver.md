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

## Role mapping

This table decides whether portability is real. QAI's vocabulary is the
intersection of what the three platforms expose natively.

| QAI | Web (ARIA) | iOS (XCUIElementType) | Android |
|---|---|---|---|
| `button` | `button` | `.button` | `Button` |
| `link` | `link` | `.link` | `TextView` + `URLSpan` |
| `text` | text content | `.staticText` | `TextView` |
| `heading` | `heading` | `.staticText` + `header` trait | `AccessibilityHeading` |
| `image` | `img` | `.image` | `ImageView` |
| `textbox` | `textbox` | `.textField` | `EditText` |
| `searchbox` | `searchbox` | `.searchField` | `SearchView` |
| `combobox` | `combobox` | `.pickerWheel` | `Spinner` |
| `checkbox` | `checkbox` | `.checkBox` | `CheckBox` |
| `radio` | `radio` | `.radioButton` | `RadioButton` |
| `switch` | `switch` | `.switch` | `Switch` |
| `slider` | `slider` | `.slider` | `SeekBar` |
| `list` | `list` | `.table`, `.collectionView` | `RecyclerView` |
| `listitem` | `listitem` | `.cell` | direct child of the list |
| `table` / `row` / `cell` | same | `.table` / `.cell` / `.staticText` | `GridView` |
| `tab` / `tablist` | same | `.button` inside `.tabBar` / `.tabBar` | `TabLayout.Tab` |
| `dialog` | `dialog` | `.alert`, `.sheet` | `AlertDialog` |
| `menu` / `menuitem` | same | `.menu` / `.menuItem` | `Menu` / `MenuItem` |
| `progressbar` | `progressbar` | `.progressIndicator` | `ProgressBar` |
| `alert` | `alert` | `.alert` | `Toast`, `Snackbar` |
| `group` | `group` | `.other` | `ViewGroup` |

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

## Writing a new driver

Implement `Driver` from `src/driver/types.ts`, then pass the same test suite
as the web driver: `src/driver/web/PlaywrightWebDriver.test.ts` covers
normalization, geometry, exclusion of hidden nodes, states, resolution,
ambiguity, fallback, observable action, refused capability. It is the de facto
conformance test of the contract.
