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
    buildDataset.ts     RawTable -> Dataset (channel ids, meanings, stats, time source, segments, signature);
                        loaded on demand with the channel dictionary (see "App shell")
    dataset.ts          channelById, computeStats, the signature hash: the light helpers every part uses
    channelStats.ts     computeStats, import-free so the parser worker sends each column's stats with it
    time.ts             time source choice, gap-collapsed elapsed time, segments, time axes, formatting
    channels/           what each header token means (see "Channel meanings"), data-set groups, recording guide
    analysis/           stats (window stats unwrap headings across north), polynomial fits, mode identification,
                        formula language, derived channels, decimation, range and endurance, steady-window search
                        (steady.ts)
    checklists/         test-validity checklists (see "Test validity checklists"): shared types, citations, helpers,
                        the dynamic, static-stability and performance checklists, CSV rows
    export/             CSV, session JSON, MATLAB script generator (its xppStats unwraps the same headings),
                        downloads
    slots.ts            colour slots of a channel list (a panel, the X–Y Y channels): colour follows the channel
    demo/               synthetic demo flight in Data.txt format
  charts/               ECharts setup (tree-shaken), theme from CSS tokens, <EChart>, image export, number formats,
                        text widths as drawn (textWidth.ts, for labels laid out before ECharts draws them)
    options/            pure option builders, one file per chart kind: overview (glance stack, ground track),
                        timePanel (one Time-history panel), timeStack (the stacked export figure: the test-point
                        names are measured as drawn in the browser, estimated in tests), xy, modes
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
  Everything read back is untrusted (any page on the origin can write localStorage; sessions come from other people):
  the recent-file list keeps only well-formed entries (`readRecent`), a saved workspace is restored only when it is a
  version-1 object, its formulas pass `sanitizeDerived` before they are evaluated, and the rest goes through
  `sanitizeWorkspace` (anything unreadable opens the file fresh, with a toast). `parseSession` caps a session at
  `SESSION_LIMITS` (2,000 points, 200 groups, 500 formulas, 100 panels) so an import never freezes the page. When the
  browser refuses a save (storage full or blocked), the store first drops saved workspaces of files no longer in the
  recent list, then sets `saveFailed` and says once, with a "Save session" action.

## Channel meanings (core/channels)

- `dictionary.ts` (930 entries: token, occurrence, Data Output row, label, short, unit, quantity, sign, notes,
  confidence) and `groupRows.ts` (the 173 X-Plane 12 Data Output rows in display order, then legacy rows) were built
  once from research notes kept outside the repo and are edited by hand. `overrides.ts` holds the curated labels,
  shorts (≤ 16 characters, unique in a row) and pitfalls; `entries.ts` builds the lookup tables once, on first use.
- `describeHeader(headers)` gives every column its meaning at once (`buildDataset.ts` calls it once per file). X-Plane
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
sits in `channelsRequest` until the Channels view takes it). `openPointsTool('steady' | 'times')` opens Find steady
points or Add points from times over whichever tab asked (Test points, Time history, the X–Y range and endurance
note): the request sits in `pointsTool`, belongs to its file (it closes when another file becomes active), and the
shell's `PointsToolHost` lazy-loads `views/points/PointsTools` to show it. Pure helpers may be shared across view folders (e.g.
`views/points/pointsModel`: Time history names a new test point with `suggestPointName`, like Test points does).

## App shell (src/layout)

- `App.tsx` renders `Header` (file switcher, Open file, help, settings, theme) with `TabBar`, then the open tab's
  view inside a `ViewBoundary`, or `Landing` when no file is open. Each view is a lazy chunk, prefetched when the
  browser is idle, so the start page paints without ECharts and a view that fails to load only breaks its own tab
  (a stale chunk after a redeploy offers "Reload the page").
- The start page loads only `index` (the shell), `react` and `app-core` (store, parsing, demo, formulas, sessions,
  exports: the modules it shares with the tabs; `vite.config.ts` names the chunks with code-splitting groups). The
  channel dictionary (`channel-dictionary`, about 200 kB) is not on its critical path: only `core/buildDataset.ts`
  and the tabs read it. The store loads the builder with `loadDatasetBuilder()` (a dynamic import, started when a
  file or the demo opens, in parallel with reading it), and `main.tsx` asks for it before React draws the start
  page: it downloads while the page is drawn, when the network is otherwise idle, so it is normally there before
  anyone opens a file, even the demo clicked the moment the page appears. Not a `<link rel="prefetch">` in
  `index.html`: that starts sooner but shares the connection with the page's own scripts, and on slow links it
  delayed the start page (by about 0.1 s at 4 Mbit/s and 0.25 s at 1.6 Mbit/s). Code on the start page's path
  imports the light channel modules (`channels/title`, `guide`, `groups`, `alias`), never the `core/channels` barrel.
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
  and session import dialogs, and the two "add several points" dialogs the shell shows (`PointsTools`): Find steady
  points (`FindSteadyDialog`) and Add points from times (`AddTimesDialog`). Logic: `pointsModel.ts`, `steadyModel.ts`
  (their preview rows, and which rows start unticked and why: far off the speed listed, sharing rows with an earlier
  line, scattered, or without a speed when the others list one), `timesTable.ts` (reading a pasted table, a window's
  rows on a time axis, scoring each time axis by how many windows' mean speeds agree with the speeds listed),
  `pointSets.ts` (names, the target group, the one workspace change that adds a set and its undo; a new group joins an
  X–Y group filter so the points are plotted).

**Reading pasted times.** `parseTimesTable` splits a line at tabs or pipes, keeping empty cells so a blank spreadsheet
cell keeps its column (a Markdown row's outer pipes add none), else at commas; a label in front ("Point 1:", "3)") and
numbers glued to letters ("t1") are not times. A header names the time (time, start, end, elapsed, t1…) and speed
columns; without one, the lines with a window and one number say whether the time or the speed comes first. A number
alone is a time unless it stands where the speed goes: after words ("(not recorded) 140", "n/a | 140") or blank time
cells. `matchTimeBases` ranks the time axes by how many listed speeds agree within `MATCH_LIMIT` (windows outside the
log on an axis are counted apart), and `clockVerdict` confirms the best when at least `MATCH_SHARE` (75 %) of those
inside agree, naming the lines that do not. `windowRows` gives no rows for a window that holds no sample (outside the
log, or in a gap of that axis).
- `modes/` (`md-`): quick picks, channel and window (selection, zoom range or test point), the fit with residuals and
  results. Logic: `modesModel.ts` over `core/analysis/modes.ts`.
- `channels/` (`ch-`): every channel with statistics, flags and a sparkline (`components/Sparkline`), search, filters
  and sort (`channelsTable.ts`), row actions, and the formula editor (`FormulaDialog`, checked by `formulaCheck.ts`).

**Steady points.** `core/analysis/steady.ts` finds steady, level windows in about one pass per segment: prefix sums
give any window's mean, scatter and least-squares trend in O(1); a running window (±5 s for the 20 s default) marks
the rows not in a manoeuvre; each run of such rows (dips shorter than the running window bridged) is cut into its
longest windows that pass as a whole — the speed's 2σ about its trend and its trend × duration within the tolerance
(± 2 kt by default, in the speed channel's unit), the mean vertical speed within ± 100 fpm and its σ within twice that
(the altitude's drift per minute when there is no VVI), the mean bank within ± 5° and its σ within 40 % of that (a
dutch roll swings it), at least 20 s, faster than 40 kt — longest first. One two-pointer sweep of the run records
where its end stood for each start; each cut's own sweep follows it only until the two meet, so a long run cut into
hundreds of windows costs about one sweep. Each window is then trimmed to the stable core of its hold: its ends go
while the ±1 s smoothed speed is more than a quarter of the tolerance off the window's own trend line (the end of a
deceleration goes, a steady drift stays); and when the file records the power setting (engine 1's throttle lever, else
its thrust, power, torque or N1, or a CSV column named so) it is cut to its longest stretch where that stays within
± 3 % of its level (smoothed over ±1 s, the samples within twice that), a second short of a power change at its end:
the speed lags the throttle by seconds, so the speed alone keeps the throttle still being set and already pulled for
the next point. Windows of one run are one hold unless the speed steps by at least the tolerance between their trend
lines (the steadiest of a hold's windows stays), so holds a few knots apart stay apart; two windows of different runs
close together are merged only when the whole stretch passes, power included. Windows never cross
`Dataset.segments`. The speed is KIAS, else KEAS, KTAS or any airspeed (`airspeedChannels`; a unit-less "KIAS"
column is taken as knots, `speedUnit`); in a CSV the vertical speed, altitude and bank are found by unit and name
(`steadyChannels`), and without a vertical speed or altitude the dialog says level flight is not checked. The dialog
searches again 250 ms after typing pauses. Overlaps with saved points are left to the dialog, which skips them.

**Range and endurance (X–Y).** `core/analysis/rangeEndurance.ts` holds the maths: the power (A·V³ + B/V) and drag
(A·V² + B/V²) models of the parabolic polar, linear least squares on scaled columns, with V_E and V_R in closed form
(V_R/V_E = 3^¼), and the same two points for a polynomial by a dense scan of the fitted speeds ± half their span refined
by bisection on f′ and V·f′ − f. A physical fit gives no speeds unless R² > 0 and A and B are each at least two
standard errors above zero (`physicalProblem`), and with the test-point source but no test points yet (a preset on a
fresh log plots every row) `XYView` holds every point back with `NEEDS_TEST_POINTS`. `XYConfig.fit` takes
'power-model' / 'drag-model'; `rangeEndurance` and `axesFromZero` are optional flags (absent = off, so older sessions
read unchanged; the markers also need a fit). `views/xy/xyRange.ts` gives each fit its result, the label texts and the
construction colours (`constructionSlots`: aqua and orange, validated with the data's blue; both in ink, with a
dash-dot V_R guide, when the data use either colour, since no fourth slot passes beside them).
`charts/options/xyConstructions.ts` draws the guides, the origin tangent, opaque markers and labels. Each label is
placed for the plotting area as drawn (the screen measures its size and zoom window after each render,
`measureLabelArea`; an exported figure estimates its size and keeps its zoom) where it covers the fewest data, on one
line, with "(extrapolated)" on a second line or short ("V_E = 72 kt"), and kept inside the grid, since ECharts does not
clip series labels. `xyAxes.ts` sets the axis ranges the constructions need (round ends, ticks on whole steps). The
MATLAB export repeats the same procedure (`xppFitCurve`, `xppRangeEndurance`, `xppDrawRangeEndurance`, colours from
`xy.reSlot` / `xy.reInk` decided at run time) and writes `out/range_endurance.txt`; its numbers match the app's to
rounding. The X–Y presets may create a formula channel on demand (total engine power, total thrust) through
`saveDerived`.

## Test validity checklists (core/checklists)

Three pure checklists judge whether a test was flown the way the course's sources ask (the lectures, Cook, NATO
RTO-AG-300 Vol. 14, the brief): `dynamic.ts` (a Dynamic modes window: trim window T before the detected input I, the
response R), `staticStability.ts` (the trim points behind a pitch-control-against-C_L plot) and `performance.ts` (the
steady level points behind a range-and-endurance fit). Each returns `Check`s (`types.ts`): `status` pass / warn / fail /
not-checkable / not-settled / info, `severity` (critical, analysis, advisory, info, open), the measured value, the
criterion, a one-line hint, the "Why", short citations (`cite.ts` formats the registry's keys: "NATO 13-10" ->
"NATO AG-300 v14 p.13-10"; a "not checkable" line names the Data Output row from `groupRows`, starred when its index is
not confirmed), a `judgement` flag (at least one limit is engineering judgement or an app default: no published source
gives it) and `sourced` (the numbers a source does give, with the page; shown as "From the sources" and exported in a
`sourced` column). `result()` caps an advisory check at warn: advisory checks never fail and never change a point's place
or the verdict. Questions the sources do not settle are
`OpenItem`s (static N1–N4, performance U1–U7), never pass or fail. The set checklists give each point a verdict (Use,
Correct, Plot separately (a valid point of another configuration, left out of this fit), Retest, Cannot confirm, Left
out (by the user)) and the set one in NATO Table 29-I's words; a point near the stall stays in the fit with a note (no
source removes such points). The used points U are
what the X–Y fit draws when "Fit the used points only" is ticked. A shared id (`time-base`, `sample-rate`,
`throttle-fixed`, `trim-fixed`, `configuration-constant`, `weather`, `envelope`, `autopilot-record`, ...) computes the
same thing in every checklist through `helpers.ts` (power steadiness smoothed inside the window only, who flew pitch:
the surface follows a moving servo with R² ≥ 0.9 while the stick is still, settling after the last power change, ...);
only the thresholds are each test's (the dynamic checklist's are overridable by name, `CHECK_THRESHOLDS`; the static
ones are documented in `TRIM_CHECK_THRESHOLDS`, each tagged with its source or EJ). `recut.ts` finds a point's longest
stretch still in its own checklist's throttle-fixed bands (performance: the levers and the thrust; static, which judges
the setting: the levers and the throttle reaching the engines, N1 or the force only without them; on request the trim),
for "Re-cut … flagged points": Find steady points accepts the power within ± 3 %, so
its windows can start while the throttle is still being trimmed; the set verdicts count the same points
(`recutFailing`, `recutCounts`) and say "Fix the analysis — re-cut …" when that alone could leave enough usable points.
The dynamic checklist judges the autopilot on its own spans without the ±30 s widening the set checklists use: R and the
input to R's end (whole and every 2 s) and, without an input, the look-back decide a fail; the trim window T before the
input only warns. An autopilot that took over after the input is found on the input's own axis. Its input search looks
past the look-back, back to the last power, configuration or trim change; an input found there only warns. A rejected
fit or a window that can be widened is "Fix the analysis", not a retest.
`registry.ts` lists every check;
`export.ts` writes the rows (CSV / TSV, formula-like cells defused). Tests use synthetic logs only (`fixtures.ts`).
Settings live on the workspace (`trimCheck`, `perfCheck`, `checklist.kind`) and in `ModesConfig.check`, not in
`XYConfig` (applying an X–Y preset replaces it); `sanitizeWorkspace` keeps only valid values and sessions carry them.
Views: `views/points/ChecklistPanel` (the Test points panel; model `checklistModel.ts`: the points of the X–Y group
filter, the plotted channels or the preset's), `views/modes/ModesChecklist` (`modeChecksModel.ts`) and the X–Y summary
(`XYChecklistSummary`, "Open checklist" calls `openChecklist`). The MATLAB export writes the same rows to
`out/test_checks.csv` (`checklistExport.ts` runs the Modes fit for it), as the app computed them; one tab's script
writes `out/test_checks_xy.csv` or `out/test_checks_modes.csv` instead (`checksFileName`), so neither overwrites the other.

## Charts

- Import ECharts only from `charts/echarts.ts` (tree-shaken registration). Option builders live in `charts/options/`
  and take the theme as input, so the same builder serves the screen and the export.
- Colours come from CSS tokens through `charts/theme.ts` (`useChartTheme()`); exports use the fixed `paper` theme.
- **Categorical colours**: 8 validated slots in fixed order (`--series-1..8`). A chart never shows more than 8
  series; colour follows the entity. A channel's slot is stored next to it (`PanelConfig.slots`, `XYConfig.ySlots`,
  parallel to the ids; `core/slots.ts`): it keeps it while it stays in its panel or in the X–Y Y list, a channel
  added takes the lowest slot free there (`updatePanel`, `setPanels`, `setXY` and `pickChannel` assign them;
  presets start at 0, 1, 2 ...), and `sanitizeWorkspace` re-derives missing, invalid or repeated slots
  deterministically. Every renderer reads the stored slot: panel lines and chips, the time-history figure, the X–Y
  series, means, fits, legend and Y chips, and the MATLAB script (`panelSlot`, `xy.ySlot`). A test-point group's
  colour is its `slot`, and a file has at most `MAX_GROUPS` (8) groups (`addGroup` refuses a 9th). Scatter plots
  with more than 3 colour classes add a second encoding (marker shape, also by slot).
- **No dual y-axes.** Channels with different units go in separate stacked panels (Time history) — panels share the
  x-axis, zoom and crosshair.
- **Linked charts.** With `<EChart group>` (echarts.connect) each linked chart snaps its crosshair and tooltip to its
  own data, so charts holding differently decimated lines can lose the crosshair or show slightly different instants.
  Time history therefore links its panels itself, by time value (`timeController.ts`). The Overview's glance stack
  keeps `group`, but its lines stay out of the axis tooltip: an invisible series 0 (`HOVER_SERIES_ID`) holds the same
  evenly spaced instants in every chart of the stack, so all of them snap to one instant (and a linked chart finds
  the hovered sample by series and data index), and the tooltip reads every line at that time (`valueAt`). An axis
  tooltip's `axisValue` is the nearest sample's x; for an exact time use the `updateAxisPointer` event.
- The crosshair (global `axisPointer` in `baseOption`) draws on its own canvas layer (`zlevel: 1`) and never
  highlights samples (`triggerEmphasis: false`), so hovering repaints that layer only, not every linked chart's lines.
- Solid hairline grid, 1.5–2 px lines, markers ≥ 8 px for means, crosshair + tooltip listing every series at the
  hovered x. Tooltip HTML must escape channel names (`charts/format.ts escapeHtml`): headers are untrusted input.
- Every chart has a table view somewhere (Channels table, Test points table, fit results).

## UI conventions (after the Bristol FSAI Board look)

- Tokens in `styles/global.css`; light/dark via `<html data-theme>`; Geist / Geist Mono. Each theme has its own
  identity, not one look inverted. Light ("daylight paper"): white cards on a cool-grey canvas, navy ink, Bristol red
  only as a solid fill (primary buttons, the open tab's underline, the logo). Dark ("night cockpit"): navy-black
  panels, cyan accent, amber caution, green OK, red errors only, a magenta time-history selection. Toggles that are
  on (`aria-pressed`) use the info tint (`--info-soft` / `--info-text`: blue in light, cyan in dark); a segmented
  control's choice is `--segment-on` (a raised white pill in light, lit cyan in dark); a disabled one
  (`<Segmented disabled>`, e.g. X–Y "Fit through" without a fit) still shows its choice, as `--segment-off` (a flat
  neutral pill with muted text, never the "on" colours), and its other options are muted. Text on a solid `--accent` or
  `--info` uses `--text-on-accent` / `--text-on-info`. No decorative gradients, glows or red washes.
- Components: `.btn` (`-primary`, `-ghost`, `-outline`, `-sm`, `-icon`), `.segmented`, `.input`, `.select`,
  `.chip` + `.slot-N`, `.badge`, `.card`, `.callout`, `.table` in a `.table-wrap`, `.eyebrow` (mono uppercase labels),
  `Modal`, `Dropdown`, `.menu-item`. Icons: `@primer/octicons-react`. Shared view layout in `components/view.css`.
- Each view keeps its own CSS file with a class prefix (`tv-` time view, `xy-`, `pt-` points, `md-` modes,
  `ch-` channels, `ov-` overview, `sh-` shell) to avoid collisions.
- Text from files (headers, names) is rendered as React text, never `dangerouslySetInnerHTML`.
- Layout must work from 1280 px desktops down to tablets; phones get a usable single-column layout.
- Focus never drops to `<body>`: `Modal` gives focus back to the control that opened it, a `Dropdown` gives it back
  to its toggle when the popup closes with focus inside, and a toast that held focus gives it back where it came
  from. `Dropdown` takes `haspopup`: `'menu'` (the default) for a list of actions, whose items have
  `role="menuitem"` (focus starts on the first; ↑/↓/Home/End move), `'listbox'` for a list to pick from, `'dialog'`
  for a panel of controls or a form. A popup closes when focus leaves it and stays inside the window on phones.
- Toasts: one with an action (Undo, Start fresh) shows 20 s, and its time stops while the pointer is over it or focus
  is in it; Ctrl/Cmd+Z runs the newest Undo (not while typing or in a dialog). Give undoable actions a toast whose
  action label is "Undo" and pass the file it changes (`datasetId`; by default the active one): an Undo belongs to
  its file, so it closes when another file becomes active (opened, switched to, or its file closed), and neither its
  button nor Ctrl/Cmd+Z ever runs it for another file. Every other action about one file (Start fresh, Plot it, Show,
  Open X–Y plot) passes its `datasetId` too, so it closes the same way and never changes or shows a file off screen.

## Testing

- `npm test` runs Vitest on `src/**/*.test.ts` (pure modules only, node environment).
- Real-file tests are opt-in: set `XPP_REAL_FILE=/path/to/Data.txt` to parse a real X-Plane log in the parser
  tests. Never commit flight logs (`.gitignore` blocks `samples/` and `Data*.txt`), nor numbers measured in them:
  fixtures and examples use synthetic values.
- `npm run e2e` (scripts/e2e.mjs, after `npm run build`) drives the built app in a local Chrome/Edge with
  playwright-core: landing, every tab with the demo in light and dark, a dragged selection saved as a test point, the
  X–Y range-and-endurance preset, Find steady points and Add points from times, the test-validity checklists (Test
  points panel, both kinds, each keeping its own settings; Dynamic modes card; the X–Y summary), optionally a real log (`--file`, where the steady
  points found are added and both set checklists are opened), a tablet width; screenshots go to `test-results/`. It fails on any console error,
  so also on anything the Content-Security-Policy blocks. `--dist` serves another build folder (`vite build
  --outDir ...`) and `--port` another port, so several checks can run side by side.
  `node scripts/smoke.mjs <tab>` screenshots one tab from the dev server while working on it.
- Stable `data-testid`s the e2e relies on: `landing`, `demo-button`, `file-input`, `loading-overlay`, `tab-<id>`,
  `view-<id>`, `time-mode-select`, `time-plot-area`, `selection-bar`, `save-point-button`, `save-point-confirm`,
  `points-row`, `xy-re-summary`, `xy-re-table` (the demo's range and endurance through the jet preset),
  `find-steady-button`, `steady-dialog`, `steady-row`, `steady-add`, `add-times-button`, `times-dialog`, `times-input`,
  `times-row`, `times-verdict`, `times-add` (Find steady points and Add points from times), `points-checklist`,
  `points-checklist-verdict`, `points-checklist-point`, `points-checklist-row`, `modes-checklist`,
  `modes-checklist-verdict`, `modes-checklist-row`, `xy-checks-perf`, `xy-checks-trim` (and their `-verdict`, `-open`)
  (the test-validity checklists).
- CI (GitHub Actions) runs lint, tests and the build before deploying to Pages. Its first step fails when a tracked
  file looks like flight data or an export of it (`*.txt`, `*.csv`, `*.tsv`, `*.dat`, `xpp_*.m`, session JSON,
  `out/`, `samples/`) or is over 1 MB. Only the deploy job may write to Pages; actions are pinned to commit SHAs
  (Dependabot proposes updates).

## Security

- The built `index.html` carries a Content-Security-Policy (`vite.config.ts`, build only): scripts, styles, fonts,
  images and the parser worker come from the app's own origin and nothing can be sent elsewhere (`connect-src
  'self'`), so "your file is never uploaded" holds even against a compromised dependency. The inline theme script is
  allowed by its hash, computed at build time. A feature that needs another origin must change the policy on purpose.
- Files, session JSON and localStorage are untrusted input (see the data model above); the MATLAB script and every
  CSV write names that start with `=`, `+`, `-`, `@` with a leading `'`, so a spreadsheet never runs them.
