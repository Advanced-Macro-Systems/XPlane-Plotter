# X-Plane Plotter

Load an X-Plane 12 `Data.txt` flight log in your browser, then plot, crop, fit and export any channel. The app is built for
flight-test coursework: performance (including range and endurance), static stability from trim points, dynamic modes,
and propulsion-only control.

**Live app:** https://mithunkrish-05.github.io/XPlane-Plotter/

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
- **X–Y plots.** Any channel against any other, using all data, the zoom range or the test points. Test points are shown as
  means with ±σ error bars. Linear, quadratic and cubic fits report the equation, R² and standard errors. Presets include
  the lift curve, drag polar, elevator-to-trim vs CL (static stability), thrust and drag vs TAS, and the ground track.
- **Dynamic modes.** Fits a damped oscillation (phugoid, short period, dutch roll) or a first-order response (roll
  subsidence, spiral) to a window. Reports period, ωd, ωn, ζ, time to half amplitude and R², with ζ from the logarithmic
  decrement as a cross-check.
- **Formulas.** Derived channels such as total thrust, fuel flow, CL from weight, power required, specific excess power,
  specific range and endurance, or anything you type (`drag_lb * Vtrue_ktas * kt2ms * lb2n / 1000`).
- **Exports.** PNG and SVG figures (white "paper" style), CSV of samples or test-point statistics, session JSON, and a
  **MATLAB script** that re-reads the original log and reproduces the test-point table, X–Y figure, time histories and mode
  fit into `./out/`, so report figures and numbers can come from your `run_all.m`.

A synthetic **demo flight** (twin-engine airliner with steady points, short period, phugoid, dutch roll, roll subsidence and
throttle steps) lets you try everything without a log. It opens with its trim points and dynamic-mode windows already
marked. It is synthetic: never use it as flight-test evidence.

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
