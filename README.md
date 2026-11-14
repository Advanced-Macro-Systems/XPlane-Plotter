# X-Plane Plotter

Load an X-Plane 12 `Data.txt` flight log in your browser, then plot, crop, fit and export any channel. The app is built for
flight-test coursework: performance (including range and endurance), static stability from trim points, dynamic modes,
and propulsion-only control.

**Live app:** https://advanced-macro-systems.github.io/XPlane-Plotter/

> Your file is read by your browser and never uploaded. Workspaces (test points, panels, formulas) are saved in this
> browser per file, so opening the same log again brings them back.

## What it does

- **Opens any X-Plane 12 log.** Whatever Data Output rows you ticked, the columns are recognised from a dictionary of
  X-Plane 12 Data Output channels (labels, units, groups). It also opens CSV and TSV files. Large logs (60 MB+) parse in a
  background worker with a progress bar.
- **Time history.** Stacked panels with a shared time axis, zoom and crosshair. Channels with different units go in separate
  panels. Presets cover longitudinal, lateral-directional, performance, engine and propulsion-control sets. Sim resets
  and recording gaps are detected and marked.
- **Test points.** Drag across the plots to select a steady window and save it as a test point in a colour-coded group. The
  table shows mean ± σ for the channels you choose, with a drift check that flags windows which were not steady.
  Deleting a point (or a panel) can be undone from its message or with Ctrl+Z (⌘Z on a Mac).
- **X–Y plots.** Any channel against any other, using all data, the zoom range or the test points. Test points are shown as
  means with ±σ error bars. Linear, quadratic and cubic fits, and two physical models from the parabolic drag polar
  (power A·V³ + B/V, drag or thrust A·V² + B/V²), report the equation, R² and standard errors. Presets include the lift
  curve, drag polar, elevator-to-trim vs CL (static stability), range and endurance (propeller and jet), thrust and drag
  vs TAS, and the ground track.
- **Range and endurance.** Mark the speed for maximum endurance (the fitted curve's minimum) and for maximum range (where
  the tangent from the origin touches it) with guide lines and labels, axes from zero, and a results table (see below).
- **Dynamic modes.** Fits a damped oscillation (phugoid, short period, dutch roll) or a first-order response (roll
  subsidence, spiral) to a window. Reports period, ωd, ωn, ζ, time to half amplitude and R², with ζ from the logarithmic
  decrement as a cross-check.
- **Formulas.** Derived channels such as total thrust, fuel flow, CL from weight, power required, specific excess power,
  specific range and endurance, or anything you type (`drag_lb * Vtrue_ktas * kt2ms * lb2n / 1000`).
- **Exports.** PNG and SVG figures (white "paper" style), CSV of samples or test-point statistics, session JSON, and a
  **MATLAB script** that re-reads the original log and reproduces the test-point table, X–Y figure (with range and
  endurance, numbers in `out/range_endurance.txt`), time histories and mode fit into `./out/`, so report figures and
  numbers can come from your `run_all.m`.

A synthetic **demo flight** (twin-engine airliner with steady points, short period, phugoid, dutch roll, roll subsidence and
throttle steps) lets you try everything without a log. It opens with its trim points and dynamic-mode windows already
marked. It is synthetic: never use it as flight-test evidence.

## Range and endurance from steady level points

1. Fly steady, level points at several speeds (constant altitude and power, VVI near zero), from near the stall to the
   fastest you need, with true airspeed and engine power (propeller) or thrust (jet) recorded.
2. **Time history** → **Select** → drag across a steady stretch (or **Set window…**) → **Save test point**. Repeat for every
   speed; one group for the series.
3. **X–Y plot** → **Preset** → *Range & endurance — propeller (engine power vs TAS)* or *Range & endurance — jet (thrust vs
   TAS)*. It plots the test-point means, fits the physical model through them, marks both speeds and starts the axes at
   zero. A twin's total engine power or total thrust is made as a formula channel when you pick the preset.
4. Read V<sub>E</sub>, V<sub>R</sub> and the curve there in the **Range & endurance** table under the plot (**Copy table**
   for TSV), or switch the fit to Quadratic or Cubic to compare. Export → **MATLAB script: this plot only** draws the same
   figure in MATLAB and writes the numbers to `out/range_endurance.txt`.

Propeller aircraft: power against TAS, the minimum is maximum endurance (least power), the tangent from the origin is
maximum range (least power per speed, i.e. least drag). Jets: thrust (or drag) against TAS, the minimum is maximum
endurance (least drag), the tangent from the origin is maximum range (least thrust per speed). For the physical models
V<sub>R</sub>/V<sub>E</sub> = 3<sup>¼</sup> ≈ 1.32. A constant scale on the speed (KIAS or KEAS at one altitude) gives the
same points in those units. Results hold for the weight and altitude flown: this version does not reduce them to standard
conditions. A speed outside the test points is flagged as extrapolated. No speeds are given (the table says why) before
there are test points, or when the physical model does not fit the points (R² ≤ 0) or its A or B is within two standard
errors of zero.

## Recording data in X-Plane 12

1. Open **Settings** (the gear on the menu bar) → **Data Output** → **General Data Output**.
2. Tick **Disk (data.txt File)** on every row you need. X-Plane 12 sorts the rows by topic, so use the search box. In the app,
   **?** → *Record data* lists the recommended rows, with their index numbers, for performance, trim and static stability,
   dynamic modes and propulsion-only control.
3. Set **Disk Rate** under *Output rates* (default 10 per second; 20–25 for dynamic modes), then fly the test.
4. Quit X-Plane and copy `Data.txt` from the main `X-Plane 12` folder. Rename the copy (for example
   `Data_phugoid_run1.txt`), because the next session may overwrite the file. Drop it on the app.

Each ticked row adds its own columns, so every file can be different: the app reads whatever is there. A file takes about
16 bytes per value (170 columns at 10 per second for 30 minutes is about 50 MB), so tick only the rows you need. Don't open
`Data.txt` as a CSV in Excel: the column names contain commas.

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (Vitest)
npm run lint
npm run build        # production build in dist/
npm run e2e          # drives the built app in your local Chrome/Edge (playwright-core); add --file path/to/Data.txt
```

Every push to `main` is linted, tested, built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.
`docs/ARCHITECTURE.md` describes the code layout, data model and conventions.

## Credits

Charts by [Apache ECharts](https://echarts.apache.org/) (Apache-2.0). Type: [Geist](https://vercel.com/font) (OFL).
Icons: [Primer Octicons](https://primer.style/octicons) (MIT). X-Plane is a trademark of Laminar Research. This project
is independent and not affiliated with or endorsed by Laminar Research.
