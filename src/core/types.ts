// Core data model shared by every module. Pure types: no runtime code here.
//
// Conventions
// - A "row" is one output frame of the log (one line of Data.txt). Row indices are 0-based.
// - Row ranges are half-open: [start, end) — start inclusive, end exclusive. A range is valid when 0 <= start < end <= rowCount.
// - Test points, selections and zoom ranges are stored as row ranges, so they survive changing the time axis.
// - Missing / unparseable values are NaN. Every Channel.values has exactly dataset.rowCount entries.

export type DatasetFormat = 'xplane' | 'csv'

/** Half-open row range [start, end). */
export type RowRange = readonly [start: number, end: number]

/** What the app knows about a channel's meaning: from the X-Plane dictionary, or guessed from its header. */
export interface ChannelMeta {
  /** Human label, e.g. "Indicated airspeed" */
  label: string
  /** Short label for axis titles and legends, e.g. "KIAS" */
  short: string
  /** Display unit, e.g. "kt", "deg", "lb·ft"; '' when dimensionless or unknown */
  unit: string
  /** Physical quantity id (speed, angle, angular-rate, force, ...); 'other' when unknown */
  quantity: string
  /** Group id (an X-Plane Data Output row such as "speeds"), see core/channels/groups.ts; 'other' when unknown */
  group: string
  description?: string
  /** Sign convention, when the dictionary knows it */
  sign?: string
  /** Pitfalls worth showing in a tooltip */
  notes?: string
  /** true when the dictionary recognised the token */
  known: boolean
}

export interface ChannelStats {
  min: number
  max: number
  mean: number
  std: number
  /** Number of finite samples */
  finite: number
  /** true when every finite sample is equal (or there are none) — e.g. empty weight, unused load stations */
  constant: boolean
}

export interface Channel {
  /**
   * Unique within its dataset and stable across reloads of the same file:
   * the header token, with "#2", "#3"... appended for the 2nd, 3rd... occurrence of a repeated token
   * (X-Plane repeats e.g. "elev1,__deg" and "wing1,_lift"); "fx:<slug>" for a derived channel.
   */
  id: string
  /** Raw header text, trimmed ('' for derived channels) */
  token: string
  /** 1-based occurrence of `token` in the header */
  occurrence: number
  /** 0-based column in the file; -1 for derived channels */
  column: number
  meta: ChannelMeta
  /** One value per row (NaN where missing) */
  values: Float64Array
  stats: ChannelStats
  /** Present on derived channels: the expression that produced them */
  derived?: { expression: string }
}

/**
 * A run of rows with continuous time. A new segment starts where the time source goes backwards (the sim was reset or a
 * new flight loaded) or jumps forward by more than the gap threshold (paused recording, time skip).
 */
export interface Segment {
  start: number
  /** exclusive */
  end: number
  reason: 'start' | 'reset' | 'gap'
}

export interface Dataset {
  id: string
  /** File name ("Data.txt") or "Demo flight (synthetic)" */
  name: string
  sizeBytes: number
  format: DatasetFormat
  rowCount: number
  /** File columns in file order, then derived channels in creation order */
  channels: Channel[]
  /** The channel `elapsed` was built from (e.g. "_totl,_time"), or null when the file has no usable time column */
  timeSourceId: string | null
  /**
   * Seconds since the first row, non-decreasing, built from the time source with discontinuities collapsed
   * (each reset/gap advances by one median sample interval). When there is no time source it is the row index
   * divided by an assumed 1 Hz, and `timeSourceId` is null.
   */
  elapsed: Float64Array
  segments: Segment[]
  /** Median sample rate from the time source; NaN when unknown */
  sampleRateHz: number
  /** Human-readable parse / data-quality notes (skipped rows, truncated last line, resets found ...) */
  warnings: string[]
  /** Stable across reloads of the same file (headers + row count + first/last time values) — keys saved workspaces */
  signature: string
  loadedAt: number
}

/** Which values the time axis shows. 'elapsed' = Dataset.elapsed; 'index' = row number; `ch:<id>` = a raw time channel. */
export type TimeBaseId = 'elapsed' | 'index' | `ch:${string}`

export interface TimeAxis {
  id: TimeBaseId
  /** e.g. "Elapsed time", "Sim time (total)", "Row" */
  label: string
  /** 's', 'h', or '' for row numbers */
  unit: string
  /** One value per row, non-decreasing (only monotonic channels are offered as time bases) */
  values: Float64Array
  /** true for hour-of-day clocks (zulu / local), which are formatted hh:mm:ss */
  clock?: boolean
}

// ------------------------------------------------------------------ the per-dataset workspace (saved by signature)

/** One stacked chart in Time history; every channel in a panel shares its y-axis (no dual axes). */
export interface PanelConfig {
  id: string
  channelIds: string[]
  /**
   * Categorical colour slot (0..7) of each channel, parallel to channelIds: a channel keeps its colour while it stays
   * in the panel, and a channel added gets the lowest free slot (core/slots.ts). Absent or invalid (older files):
   * re-derived, 0, 1, 2, ... by position.
   */
  slots?: number[]
  /** Force the y-axis to include zero */
  yZero?: boolean
}

/** A colour-coded set of test points, e.g. "CG forward". `slot` is the categorical colour slot 0..7. */
export interface PointGroup {
  id: string
  name: string
  slot: number
}

/** A saved window of steady (or otherwise interesting) flight. */
export interface TestPoint {
  id: string
  name: string
  groupId: string
  /** Row range [start, end) */
  start: number
  end: number
  hidden?: boolean
  note?: string
}

/** A user formula, evaluated row by row over the dataset's channels (see core/analysis/expr.ts). */
export interface DerivedDef {
  /** Channel id of the result: "fx:<slug>" */
  id: string
  name: string
  unit: string
  expression: string
}

export interface XYConfig {
  /** Channel id on the horizontal axis */
  x: string | null
  /** Up to 8 channel ids on the vertical axis (one shared axis: pick channels with the same unit) */
  ys: string[]
  /** Colour slot (0..7) of each Y channel, parallel to ys: kept while the channel stays (see PanelConfig.slots) */
  ySlots?: number[]
  /** Which rows: the whole file, the Time-history zoom range, or the visible test points */
  source: 'all' | 'view' | 'points'
  /**
   * With source 'points': only the points of these groups (ids), e.g. the trim points but not the dynamic-test
   * windows. Absent or empty = every group.
   */
  groups?: string[]
  style: 'points' | 'lines' | 'both'
  /** 'series' = colour per y channel; 'group' = colour per test-point group (source 'points'); 'time' = sequential by time */
  colorBy: 'series' | 'group' | 'time'
  /**
   * Least-squares fit per colour entity: a polynomial, or a physical model from the parabolic drag polar (range and
   * endurance, core/analysis/rangeEndurance.ts): 'power-model' y = A·V³ + B/V, 'drag-model' y = A·V² + B/V².
   */
  fit: 'none' | 'linear' | 'poly2' | 'poly3' | 'power-model' | 'drag-model'
  /** Fit through raw samples or through the test-point means */
  fitTarget: 'samples' | 'means'
  /**
   * Range and endurance markers on each fit: its minimum (maximum endurance) and the tangent from the origin
   * (maximum range), with guide lines, labels and a results table. Absent = off (older files).
   */
  rangeEndurance?: boolean
  /** Both axes start at zero (absent = off: the axes fit the data) */
  axesFromZero?: boolean
  showSamples: boolean
  /** Mean ± 1σ marker per test point (source 'points') */
  showMeans: boolean
  title: string
  xLabel: string
  yLabel: string
}

export interface ModesConfig {
  channelId: string | null
  /** Rows to analyse: the current selection, the zoom range, or a test point */
  source: 'selection' | 'view' | `point:${string}`
  model: 'oscillation' | 'first-order'
  detrend: 'none' | 'linear'
  /** The test-validity checklist's settings for the Dynamic modes window (absent = defaults; older files) */
  check?: ModesCheckSettings
}

// ------------------------------------------------------------------ test-validity checklists (core/checklists)

/** The five dynamic modes the checklist knows (the Dynamic modes quick picks). */
export type DynamicModeId = 'short-period' | 'phugoid' | 'dutch-roll' | 'roll-subsidence' | 'spiral'

/** What the student declares about automatic controls (shared by the static and performance checklists). */
export interface ChecklistDeclared {
  autopilot?: 'off' | 'on' | 'unknown'
  autothrottle?: 'off' | 'on' | 'unknown'
  /** e.g. "ALT HOLD + HDG, A/T off" (at most 200 characters) */
  modes?: string
}

/** ModesConfig.check: the dynamic checklist's settings. */
export interface ModesCheckSettings {
  /** The mode, when neither the quick pick nor the test point's name says it */
  mode?: DynamicModeId
  /** The run was flown with the yaw damper on (an augmented run) */
  yawDamper?: 'off' | 'on'
  /** The input rows [start, end), when detection picks the wrong burst */
  input?: RowRange
  limits?: { vmoKias?: number; mmo?: number; vsKias?: number; alphaMaxDeg?: number }
}

/** Workspace.trimCheck: the static-stability checklist's settings. */
export interface TrimCheckSettings {
  /** G: degrees of elevator per unit of _trim,_elev (absent: fitted) */
  gain?: number
  /** How the aircraft trims in pitch: a trimmable stabiliser, or trim that deflects the elevator or a tab */
  trimType?: 'stabiliser' | 'elevator'
  /** MAC length and the CG reference value of its leading edge (may be negative), for %MAC */
  macFt?: number
  lemacFt?: number
  limits?: { vsKias?: number; alphaStallDeg?: number; mmo?: number; vmoKias?: number }
  declared?: ChecklistDeclared
  /** Points kept on the plot but left out of the fit by the user (this checklist's own list) */
  fitExcluded?: string[]
  /** The X–Y fit runs through the used points only */
  fitUsedOnly?: boolean
}

/** Workspace.perfCheck: the range-and-endurance checklist's settings. */
export interface PerfCheckSettings {
  propulsion?: 'jet' | 'propeller'
  /** κ: the thrust line against the body x axis, positive nose up (default 0) */
  thrustAngleDeg?: number
  /** Standard condition for the reduction (defaults: the set's mean weight and mean pressure altitude) */
  referenceWeightLb?: number
  referenceAltitudeFt?: number
  limits?: { vsKeas?: number; mmo?: number; vmoKias?: number }
  declared?: ChecklistDeclared
  fitExcluded?: string[]
  fitUsedOnly?: boolean
}

export interface Workspace {
  version: 1
  timeBase: TimeBaseId
  panels: PanelConfig[]
  groups: PointGroup[]
  points: TestPoint[]
  derived: DerivedDef[]
  xy: XYConfig
  modes: ModesConfig
  /** Channel ids shown as mean ± σ columns in the test-points table */
  tracked: string[]
  /** Static-stability checklist settings (on the workspace: applying an X–Y preset replaces XYConfig) */
  trimCheck?: TrimCheckSettings
  /** Range-and-endurance checklist settings */
  perfCheck?: PerfCheckSettings
  /** Which checklist the Test points tab shows */
  checklist?: { kind: 'performance' | 'static' }
}

export type TabId = 'overview' | 'time' | 'xy' | 'points' | 'modes' | 'channels'
