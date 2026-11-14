// The Overview tab's model, pure and unit-tested: the stat-tile figures, the "Flight at a glance" panels (which
// channels, decimated lines, segment boundaries, test-point bands) and the ground track with its equal-aspect ranges.

import { lttb } from '../../core/analysis/decimate'
import { channelById } from '../../core/dataset'
import type { Channel, Dataset, Segment, Workspace } from '../../core/types'

// ------------------------------------------------------------------ figures for the stat tiles

export interface OverviewFigures {
  /** Elapsed seconds from the first to the last row (gaps and resets collapsed) */
  durationS: number
  rows: number
  rateHz: number
  /** Every channel, formulas included */
  channels: number
  /** File columns */
  fileChannels: number
  /** File columns the X-Plane dictionary recognised */
  known: number
  /** File columns whose every value is the same */
  constant: number
  formulas: number
  segments: number
  resets: number
  gaps: number
  points: number
  /** Groups holding at least one test point */
  groupsUsed: number
}

export function overviewFigures(ds: Dataset, ws: Workspace | null): OverviewFigures {
  const file = ds.channels.filter((ch) => !ch.derived)
  const last = ds.rowCount - 1
  const points = ws?.points ?? []
  return {
    durationS: last > 0 ? ds.elapsed[last] - ds.elapsed[0] : 0,
    rows: ds.rowCount,
    rateHz: ds.sampleRateHz,
    channels: ds.channels.length,
    fileChannels: file.length,
    known: file.filter((ch) => ch.meta.known).length,
    constant: file.filter((ch) => ch.stats.constant).length,
    formulas: ds.channels.length - file.length,
    segments: ds.segments.length,
    resets: ds.segments.filter((s) => s.reason === 'reset').length,
    gaps: ds.segments.filter((s) => s.reason === 'gap').length,
    points: points.length,
    groupsUsed: new Set(points.map((p) => p.groupId)).size,
  }
}

/** "continuous", or what split the recording: "2 resets · 1 gap". */
export function segmentSummary(figures: Pick<OverviewFigures, 'resets' | 'gaps'>): string {
  const parts: string[] = []
  if (figures.resets) parts.push(`${figures.resets} reset${figures.resets === 1 ? '' : 's'}`)
  if (figures.gaps) parts.push(`${figures.gaps} gap${figures.gaps === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'continuous time'
}

/** The key under the glance charts for the segment-boundary lines: "Sim reset", "2 recording gaps", "1 sim reset and 2 recording gaps". */
export function markerLegend(resets: number, gaps: number): string {
  const resetText = resets === 1 ? 'sim reset' : `${resets} sim resets`
  const gapText = gaps === 1 ? 'recording gap' : `${gaps} recording gaps`
  if (resets > 0 && gaps > 0) {
    return `${resets === 1 ? '1 sim reset' : resetText} and ${gaps === 1 ? '1 recording gap' : gapText}`
  }
  const text = resets > 0 ? resetText : gaps > 0 ? gapText : ''
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Channel groups listed before "N more rows": about three lines of chips on a desktop. */
export const GROUPS_FOLDED = 18

/**
 * How many channel-group chips "Data in this file" shows: all of them when expanded or when only a few would be
 * folded away (folding 3 chips behind a button saves nothing), else the first GROUPS_FOLDED.
 */
export function groupsShown(total: number, expanded: boolean, limit = GROUPS_FOLDED): number {
  return expanded || total <= limit + 4 ? total : limit
}

/** "10 Hz", "9.98 Hz", "—" when unknown. */
export function formatRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—'
  return `${Number(hz.toPrecision(3))} Hz`
}

// ------------------------------------------------------------------ "Flight at a glance" panels

/**
 * The x-axis of the glance charts: elapsed seconds, or row numbers when the file has no time column (its elapsed
 * time is then the row index, see Dataset.elapsed).
 */
export function glanceTime(ds: Pick<Dataset, 'timeSourceId'>): { base: 'elapsed' | 'index'; axisName: string; against: string } {
  return ds.timeSourceId !== null
    ? { base: 'elapsed', axisName: 'Elapsed time [s]', against: 'elapsed time' }
    : { base: 'index', axisName: 'Row', against: 'row number' }
}

export interface GlancePanelSpec {
  key: string
  /** The channel's label for a one-channel panel, else the panel caption ("Airspeed") */
  title: string
  unit: string
  /** One to two channels sharing `unit` (one axis per chart: no dual axes) */
  channelIds: string[]
}

/** Altitude, airspeed and attitude, from whichever of these channels the file has (first listed wins). */
const GLANCE_PRESETS: readonly { key: string; caption: string; ids: readonly string[]; max: number }[] = [
  { key: 'altitude', caption: 'Altitude', ids: ['p-alt,ftMSL', '___CG,ftMSL', '__alt,ftmsl'], max: 1 },
  { key: 'airspeed', caption: 'Airspeed', ids: ['_Vind,_kias', 'Vtrue,_ktas'], max: 2 },
  { key: 'attitude', caption: 'Attitude', ids: ['pitch,__deg', '_roll,__deg'], max: 2 },
]

const TIME_LIKE = /time|zulu|local|hobbs|timer/i

/** Varying, non-time file channels in file order: what a CSV without known channels shows. */
export function plainChannels(ds: Dataset): Channel[] {
  return ds.channels.filter(
    (ch) =>
      !ch.derived &&
      ch.id !== ds.timeSourceId &&
      !ch.stats.constant &&
      ch.stats.finite > 1 &&
      !TIME_LIKE.test(ch.token) &&
      ch.meta.quantity !== 'time',
  )
}

/** The glance panels: the presets the file has, else its first three plain channels. */
export function glancePanels(ds: Dataset): GlancePanelSpec[] {
  const panels: GlancePanelSpec[] = []
  for (const preset of GLANCE_PRESETS) {
    const found = preset.ids
      .map((id) => channelById(ds, id))
      .filter((ch): ch is Channel => ch !== undefined && ch.stats.finite > 0)
    if (!found.length) continue
    const unit = found[0].meta.unit
    const channels = found.filter((ch) => ch.meta.unit === unit).slice(0, preset.max)
    panels.push({
      key: preset.key,
      title: channels.length === 1 ? channels[0].meta.label : preset.caption,
      unit,
      channelIds: channels.map((ch) => ch.id),
    })
  }
  if (panels.length) return panels
  return plainChannels(ds)
    .slice(0, 3)
    .map((ch) => ({ key: ch.id, title: ch.meta.label, unit: ch.meta.unit, channelIds: [ch.id] }))
}

/**
 * LTTB per segment, so a line never joins the last sample before a sim reset to the first one after it: the
 * segments are reduced separately (budget shared by length) and joined by a NaN point, which breaks the line.
 */
export function decimateBySegment(
  x: Float64Array,
  y: Float64Array,
  segments: readonly Segment[],
  budget: number,
): { x: Float64Array; y: Float64Array } {
  const n = Math.min(x.length, y.length)
  const parts = segments
    .map((s) => [Math.max(0, Math.min(n, s.start)), Math.max(0, Math.min(n, s.end))] as const)
    .filter(([start, end]) => end > start)
  if (parts.length <= 1) return lttb(x.subarray(0, n), y.subarray(0, n), budget)
  const outX: number[] = []
  const outY: number[] = []
  for (const [start, end] of parts) {
    const share = Math.max(2, Math.round((budget * (end - start)) / n))
    const part = lttb(x.subarray(start, end), y.subarray(start, end), share)
    if (!part.x.length) continue
    if (outX.length) {
      outX.push(part.x[0])
      outY.push(Number.NaN)
    }
    for (let i = 0; i < part.x.length; i += 1) {
      outX.push(part.x[i])
      outY.push(part.y[i])
    }
  }
  return { x: Float64Array.from(outX), y: Float64Array.from(outY) }
}

/** [x, y] pairs for ECharts, a missing y as null (a break in the line). */
export function toPairs(x: ArrayLike<number>, y: ArrayLike<number>): [number, number | null][] {
  const n = Math.min(x.length, y.length)
  const pairs = new Array<[number, number | null]>(n)
  for (let i = 0; i < n; i += 1) pairs[i] = [x[i], Number.isFinite(y[i]) ? y[i] : null]
  return pairs
}

/** Where the elapsed time was stitched: one marker per segment after the first. */
export function segmentMarkers(ds: Dataset): { x: number; reason: 'reset' | 'gap' }[] {
  return ds.segments
    .slice(1)
    .filter((s) => s.start > 0 && s.start < ds.rowCount && s.reason !== 'start')
    .map((s) => ({ x: ds.elapsed[s.start], reason: s.reason as 'reset' | 'gap' }))
}

export interface PointBand {
  from: number
  to: number
}

/** The visible test points as elapsed-time bands (drawn neutral, whatever their group). */
export function pointBands(ds: Dataset, ws: Pick<Workspace, 'points' | 'groups'> | null): PointBand[] {
  if (!ws) return []
  const bands: PointBand[] = []
  for (const p of ws.points) {
    if (p.hidden) continue
    const start = Math.max(0, Math.min(ds.rowCount - 1, p.start))
    const last = Math.max(start, Math.min(ds.rowCount - 1, p.end - 1))
    bands.push({ from: ds.elapsed[start], to: ds.elapsed[last] })
  }
  return bands
}

// ------------------------------------------------------------------ ground track

export const LAT_ID = '__lat,__deg'
export const LON_ID = '__lon,__deg'

export interface TrackPoint {
  lon: number
  lat: number
  /** Dataset.elapsed at that row (s) */
  t: number
}

export interface GroundTrack {
  latId: string
  lonId: string
  /**
   * [lon, lat] pairs in row order; [null, null] breaks the line (missing fixes, sim resets, recording gaps). A run that
   * does not move (the aircraft parked before a sim reload) is one point, which the chart shows as a ring.
   */
  path: [number | null, number | null][]
  /** The first point of the first run that moves (not a lone position logged before a reset) */
  start: TrackPoint
  /** The last point of the last run that moves */
  end: TrackPoint
  /** Where the track picks up again after a sim reset or recording gap: the first point of each later moving run */
  restarts: (TrackPoint & { reason: 'reset' | 'gap' })[]
  lonExtent: [number, number]
  latExtent: [number, number]
}

/** A run of the track narrower than this share of the whole track's span draws no visible line: it is one position. */
const STILL_SHARE = 0.002

interface TrackRun {
  points: [number, number][]
  rows: number[]
  /** Why the line broke before this run */
  after: 'start' | 'reset' | 'gap' | 'missing'
}

/** A real fix: finite, and not the (0, 0) X-Plane reports before the aircraft is placed. */
function isFix(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90
}

/**
 * Longitude/latitude path (every k-th row, at most about `maxPoints`), or null without a usable lat/lon pair. The line
 * breaks at missing fixes and at every sim reset or recording gap (Dataset.segments); Start and End sit on the runs
 * that move, and each later moving run after a reset or gap is a restart.
 */
export function groundTrack(ds: Dataset, maxPoints = 3000): GroundTrack | null {
  const latCh = channelById(ds, LAT_ID)
  const lonCh = channelById(ds, LON_ID)
  if (!latCh || !lonCh) return null
  const lat = latCh.values
  const lon = lonCh.values
  const n = Math.min(ds.rowCount, lat.length, lon.length)
  const stride = Math.max(1, Math.ceil(n / Math.max(2, maxPoints)))
  const boundaries = new Map(ds.segments.slice(1).map((s) => [s.start, s.reason]))
  const runs: TrackRun[] = []
  let run: TrackRun | null = null
  let after: TrackRun['after'] = 'start'
  let lonMin = Infinity
  let lonMax = -Infinity
  let latMin = Infinity
  let latMax = -Infinity
  const take = (i: number) => {
    if (!isFix(lat[i], lon[i])) {
      if (run) {
        run = null
        after = 'missing'
      }
      return
    }
    if (!run) {
      run = { points: [], rows: [], after }
      runs.push(run)
    }
    run.points.push([lon[i], lat[i]])
    run.rows.push(i)
    lonMin = Math.min(lonMin, lon[i])
    lonMax = Math.max(lonMax, lon[i])
    latMin = Math.min(latMin, lat[i])
    latMax = Math.max(latMax, lat[i])
  }
  for (let i = 0; i < n; i += 1) {
    // A segment boundary always breaks the line, even between kept rows.
    const boundary = boundaries.get(i)
    if (boundary !== undefined) {
      run = null
      after = boundary === 'start' ? 'gap' : boundary
    }
    if (i % stride === 0 || i === n - 1 || boundary !== undefined) take(i)
  }
  if (!runs.length || (lonMin === lonMax && latMin === latMax)) return null

  // Spans in latitude degrees on both axes (east–west degrees shrink with cos(latitude)).
  const k = Math.max(0.05, Math.cos((((latMin + latMax) / 2) * Math.PI) / 180))
  const span = Math.max((lonMax - lonMin) * k, latMax - latMin)
  const moves = (r: TrackRun) => {
    let lo = [Infinity, Infinity]
    let hi = [-Infinity, -Infinity]
    for (const [x, y] of r.points) {
      lo = [Math.min(lo[0], x), Math.min(lo[1], y)]
      hi = [Math.max(hi[0], x), Math.max(hi[1], y)]
    }
    return Math.max((hi[0] - lo[0]) * k, hi[1] - lo[1]) > STILL_SHARE * span
  }
  const path: [number | null, number | null][] = []
  const moving: TrackRun[] = []
  for (const r of runs) {
    if (path.length) path.push([null, null])
    if (moves(r)) {
      moving.push(r)
      path.push(...r.points)
    } else {
      path.push(r.points[0])
    }
  }
  const point = (r: TrackRun, j: number): TrackPoint => ({ lon: r.points[j][0], lat: r.points[j][1], t: ds.elapsed[r.rows[j]] })
  const firstRun = moving[0] ?? runs[0]
  const lastRun = moving[moving.length - 1] ?? runs[runs.length - 1]
  const restarts: GroundTrack['restarts'] = []
  for (const r of moving.slice(1)) {
    if (r.after === 'reset' || r.after === 'gap') restarts.push({ ...point(r, 0), reason: r.after })
  }
  return {
    latId: latCh.id,
    lonId: lonCh.id,
    path,
    start: point(firstRun, 0),
    end: point(lastRun, lastRun.points.length - 1),
    restarts,
    lonExtent: [lonMin, lonMax],
    latExtent: [latMin, latMax],
  }
}

/** Mean length of a degree of latitude, km. */
const KM_PER_DEG = 111.2

/** The east–west and north–south size of the area the track covers, km (spherical Earth: an overview figure). */
export function trackSizeKm(track: Pick<GroundTrack, 'lonExtent' | 'latExtent'>): { eastWest: number; northSouth: number } {
  const latMid = (track.latExtent[0] + track.latExtent[1]) / 2
  return {
    eastWest: (track.lonExtent[1] - track.lonExtent[0]) * KM_PER_DEG * Math.cos((latMid * Math.PI) / 180),
    northSouth: (track.latExtent[1] - track.latExtent[0]) * KM_PER_DEG,
  }
}

/** Shortest and tallest ground-track plot box (px): a flat east–west track still gets room, a north–south one does not tower. */
const MIN_PLOT_HEIGHT = 200
const MAX_PLOT_HEIGHT = 420
/** Before the width is known */
const FIRST_PLOT_HEIGHT = 300

/**
 * The ground-track plot box's height for the track's shape (north–south over east–west extent) at `width` px, within
 * 200–420 px, and the resulting plot-area aspect (width / height) for equalAspectRanges. `insets` are the chart's grid
 * margins. Sized this way the equal-aspect ranges stay close to the track instead of padding it into a tall box.
 */
export function trackPlotBox(
  size: { eastWest: number; northSouth: number },
  width: number,
  insets: { left: number; right: number; top: number; bottom: number },
): { height: number; aspect: number } {
  const plotWidth = width - insets.left - insets.right
  const insetsY = insets.top + insets.bottom
  if (!(plotWidth > 10)) return { height: FIRST_PLOT_HEIGHT, aspect: 1 }
  const shape = size.eastWest > 0 ? size.northSouth / size.eastWest : Infinity
  const wanted = Number.isFinite(shape) ? plotWidth * shape + insetsY : MAX_PLOT_HEIGHT
  const height = Math.round(Math.min(MAX_PLOT_HEIGHT, Math.max(MIN_PLOT_HEIGHT, wanted)))
  return { height, aspect: plotWidth / (height - insetsY) }
}

/** Smallest span shown, degrees of latitude (~110 m): a track that barely moves still gets a readable box. */
const MIN_SPAN_DEG = 0.001

/**
 * Axis ranges that draw the track with equal ground distances on both axes (east–west degrees shrink with
 * cos(latitude)) inside a plot of `plotAspect` = width / height, with `pad` (a fraction of the span) around it.
 */
export function equalAspectRanges(
  lonExtent: readonly [number, number],
  latExtent: readonly [number, number],
  plotAspect: number,
  pad = 0.1,
): { lon: [number, number]; lat: [number, number] } {
  const aspect = Number.isFinite(plotAspect) && plotAspect > 0 ? plotAspect : 1
  const latMid = (latExtent[0] + latExtent[1]) / 2
  const lonMid = (lonExtent[0] + lonExtent[1]) / 2
  const k = Math.max(0.05, Math.cos((latMid * Math.PI) / 180))
  // Work in "latitude degrees" on both axes, where one unit is the same ground distance.
  let width = Math.max(MIN_SPAN_DEG, (lonExtent[1] - lonExtent[0]) * k) * (1 + 2 * pad)
  let height = Math.max(MIN_SPAN_DEG, latExtent[1] - latExtent[0]) * (1 + 2 * pad)
  if (width / height < aspect) width = height * aspect
  else height = width / aspect
  return {
    lon: [lonMid - width / k / 2, lonMid + width / k / 2],
    lat: [latMid - height / 2, latMid + height / 2],
  }
}
