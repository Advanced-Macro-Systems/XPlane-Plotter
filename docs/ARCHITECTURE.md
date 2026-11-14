# Architecture

X-Plane Plotter is a static single-page app (Vite + React 19 + TypeScript + zustand + ECharts 6) hosted on GitHub
Pages. Everything runs in the browser: a dropped `Data.txt` is parsed in a Web Worker and never uploaded anywhere.

```
src/
  main.tsx              fonts + global CSS, theme and URL options (lib/), then <App/>
  App.tsx               the shell: header, the open tab's view (one lazy chunk per tab) or the landing page
  core/                 pure TypeScript, no React, unit-tested with Vitest (node)
    types.ts            the shared data model (Dataset, Channel, Workspace, ...)
    parse/              X-Plane Data.txt + CSV/TSV parsing; streaming parser shared by worker and parseText()
    dataset.ts          RawTable -> Dataset (channel ids, meanings, stats, time source, segments, signature)
    time.ts             time source choice, gap-collapsed elapsed time, segments, time axes, formatting
    channels/           what each header token means (see "Channel meanings"), data-set groups, recording guide
    analysis/           stats, polynomial fits, mode identification, formula language, derived channels, decimation
    export/             CSV, session JSON, MATLAB script generator, downloads
    demo/               synthetic demo flight in Data.txt format
  charts/               ECharts setup (tree-shaken), theme from CSS tokens, <EChart>, image export, number formats
    options/            pure option builders, one file per chart kind: overview (glance stack, ground track),
                        timePanel (one Time-history panel), timeStack (the stacked export figure), xy, modes
  store/                zustand app state + actions (app.ts), workspace defaults/sanitising (defaults.ts),
                        the demo's marked manoeuvres (demoWorkspace.ts)
  components/           shared view parts: ChannelPicker, ExportMenu, Segmented, Sparkline, channelGroups, view.css
  ui/                   generic primitives: Modal, Dropdown, ThemeSwitch, Toasts
  lib/                  theme choice (light / dark / device) and start-up URL options (?demo&tab=time&theme=dark)
  layout/               the shell (see "App shell"), shell-wide CSS (layout.css)
  views/                one folder per tab (see "Views")
  styles/               global.css (design tokens, light/dark), ui.css (primitives)
```

## Data model (core/types.ts)

- A **row** is one output frame (one line of Data.txt). Rows are 0-based.
- **Row ranges** are half-open `[start, end)`. Test points, the zoom range (`view`) and the drag selection are stored
  as row ranges, so they survive switching the time axis.
- Every `Channel.values` is a `Float64Array` of exactly `rowCount` values; missing cells are `NaN`.
- **Channel ids** are the header token (`_Vind,_kias`), with `#2`, `#3`... for repeated tokens (X-Plane repeats
  `elev1,__deg`, `wing1,_lift`, ...), and `fx:<slug>` for formula channels. Ids are stable across reloads.
- **Elapsed time** (`Dataset.elapsed`, seconds) is built from the best time column (sim time preferred because the
  physics integrates in sim time) with resets/gaps collapsed; the discontinuities become **segments**.
- The **workspace** (panels, test points, groups, formulas, plot settings) is saved per file **signature** in
  localStorage, so reopening the same Data.txt restores it. Session JSON export/import moves it between machines.

## Channel meanings (core/channels)

- `dictionary.ts` (930 entries: token, occurrence, Data Output row, label, short, unit, quantity, sign, notes,
  confidence) and `groupRows.ts` (the 173 X-Plane 12 Data Output rows in display order, then legacy rows) were built
  once from research notes kept outside the repo and are edited by hand. `overrides.ts` holds the curated labels,
  shorts (≤ 16 characters, unique in a row) and pitfalls; `entries.ts` builds the lookup tables once, on first use.
- `describeHeader(headers)` gives every column its meaning at once (`dataset.ts` calls it once per file). X-Plane
  writes each ticked row as one contiguous block of tokens, so the header is read as a sequence of row blocks: a
  token several rows write (`_side,___lb` for aero / gear / engine forces, `____P,deg/s` for body rates and the motion
  platform, `_wind,__dir` for METAR layers and local wind) takes the meaning of its block, not of its occurrence
  count. Engines, tanks and gears beyond the dictionary are numbered by pattern (`N1__3,_pcnt` -> "N1 eng 3"), and
  shorts that would collide get the row's tag ("Wind dir (local)").
- `describeChannel(token, occurrence)` answers for one token alone; unknown tokens and CSV headers ("Airspeed (kt)")
  get a readable fallback from `units.ts` with `known: false`. `quantity` is a dimension only (kt and fpm are both
  speed): views also compare units before sharing an axis.
- `groups.ts` adds "Formulas" and "Other" to the rows; pickers and the Channels table follow its order.
  `guide.ts` (`recordingSteps`, `loggingGuide`) is the single source of the recording help on the landing page and in
  the help dialog; every row it names is checked against the groups by its test.

## State (store/app.ts)

Views read state with `useApp(selector)`, `useActiveDataset()`, `useWorkspace()`, and change it ONLY through the
exported actions (`openFiles`, `setView`, `setSelection`, `addPoint`, `setXY`, `saveDerived`, ...). Never mutate
datasets or workspaces in place: actions replace objects so React and the persistence subscriber see changes.

Views do not import each other's components; they talk through the store. `setTab` switches tabs, `setView` /
`setSelection` carry the zoom range and selection (shown as chips in the tab bar), `setModes({ source })` hands a
window to Dynamic modes, and `openChannels({ group } | { constant })` opens the Channels tab filtered (the request
sits in `channelsRequest` until the Channels view takes it). Pure helpers may be shared across view folders (e.g.
`views/points/pointsModel`: Time history names a new test point with `suggestPointName`, like Test points does).

## App shell (src/layout)

- `App.tsx` renders `Header` (file switcher, Open file, help, settings, theme) with `TabBar`, then the open tab's
  view inside a `ViewBoundary`, or `Landing` when no file is open. Each view is a lazy chunk, prefetched when the
  browser is idle, so the start page paints without ECharts and a view that fails to load only breaks its own tab
  (a stale chunk after a redeploy offers "Reload the page").
- There is one hidden `<input type="file" data-testid="file-input">`; every Open file action goes through
  `filePicker.openFilePicker()`. `fileActions.ts` routes picked or dropped files (`DropOverlay`): logs open as
  datasets, session `.json` files load onto the open log. Whole-file exports (MATLAB, CSV, session) live there too.
- `useShortcuts` (rules in `shellModel.ts`): 1–6 switch tabs, Ctrl/Cmd+O opens a file, ? opens help; never while
  typing. `LoadingOverlay` shows the parse progress (`data-testid="loading-overlay"` while loading).
- `shellModel.ts` holds the shell's pure logic (tab order, shortcut rules, short texts) and is unit-tested.

## Views (src/views)

One folder per tab, each with its own CSS file and class prefix. React components stay thin; the logic is in pure,
unit-tested modules next to them:

- `overview/` (`ov-`): file facts, data-quality notes, "Flight at a glance" (`GlanceCharts`) and the ground track
  (`GroundTrack`), the channel groups, next steps. Logic: `overviewModel.ts`.
- `time/` (`tv-`): stacked panels, one ECharts chart each (`TimePanelCard`), channel list and presets
  (`TimeSidebar`, `presets.ts`), Zoom / Select modes, the selection bar and Save test point dialog.
  `timeController.ts` keeps the panels in step by time value (zoom mirrored once per frame, one crosshair and
  tooltip instant for all); `timeMath.ts` holds the axis and lane maths, `exportTime.ts` the figure / CSV exports.
- `xy/` (`xy-`): presets, axes, data source, style and fits (`XYSidebar`), the plot with its own nearest-point hover
  (`XYChart`, `xyHover.ts`), fit and mean tables (`XYResults`, `xyTables.ts`). `xyModel.ts` builds samples, means and
  fits and focuses the axes past absurd outliers; `xyControls.ts` holds the control rules.
- `points/` (`pt-`): the test-point table (mean ± σ, drift flags, sorting, pinned columns), groups, add-from-selection
  and session import dialogs. Logic: `pointsModel.ts`.
- `modes/` (`md-`): quick picks, channel and window (selection, zoom range or test point), the fit with residuals and
  results. Logic: `modesModel.ts` over `core/analysis/modes.ts`.
- `channels/` (`ch-`): every channel with statistics, flags and a sparkline (`components/Sparkline`), search, filters
  and sort (`channelsTable.ts`), row actions, and the formula editor (`FormulaDialog`, checked by `formulaCheck.ts`).

## Charts

- Import ECharts only from `charts/echarts.ts` (tree-shaken registration). Option builders live in `charts/options/`
  and take the theme as input, so the same builder serves the screen and the export.
- Colours come from CSS tokens through `charts/theme.ts` (`useChartTheme()`); exports use the fixed `paper` theme.
- **Categorical colours**: 8 validated slots in fixed order (`--series-1..8`). A chart never shows more than 8
  series; colour follows the entity (a channel keeps its slot when others are removed); a test-point group's colour
  is its `slot`. Scatter plots with more than 3 colour classes add a second encoding (marker shape).
- **No dual y-axes.** Channels with different units go in separate stacked panels (Time history) — panels share the
  x-axis, zoom and crosshair.
- **Linked charts.** With `<EChart group>` (echarts.connect) each linked chart snaps its crosshair and tooltip to its
  own data, so charts holding differently decimated lines can lose the crosshair or show slightly different instants.
  Time history therefore links its panels itself, by time value (`timeController.ts`); the Overview's glance stack
  keeps `group` but reads every line at the hovered time from its own data (`valueAt`). An axis tooltip's
  `axisValue` is the nearest sample's x; for an exact time use the `updateAxisPointer` event.
- Solid hairline grid, 1.5–2 px lines, markers ≥ 8 px for means, crosshair + tooltip listing every series at the
  hovered x. Tooltip HTML must escape channel names (`charts/format.ts escapeHtml`): headers are untrusted input.
- Every chart has a table view somewhere (Channels table, Test points table, fit results).

## UI conventions (after the Bristol FSAI Board look)

- Tokens in `styles/global.css`; light/dark via `<html data-theme>`; Geist / Geist Mono. Each theme has its own
  identity, not one look inverted. Light ("daylight paper"): white cards on a cool-grey canvas, navy ink, Bristol red
  only as a solid fill (primary buttons, the open tab's underline, the logo). Dark ("night cockpit"): navy-black
  panels, cyan accent, amber caution, green OK, red errors only, a magenta time-history selection. Toggles that are
  on (`aria-pressed`) use the info tint (`--info-soft` / `--info-text`: blue in light, cyan in dark); a segmented
  control's choice is `--segment-on` (a raised white pill in light, lit cyan in dark). Text on a solid `--accent` or
  `--info` uses `--text-on-accent` / `--text-on-info`. No decorative gradients, glows or red washes.
- Components: `.btn` (`-primary`, `-ghost`, `-outline`, `-sm`, `-icon`), `.segmented`, `.input`, `.select`,
  `.chip` + `.slot-N`, `.badge`, `.card`, `.callout`, `.table` in a `.table-wrap`, `.eyebrow` (mono uppercase labels),
  `Modal`, `Dropdown`, `.menu-item`. Icons: `@primer/octicons-react`. Shared view layout in `components/view.css`.
- Each view keeps its own CSS file with a class prefix (`tv-` time view, `xy-`, `pt-` points, `md-` modes,
  `ch-` channels, `ov-` overview, `sh-` shell) to avoid collisions.
- Text from files (headers, names) is rendered as React text, never `dangerouslySetInnerHTML`.
- Layout must work from 1280 px desktops down to tablets; phones get a usable single-column layout.

## Testing

- `npm test` runs Vitest on `src/**/*.test.ts` (pure modules only, node environment).
- Real-file tests are opt-in: set `XPP_REAL_FILE=/path/to/Data.txt` to parse a real X-Plane log in the parser
  tests. Never commit flight logs (`.gitignore` blocks `samples/` and `Data*.txt`), nor numbers measured in them:
  fixtures and examples use synthetic values.
- `npm run e2e` (scripts/e2e.mjs, after `npm run build`) drives the built app in a local Chrome/Edge with
  playwright-core: landing, every tab with the demo in light and dark, a dragged selection saved as a test point,
  optionally a real log (`--file`), a tablet width; screenshots go to `test-results/`. It fails on any console error.
  `node scripts/smoke.mjs <tab>` screenshots one tab from the dev server while working on it.
- Stable `data-testid`s the e2e relies on: `landing`, `demo-button`, `file-input`, `loading-overlay`, `tab-<id>`,
  `view-<id>`, `time-mode-select`, `time-plot-area`, `selection-bar`, `save-point-button`, `save-point-confirm`,
  `points-row`.
- CI (GitHub Actions) runs lint, tests and the build before deploying to Pages.
