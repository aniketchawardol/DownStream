# Design decisions

DownStream is a public instrument for reading government water data honestly. Its visual language comes
from Survey of India toposheets and field-test-kit reagents, not from software products. This file records
what was built, why, where it departs from BUILD_SPEC.md section 11, and a critique of the Phase 7 screenshots.

## Palette

Defined once as CSS custom properties in `web/src/styles/tokens.css`, overridden under
`@media (prefers-color-scheme: dark)` for "night survey". Emails use the same light values inline.

| Token | Light | Night | Role |
|---|---|---|---|
| `--page` (Limestone) | `#E7ECEA` | `#182022` | Page background. Cool mineral white, deliberately not cream |
| `--ink` (Basalt) | `#222A2D` | `#DCE3E0` | Text, outlines |
| `--ink-soft` | `#4A5458` | `#A9B4B0` | Secondary text |
| `--survey` (Survey blue) | `#1E5E8A` | `#7DB3D9` | Rivers, CPCB layer, links, buttons, focus rings |
| `--umber` (Contour umber) | `#6F5B3E` | `#B59A72` | WQMIS / groundwater layer |
| `--ok` (Indicator green) | `#2E7A57` fill, `#256848` text | `#4FAF80` fill, `#6FCB9C` text | Within limits |
| `--caution` (Reagent yellow) | `#D4A017` fill, `#7A5A00` text | `#E2B23A` fill, `#E8C25A` text | Above acceptable, below permissible; simulation band |
| `--danger` (Reagent red) | `#B1271C` | `#E2675B` fill, `#F08A7F` text | Above permissible, or outside a river limit |
| `--stale` + hatch | Basalt at 30% with a diagonal hatch | Night text at 28% | Stale or never tested |

Reagent yellow and the lighter green fail AA as text on Limestone, so each status has a separate darker
text colour. Fills keep the reagent colours.

Measured contrast (WCAG 2.x), all text pairs at least AA:

| Pair | Ratio |
|---|---|
| Basalt on Limestone | 12.2:1 |
| Soft text on Limestone | 6.5:1 |
| Survey blue on Limestone | 5.8:1 |
| Umber on Limestone | 5.4:1 |
| Green text / yellow text / red on Limestone | 5.6 / 5.3 / 5.5:1 |
| White on Survey blue (primary button) | 6.9:1 |
| Night text / soft text on night page | 12.7 / 7.8:1 |
| Night survey blue / umber on night page | 7.3 / 6.2:1 |
| Night green / yellow / red text on night page | 8.4 / 9.7 / 6.8:1 |
| Night page on night survey blue (primary button) | 7.3:1 |

## Type

- **Anek Latin** (variable weight and width, Ek Type), self-hosted from `@fontsource-variable/anek-latin`
  (`wdth.css`, which carries both axes). It's used for headings, place names, numbers, UI and the hero.
  The hero is set at `font-stretch: 78%` so the 48 px sentence fits a 420 px column.
  Place headings use 85%.
- **Source Serif 4**, self-hosted from `@fontsource-variable/source-serif-4`. It's used for body copy,
  explanations, verdicts and email.
- Scale (px): 12, 14, 16, 18, 21, 24, 36, 48, 60, as `--t12` … `--t60`. Body is 18/1.6 serif; UI is
  16/1.4 Anek.
- Every number uses `font-variant-numeric: tabular-nums`, including ledger cells, rulers, numerals and
  distances.
- Prose is capped at 68ch.

## Shape and depth

- Two radii only: `--r-data` 2 px (inputs, swatches, legend, table-like elements) and `--r-pill` 999 px
  (buttons, tags, the sheet handle).
- One shadow: the phone bottom sheet that floats over the map.
- Sections are separated by hairline rules, not cards. There is no grid of identical boxes anywhere.

## Map

- MapLibre GL JS with OpenFreeMap tiles. `web/scripts/build-style.mjs` fetches the Positron style from
  `MAP_STYLE_URL` and writes two recoloured copies, `web/public/map-style-light.json` and
  `-dark.json`. Both are committed, so builds work offline.
  - Land is Limestone.
  - Water bodies are Survey blue at 20%, blended to a solid colour.
  - Waterways are Survey blue at 70%, with `class=river` drawn heavier than streams and canals.
  - Roads are Basalt at 12–18%.
  - POIs, road shields and aeroways are hidden.
  - OpenFreeMap's glyph fonts are kept, and the attribution stays visible.
- **International and disputed boundary lines are not drawn.** OSM's de-facto lines differ from
  India's official boundaries, which matters for a public Indian site. State boundaries stay, as faint
  dashed lines.
- `cooperativeGestures` is on at every width, not just on phones. On desktop the map fills the viewport
  next to the reading column, so wheel-zoom would trap page scrolling to the sections below the fold.
  Ctrl or Cmd plus scroll zooms, and the +/− buttons stay.
- MapLibre is lazy-loaded after the hero has painted. The initial JS is 37 KB (13 KB gzip); MapLibre is a
  separate 292 KB gzip chunk.
  - On desktop it loads when the browser is idle.
  - On phones the first paint is a schematic instead: the same rings and district square, placed by
    latitude and longitude on the survey grid, with a schematic Ganga line through its main-stem
    stations and a few cities for orientation. It's labelled "Schematic, not to scale". The interactive
    map loads the moment the reader touches the map, presses "Open the interactive map", picks a place
    or sets a pin.
- **First paint is server-rendered.** In production Fastify writes the live hero sentence (shared logic
  in `packages/core/hero.js`) and, in simulation mode, the band into `index.html`, cached for 60 s.
  The first frame answers the question and nothing shifts when scripts arrive.
- **Lighthouse, mobile, production build:**

  | Category | Score |
  |---|---|
  | Performance | 95 (FCP 2.1 s, LCP 2.3 s, TBT 0 ms, CLS 0.07) |
  | Accessibility | 96, then fixed to a labelled `role="region"` map |
  | Best practices | 100 |
  | SEO | 100 |

  Before the schematic and the CSS ring animation, performance was 56: TBT 7.4 s, from per-frame GSAP
  tweens on about 250 SVG rings and MapLibre's 1 MB evaluated during load.

## Freshness rings (the one memorable thing)

Implemented as DOM SVG markers (236 markers, well under the ~1,500 limit) in `web/src/map/markers.js`.

| | River station | Panchayat |
|---|---|---|
| Shape | Circle | Rounded square |
| Ring | Survey blue; full under 1 hour, empty at 24 hours | Umber, two rings: outer = chemical test (full under 30 days, empty at 12 months); inner = bacteriological (empty at 6 months) |
| Fill | Status colour | Worst result in the latest testing round (samples within 30 days of the newest) |
| Glyph on the fill | ✓-shaped path (ok), bar (caution), "!" (danger) | Same |
| Stale | Dotted ring, hatched fill (no reading for 6 hours) | Dotted rings, hatched fill (no chemical test for 12 months, or never) |

- **Colour never stands alone.** Every status also has a glyph and ring style, plus words in the
  hover title, the list view and the panels.
- **Animation.** On first load each ring draws from empty to its value. It is a CSS transition on
  `stroke-dasharray`, 600 ms, delayed by up to 300 ms in proportion to distance from the map centre: one
  900 ms gesture with no per-frame JavaScript. A `rings-pending` class holds the rings at 0 until
  released. Panchayat rings,
  which only appear at zoom 8 and closer, draw once the first time they appear. All of it is skipped
  under `prefers-reduced-motion`.
- **Zoomed-out panchayats.** Bagalkote's 196 panchayats lie within about 120 km, so below zoom 8 they
  collapse into one neutral district marker that shows a count, "zoom in", and a ring for the newest
  test. It deliberately has **no status fill**: colouring a whole district by one panchayat's result
  would spread that result to its neighbours.
- **Simulated subjects** have dashed reagent-yellow outlines, never a status fill. Their labels appear
  from zoom 11.

## Layout

- **Desktop (900 px and up).**
  - A 420 px reading column on the left scrolls independently, with a sticky masthead.
  - The map fills the rest of the viewport.
  - Below the fold, full width: "How a tap sample becomes public", "Sources and method", "Freshness
    ledger".
  - Opening a place scrolls only the column, never the page, so the sticky simulation band can't cover
    the masthead.
- **Phones and narrow tablets.**
  - The map fills the screen behind a bottom sheet.
  - The sheet has three snap points: peek (132 px), half (top at 55% of the height, the default) and
    full. MapLibre camera padding keeps the map's centre in the visible part.
  - Drag the handle or masthead, or press the handle (a real button) to cycle.
  - The below-the-fold sections move inside the sheet.

## Components

- **Hero.** Computed live from data in `web/src/hero.js`, for example "The Ganga at Chausa was measured
  66 minutes ago. Taps in Uttur were last lab-tested 4 days ago."
  - The station is the nearest fresh one within 400 km of the viewer if a location is known, otherwise
    the freshest overall, preferring the Ganga when several share the latest hour.
  - The panchayat is the nearest tested one, or the most recently tested if no location is known.
  - Rivers come from a curated table (`packages/core/stations.js`) that names a river only where the
    station name or location leaves no doubt. Otherwise it reads "River water at Pratapgarh".
  - No word is highlighted.
- **Station panel.** Contents, in order:
  - the station number, the river and place, and CPCB's own long name;
  - "Reading from 13:00 IST, 66 minutes ago.";
  - a "this is river water" note;
  - 12 small multiples: label, a 36 px Anek numeral, a 48-hour sparkline with the Class C band shaded,
    and a status in words.

  Gaps longer than 2 hours break the line rather than inventing values. Floor values (CL 5, COD 5,
  TOC 1, nitrate 0.3, EC 1) are labelled "at the sensor's lowest reading". EC shows µS/cm with a note,
  because CPCB labels it mS/cm. BOD notes that it's a sensor estimate.
- **Lab report rulers.** One horizontal scale per parameter.
  - Shading marks the acceptable, permissible and danger zones, with tick marks at the printed limits.
  - The result is a reagent-coloured dot, with the value and unit at the right in tabular figures.
  - Bacteria use a two-state ruler (not detectable / detected).
  - The status line repeats the limits in words.
  - Above the rulers runs the date sequence: collected → reached the lab → analysed → report generated
    → first seen here. Each step shows the gap from the previous one, in days rather than hours when
    the report hasn't been read.
  - A "latest testing round" line explains why the marker colour can differ from the latest single
    sample.
  - Where the limits come from is always stated: this report, other WQMIS reports, or BIS.
- **Subscribe.**
  - Ways to set the pin:
    - click the map;
    - "Use my location";
    - place search, offered when location is refused;
    - "Get alerts near here" on any panel.
  - A 1–50 km slider redraws the radius circle live.
  - The four plain-word choices match the spec exactly.
  - The button reads "Send confirmation email". On success it shows "Confirmation sent to {email}. Open
    it to start alerts."
- **Keyboard path.**
  - The first Tab reaches the skip link, which goes to "Places on the map": a list of every marker,
    sorted by distance once a pin is set, with a filter for panchayats.
  - Choosing a row opens the panel and moves focus to it.
  - Close, "Get alerts near here", the form fields and submit follow in tab order.
  - Map markers are `aria-hidden`; the list is the accessible equivalent.
  - Focus rings are 2 px Survey blue.
- **Freshness ledger.** For each source: the last successful fetch, the newest data point (both as IST
  times plus "n minutes ago"), records in the last run, and a state: working, last attempt failed (with
  the error), or paused until a time after repeated failures. The masthead pill summarises CPCB in the
  spec's own wording: "River data couldn't be refreshed (CPCB didn't respond). Showing readings from
  14:00 IST."
- **How a tap sample becomes public.** Five steps, each with a median lag computed from lab reports the
  site has read. On desktop GSAP ScrollTrigger pins the section and lights one step at a time. On
  phones, or under reduced motion, all steps are shown statically.
- **Panel switches** use the View Transitions API where available.

## Copy rules applied

Sentence case throughout, and buttons say what happens. Every reading names its water: "river water at
this station, not tap water", or "laboratory tests of rural drinking-water sources". Nothing says water
"is safe". Verdicts read "Last lab test on {date}: all tested parameters within limits." Errors explain
what happened and what to do. There are no eyebrow labels in capitals, no "→", no middle dots, no emoji
and no gradients.

## Phase 7 screenshots and self-critique

The screenshots are in `docs/screenshots/`, produced by `docker compose --profile e2e run --rm e2e shots`
against the production build:

- `home-1440-light.png`, `home-1440-dark.png`, `home-390-light.png`, `home-390-dark.png`
- `station-1440-*`, `station-390-*`, `panchayat-1440-*`, `panchayat-390-*`
- `journey-1440-*`, `ledger-1440-*`

The keyboard walkthrough is automated in `scripts/e2e/run.mjs` ("keyboard only" checks).
`docs/screenshots/e2e-results.json` holds the last run.

**What works**

- The hero answers the five-second question with live ages, and nothing competes with it.
- The Ganga-basin stations read as a chain of rings along the blue river network. Violations ("!" on
  reagent red) are visible from the national view without colour being the only signal.
- Night survey keeps the toposheet feel and doesn't drift into black-with-neon.
- The rulers make "above acceptable but within permissible" legible at a glance, which a table of
  numbers doesn't.

**Problems found in earlier rounds, and fixed**

- Opening a place scrolled the whole page, so the sticky simulation band hid the masthead and the
  zoom-in button. Fixed by scrolling only the column.
- The map legend covered the Bagalkote marker. It moved to the bottom right over the Bay of Bengal, is
  collapsible, and starts collapsed on phones.
- Phone snap points were computed from a transformed box, so the map got about 140 px. Fixed. The map
  now fills the screen behind the sheet, with camera padding.
- WQMIS's conductivity unit ("micromhos per centimeter / microsiemens per centimeter") overflowed the
  column. It's now shown as µS/cm.
- Panchayat markers were red while the latest sample said "within the permissible limit". The panel
  now states the latest testing round and that the marker shows its worst result.
- Without a report, "within the hour" was claimed from date-only values. It's now "same day".

**Remaining weaknesses, accepted for now**

- At the national zoom, stations around Kanpur, Allahabad and Patna overlap. Markers shrink to 24 px
  below zoom 5.6, but clustering would be cleaner.
- At zoom 11, basemap village labels can sit under panchayat markers. Moving them would need
  label-collision work in the style.
- The journey section uses about half the width at 1440 px. The empty right side could carry the
  national dashboard figure.
- With no location, the hero names the most recently tested panchayat, which can be anywhere in scope.
  That's accurate, but less personal than "near you".
- On phones the hero is set at 34–48 px (`clamp`), not 48–60 px. At 360 px wide, 48 px leaves about
  10 characters a line and pushes the buttons below the first screen.

## Deviations from BUILD_SPEC.md, with reasons

| Spec | Built | Why |
|---|---|---|
| Hero 48–60 px | 48 px desktop, 34–48 px on phones | Line length on 360 px screens |
| `cooperativeGestures` on mobile | On at every width | Desktop map would otherwise trap scrolling to the below-the-fold sections |
| Panchayat fill = status | Fill = worst result in the latest testing round, explained in the panel | A panchayat has many sources; this is the honest summary of "now" |
| Markers for every panchayat at every zoom | Neutral district marker below zoom 8 | Avoids a 196-marker blob, and avoids colouring a district by one result |
| Geocoding with Nominatim, block-centroid fallback | OSM settlements via one Overpass request with transliteration-aware fuzzy matching, then Nominatim, then the block's position; Nominatim results cross-checked against OSM | Nominatim alone placed 33% of panchayats. The pipeline places 93% with a confidence score, and flags namesake disputes as approximate |
| Country boundaries | Not drawn | OSM de-facto lines differ from India's official boundaries |
