// The X–Y plot model: which rows are plotted (source, test-point groups, hidden points), the sample series (one per
// colour entity and Y channel), the test-point means, the fits, the legend and the default labels. The chart option,
// the tooltips, the tables and the exports all read this one model, so it is built once per data change and never on
// hover. Pure: no React, no DOM.

import { channelTitle } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { evalPoly, polyFit, type PolyFit } from '../../core/analysis/fit'
import { physicalFit, physicalValue, type PhysicalFit, type PhysicalModel } from '../../core/analysis/rangeEndurance'
import type { RangeStats } from '../../core/analysis/stats'
import { sanitizeSlots } from '../../core/slots'
import type { Channel, Dataset, PointGroup, RowRange, TestPoint, TimeAxis, Workspace, XYConfig } from '../../core/types'
import { windowStats } from '../points/pointsModel'

/** Most Y channels on the one shared axis (the 8 categorical colour slots). */
export const MAX_Y = 8

/** Marker shapes, in slot order: the second encoding when colour alone cannot tell series apart. */
export const MARKER_SHAPES = ['circle', 'rect', 'diamond', 'triangle', 'triangleDown', 'plus', 'hexagon', 'star'] as const
export type MarkerShape = (typeof MARKER_SHAPES)[number]

/** Values per sample in the interleaved sample arrays: x, y, t (colour time), row. */
export const SAMPLE_STRIDE = 4

// ------------------------------------------------------------------ what the settings come to for this dataset

export interface XYEffective {
  /** The rows actually used (the chosen source falls back to 'all' when it has nothing to offer) */
  source: XYConfig['source']
  /** Why the chosen source could not be used; '' when it was */
  sourceNote: string
  /** 'group' only with test points */
  colorBy: XYConfig['colorBy']
  /** 'means' only with test points */
  fitTarget: XYConfig['fitTarget']
  /** Means only with test points */
  showMeans: boolean
  /** Groups whose points are plotted (workspace order); every group when the filter is empty or stale */
  groupIds: string[]
  /** true when the group filter leaves some group out */
  groupFiltered: boolean
  /** The visible test points of those groups, in workspace order (source 'points' only) */
  points: TestPoint[]
}

/**
 * The settings as they apply now: the zoom-range source needs a zoom range, the test-point source needs test points,
 * colour by group / fit through means / means need the test-point source. Hidden points are never used.
 */
export function effectiveXY(
  xy: XYDataConfig,
  ws: Pick<Workspace, 'points' | 'groups'>,
  view: RowRange | null,
): XYEffective {
  let source = xy.source
  let sourceNote = ''
  if (source === 'view' && !view) {
    source = 'all'
    sourceNote = 'There is no zoom range in Time history, so every row is plotted.'
  } else if (source === 'points' && ws.points.length === 0) {
    source = 'all'
    sourceNote = 'There are no test points yet, so every row is plotted.'
  }
  const allIds = ws.groups.map((g) => g.id)
  const chosen = (xy.groups ?? []).filter((id) => allIds.includes(id))
  const groupIds = chosen.length ? allIds.filter((id) => chosen.includes(id)) : allIds
  const points =
    source === 'points' ? ws.points.filter((p) => !p.hidden && groupIds.includes(p.groupId) && p.end > p.start) : []
  const withPoints = source === 'points'
  return {
    source,
    sourceNote,
    colorBy: xy.colorBy === 'group' && !withPoints ? 'series' : xy.colorBy,
    fitTarget: xy.fitTarget === 'means' && !withPoints ? 'samples' : xy.fitTarget,
    showMeans: xy.showMeans && withPoints,
    groupIds,
    groupFiltered: groupIds.length < allIds.length,
    points,
  }
}

// ------------------------------------------------------------------ the model

export interface XYChannel {
  ch: Channel
  /** Position in XYConfig.ys */
  index: number
  /**
   * The channel's stored colour slot (XYConfig.ySlots): its colour when colouring by series and its marker shape when
   * shapes tell the Y channels apart. It follows the channel, so removing another Y never changes it.
   */
  slot: number
}

export interface XYSampleSeries {
  /** Stable id: "<group id or *>|<y channel id>" */
  key: string
  y: XYChannel
  /** The group these samples belong to when colouring by group, else null */
  group: PointGroup | null
  /** Categorical colour slot 0..7 */
  slot: number
  shape: MarkerShape
  /** Legend and tooltip name */
  name: string
  /** Finite samples, interleaved x, y, t, row (SAMPLE_STRIDE), in time order. Float32 is plenty for drawing; exact
   * values are read back from the channels by row. */
  data: Float32Array
  count: number
  /** For line styles: every row of the ranges in time order (NaN kept) with an all-NaN separator between ranges,
   * so lines break at test-point edges, time resets and gaps. Empty when no line is drawn. */
  lineData: Float32Array
  /** Source 'points': index into XYEffective.points of each sample; else null */
  pointIndex: Int32Array | null
}

export interface XYMean {
  /** Same key as the sample series of its colour entity */
  seriesKey: string
  point: TestPoint
  /** Index into XYEffective.points */
  pointIndex: number
  group: PointGroup | null
  y: XYChannel
  slot: number
  shape: MarkerShape
  x: RangeStats
  yStats: RangeStats
  /** Time of the point's middle row on the colour time axis */
  t: number
  /** Rows in the point */
  rows: number
}

export interface XYLegendEntry {
  key: string
  name: string
  /** 'colour': a coloured marker (slot); 'shape': a neutral marker in that shape (which Y channel) */
  kind: 'colour' | 'shape'
  slot: number
  shape: MarkerShape
}

export interface XYData {
  x: Channel | null
  ys: XYChannel[]
  effective: XYEffective
  series: XYSampleSeries[]
  means: XYMean[]
  /** Colour-time range of the plotted samples and means [min, max] (NaN when there are none) */
  tRange: [number, number]
  /** Finite samples over all series */
  sampleCount: number
  legend: XYLegendEntry[]
  /** Why there is nothing to plot ('' when there is something) */
  empty: string
}

/** The X–Y settings the samples, means and legend depend on (not the style, fit or labels). */
export type XYDataConfig = Pick<
  XYConfig,
  'x' | 'ys' | 'ySlots' | 'source' | 'groups' | 'colorBy' | 'fitTarget' | 'showMeans'
>

export interface XYDataInput {
  ds: Dataset
  xy: XYDataConfig
  /** The workspace's test points and groups */
  ws: Pick<Workspace, 'points' | 'groups'>
  view: RowRange | null
  /** The workspace time base: colour by time and tooltips use it */
  axis: TimeAxis
  /** Build the line arrays (style 'lines' / 'both', or colour by time) */
  lines: boolean
}

interface SourceRange {
  start: number
  end: number
  /** Index into XYEffective.points, -1 when not from a test point */
  pointIndex: number
}

/** The model for the current settings. */
export function buildXYData({ ds, xy, ws, view, axis, lines }: XYDataInput): XYData {
  const effective = effectiveXY(xy, ws, view)
  const x = xy.x ? (channelById(ds, xy.x) ?? null) : null
  const ys: XYChannel[] = []
  const slots = sanitizeSlots(xy.ySlots, xy.ys.length)
  xy.ys.slice(0, MAX_Y).forEach((id, index) => {
    const ch = channelById(ds, id)
    if (ch) ys.push({ ch, index, slot: slots[index] })
  })

  const groupsById = new Map(ws.groups.map((g) => [g.id, g]))
  const series: XYSampleSeries[] = []
  const means: XYMean[] = []
  const base = { x, ys, effective, series, means }

  if (!x || !ys.length) {
    return finish(base, !x ? 'Choose a channel for the X axis.' : 'Choose at least one channel for the Y axis.')
  }
  if (effective.source === 'points' && !effective.points.length) {
    const hidden = ws.points.some((p) => p.hidden && effective.groupIds.includes(p.groupId))
    return finish(
      base,
      hidden
        ? 'Every test point in the chosen groups is hidden. Show some in Test points, or choose other groups.'
        : 'The chosen groups have no test points. Choose other groups, or save test points in Time history.',
    )
  }

  const ranges = sourceRanges(ds, effective, view)
  const byGroup = effective.colorBy === 'group'
  const usedGroups = byGroup
    ? ws.groups.filter((g) => effective.points.some((p) => p.groupId === g.id))
    : []
  const shapeFor = shapeChooser(effective.colorBy, ys.length, usedGroups, ws.groups)
  const t = axis.values

  const units: { group: PointGroup | null; ranges: SourceRange[] }[] = byGroup
    ? usedGroups.map((g) => ({ group: g, ranges: ranges.filter((r) => effective.points[r.pointIndex]?.groupId === g.id) }))
    : [{ group: null, ranges }]

  for (const unit of units) {
    const disjointRanges = disjoint(unit.ranges)
    for (const y of ys) {
      const filled = fillSamples(x.values, y.ch.values, t, disjointRanges, effective.source === 'points', lines)
      const group = unit.group
      series.push({
        key: `${group ? group.id : '*'}|${y.ch.id}`,
        y,
        group,
        slot: group ? group.slot : y.slot,
        shape: shapeFor(group, y),
        name: group ? (ys.length > 1 ? `${group.name} · ${y.ch.meta.short}` : group.name) : channelTitle(y.ch),
        ...filled,
      })
    }
  }

  // Means: one per visible point and Y channel, x and y averaged separately over the point's rows.
  if (effective.source === 'points') {
    effective.points.forEach((point, pointIndex) => {
      const group = groupsById.get(point.groupId) ?? null
      const [start, end] = clampRange(ds.rowCount, point.start, point.end)
      if (end <= start) return
      // Headings averaged across north are unwrapped first (windowStats), like the Test points table.
      const xStats = windowStats(x, ds.elapsed, start, end).stats
      for (const y of ys) {
        const yStats = windowStats(y.ch, ds.elapsed, start, end).stats
        if (xStats.n === 0 || yStats.n === 0) continue
        const unitGroup = byGroup ? group : null
        means.push({
          seriesKey: `${unitGroup ? unitGroup.id : '*'}|${y.ch.id}`,
          point,
          pointIndex,
          group,
          y,
          slot: unitGroup ? unitGroup.slot : y.slot,
          shape: shapeFor(unitGroup, y),
          x: xStats,
          yStats,
          t: t[(start + end - 1) >> 1],
          rows: end - start,
        })
      }
    })
  }

  if (series.every((s) => s.count === 0) && means.length === 0) {
    const where =
      effective.source === 'view' ? 'in the zoom range' : effective.source === 'points' ? 'in the chosen test points' : 'in this file'
    return finish(base, `The chosen channels have no values ${where} (every sample is missing).`)
  }
  return finish(base, '')
}

function finish(base: Pick<XYData, 'x' | 'ys' | 'effective' | 'series' | 'means'>, empty: string): XYData {
  let tMin = Infinity
  let tMax = -Infinity
  let sampleCount = 0
  for (const s of base.series) {
    sampleCount += s.count
    const d = s.data
    for (let i = 2; i < d.length; i += SAMPLE_STRIDE) {
      const v = d[i]
      if (v < tMin) tMin = v
      if (v > tMax) tMax = v
    }
  }
  for (const m of base.means) {
    if (m.t < tMin) tMin = m.t
    if (m.t > tMax) tMax = m.t
  }
  const tRange: [number, number] = tMin <= tMax ? [tMin, tMax] : [NaN, NaN]
  return { ...base, tRange, sampleCount, legend: empty ? [] : legendEntries(base), empty }
}

/** [start, end) clamped to the file. */
function clampRange(rowCount: number, start: number, end: number): [number, number] {
  const s = Math.max(0, Math.min(rowCount, Math.floor(start)))
  const e = Math.max(s, Math.min(rowCount, Math.ceil(end)))
  return [s, e]
}

/** The row ranges of the source, split at time resets and gaps (segments) so lines break there. */
function sourceRanges(ds: Dataset, effective: XYEffective, view: RowRange | null): SourceRange[] {
  if (effective.source === 'points') {
    return effective.points.map((p, pointIndex) => {
      const [start, end] = clampRange(ds.rowCount, p.start, p.end)
      return { start, end, pointIndex }
    })
  }
  const segments = ds.segments.length ? ds.segments : [{ start: 0, end: ds.rowCount }]
  const [lo, hi] = effective.source === 'view' && view ? clampRange(ds.rowCount, view[0], view[1]) : [0, ds.rowCount]
  const out: SourceRange[] = []
  for (const seg of segments) {
    const start = Math.max(lo, seg.start)
    const end = Math.min(hi, seg.end)
    if (end > start) out.push({ start, end, pointIndex: -1 })
  }
  return out
}

/**
 * The ranges in time order with overlaps cut away (a row is plotted once per series even when two test points share
 * it; it belongs to the earlier point).
 */
export function disjoint<T extends { start: number; end: number }>(ranges: readonly T[]): T[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: T[] = []
  let reach = -Infinity
  for (const r of sorted) {
    const start = Math.max(r.start, reach)
    if (r.end > start) out.push({ ...r, start })
    reach = Math.max(reach, r.end)
  }
  return out
}

function fillSamples(
  xv: Float64Array,
  yv: Float64Array,
  tv: Float64Array,
  ranges: readonly SourceRange[],
  withPoints: boolean,
  lines: boolean,
): Pick<XYSampleSeries, 'data' | 'count' | 'lineData' | 'pointIndex'> {
  let count = 0
  for (const r of ranges) {
    for (let i = r.start; i < r.end; i += 1) {
      if (Number.isFinite(xv[i]) && Number.isFinite(yv[i])) count += 1
    }
  }
  const data = new Float32Array(count * SAMPLE_STRIDE)
  const pointIndex = withPoints ? new Int32Array(count) : null
  let k = 0
  for (const r of ranges) {
    for (let i = r.start; i < r.end; i += 1) {
      const xi = xv[i]
      const yi = yv[i]
      if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue
      const o = k * SAMPLE_STRIDE
      data[o] = xi
      data[o + 1] = yi
      data[o + 2] = tv[i]
      data[o + 3] = i
      if (pointIndex) pointIndex[k] = r.pointIndex
      k += 1
    }
  }
  let lineData = new Float32Array(0)
  if (lines && count > 0) {
    let total = 0
    for (const r of ranges) total += r.end - r.start + 1
    lineData = new Float32Array(total * SAMPLE_STRIDE)
    let o = 0
    for (const r of ranges) {
      for (let i = r.start; i < r.end; i += 1) {
        lineData[o] = xv[i]
        lineData[o + 1] = yv[i]
        lineData[o + 2] = tv[i]
        lineData[o + 3] = i
        o += SAMPLE_STRIDE
      }
      // A NaN row breaks the line between ranges.
      lineData.fill(NaN, o, o + SAMPLE_STRIDE)
      o += SAMPLE_STRIDE
    }
  }
  return { data, count, lineData, pointIndex }
}

/**
 * Marker shapes: by Y channel when colour shows something else (groups, time) and there are several Y channels;
 * otherwise by colour entity once there are more than 3 colour classes (colour alone is not enough); else circles.
 */
function shapeChooser(
  colorBy: XYConfig['colorBy'],
  yCount: number,
  usedGroups: readonly PointGroup[],
  allGroups: readonly PointGroup[],
): (group: PointGroup | null, y: XYChannel) => MarkerShape {
  if (colorBy === 'series') {
    return (_group, y) => (yCount > 3 ? MARKER_SHAPES[y.slot % 8] : 'circle')
  }
  if (yCount > 1) return (_group, y) => MARKER_SHAPES[y.slot % 8]
  if (colorBy === 'group' && usedGroups.length > 3) {
    return (group) => MARKER_SHAPES[Math.max(0, allGroups.findIndex((g) => g.id === group?.id)) % 8]
  }
  return () => 'circle'
}

/** Legend: one colour entry per colour entity, and shape entries for the Y channels when shape tells them apart. */
function legendEntries(base: Pick<XYData, 'ys' | 'effective' | 'series'>): XYLegendEntry[] {
  const { ys, effective, series } = base
  const entries: XYLegendEntry[] = []
  if (effective.colorBy === 'series') {
    for (const s of series) entries.push({ key: s.key, name: s.name, kind: 'colour', slot: s.slot, shape: s.shape })
    return entries
  }
  if (effective.colorBy === 'group') {
    const seen = new Set<string>()
    for (const s of series) {
      if (!s.group || seen.has(s.group.id)) continue
      seen.add(s.group.id)
      entries.push({
        key: `g:${s.group.id}`,
        name: s.group.name,
        kind: 'colour',
        slot: s.group.slot,
        shape: ys.length > 1 ? 'circle' : s.shape,
      })
    }
  }
  if (ys.length > 1) {
    for (const y of ys) {
      entries.push({ key: `y:${y.ch.id}`, name: channelTitle(y.ch), kind: 'shape', slot: y.slot, shape: MARKER_SHAPES[y.slot % 8] })
    }
  }
  return entries
}

// ------------------------------------------------------------------ fits

/** A fit that is drawn: a polynomial or a physical model (XYConfig.fit other than 'none'). */
export type FitKind = Exclude<XYConfig['fit'], 'none'>

export interface XYFit {
  key: string
  /** e.g. "Trim points", "Trim points · Elevator", "Elevator [deg]" */
  name: string
  slot: number
  y: XYChannel
  group: PointGroup | null
  kind: FitKind
  /** Polynomial degree (1–3); 0 for a physical model */
  degree: number
  target: XYConfig['fitTarget']
  /** The polynomial fit (kind linear, poly2, poly3), or null */
  fit: PolyFit | null
  /** The physical-model fit (kind power-model, drag-model), or null */
  physical: PhysicalFit | null
  /** Samples left out of the fit because they lie off the axes (see FitWindow) */
  excluded: number
  /** Why there is no fit ('' when there is one) */
  problem: string
  /** The curve over [xMin, xMax] of the fitted data: x, y interleaved */
  curve: number[]
}

/** The axis ranges shown: a fit through the samples keeps to them (samples left off the axes stay out of it). */
export interface FitWindow {
  x: readonly [number, number] | null
  y: readonly [number, number] | null
}

/** Polynomial degree of each fit setting (0: none, or a physical model). */
export const FIT_DEGREE: Record<XYConfig['fit'], number> = {
  none: 0,
  linear: 1,
  poly2: 2,
  poly3: 3,
  'power-model': 0,
  'drag-model': 0,
}
/** Coefficients each fit has (the distinct x values it needs). */
export const FIT_PARAMETERS: Record<XYConfig['fit'], number> = {
  none: 0,
  linear: 2,
  poly2: 3,
  poly3: 4,
  'power-model': 2,
  'drag-model': 2,
}
/** The physical model behind each physical fit setting. */
export const FIT_MODEL: Partial<Record<XYConfig['fit'], PhysicalModel>> = { 'power-model': 'power', 'drag-model': 'drag' }
export const FIT_NAME: Record<XYConfig['fit'], string> = {
  none: 'No fit',
  linear: 'Linear fit',
  poly2: 'Quadratic fit',
  poly3: 'Cubic fit',
  'power-model': 'Power model fit',
  'drag-model': 'Drag model fit',
}

/** Points along a curve (a straight line needs only its ends). */
const CURVE_POINTS = 96

/** The fit's goodness and range, whichever kind it is; null when there is no fit. */
export function fitStats(f: Pick<XYFit, 'fit' | 'physical'>): Pick<PolyFit, 'r2' | 'rmse' | 'n' | 'xMin' | 'xMax'> | null {
  return f.fit ?? f.physical
}

/** The fitted curve's value at x (NaN without a fit). */
export function fitValue(f: Pick<XYFit, 'fit' | 'physical'>, x: number): number {
  if (f.fit) return evalPoly(f.fit.coeffs, x)
  if (f.physical) return physicalValue(f.physical, x)
  return NaN
}

/**
 * One fit per colour entity: per group and Y channel when colouring by group, otherwise per Y channel (all of its
 * samples or means pooled). Through the raw samples (exact values, read back by row; only those inside `within`
 * when given) or the test-point means. A physical model uses only points at positive x (speeds).
 */
export function computeFits(data: XYData, fit: XYConfig['fit'], within: FitWindow | null = null): XYFit[] {
  if (fit === 'none' || data.empty || !data.x) return []
  const kind: FitKind = fit
  const degree = FIT_DEGREE[kind]
  const model = FIT_MODEL[kind] ?? null
  const xValues = data.x.values
  const target = data.effective.fitTarget
  const fits: XYFit[] = []
  for (const s of data.series) {
    let xs: Float64Array
    let ys: Float64Array
    let excluded = 0
    if (target === 'means') {
      const members = data.means.filter((m) => m.seriesKey === s.key)
      xs = Float64Array.from(members, (m) => m.x.mean)
      ys = Float64Array.from(members, (m) => m.yStats.mean)
    } else {
      xs = new Float64Array(s.count)
      ys = new Float64Array(s.count)
      const yValues = s.y.ch.values
      const [x0, x1] = within?.x ?? [-Infinity, Infinity]
      const [y0, y1] = within?.y ?? [-Infinity, Infinity]
      let n = 0
      for (let k = 0; k < s.count; k += 1) {
        const row = s.data[k * SAMPLE_STRIDE + 3]
        const xv = xValues[row]
        const yv = yValues[row]
        if (xv < x0 || xv > x1 || yv < y0 || yv > y1) continue
        xs[n] = xv
        ys[n] = yv
        n += 1
      }
      excluded = s.count - n
      xs = xs.subarray(0, n)
      ys = ys.subarray(0, n)
    }
    const poly = model || !xs.length ? null : polyFit(xs, ys, degree)
    const physical = model && xs.length ? physicalFit(xs, ys, model) : null
    const what = target === 'means' ? 'test-point means' : 'samples'
    const usable = model ? Float64Array.from(xs).filter((v) => v > 0) : xs
    const ok = poly !== null || physical !== null
    fits.push({
      key: s.key,
      name: s.name,
      slot: s.slot,
      y: s.y,
      group: s.group,
      kind,
      degree,
      target,
      fit: poly,
      physical,
      excluded,
      problem: ok
        ? ''
        : usable.length
          ? `Needs ${FIT_PARAMETERS[kind]} or more ${what} with different ${model ? 'positive ' : ''}x values ` +
            `(has ${distinctCount(usable)}).`
          : model && xs.length
            ? `A ${model} model needs ${what} at positive x (speeds).`
            : `No ${what} to fit.`,
      curve: poly ? fitCurve(poly) : physical ? physicalCurve(physical) : [],
    })
  }
  return fits
}

function distinctCount(values: Float64Array): number {
  return new Set(Array.from(values).filter(Number.isFinite)).size
}

/** The fitted polynomial sampled over [xMin, xMax]. */
export function fitCurve(fit: PolyFit): number[] {
  const n = fit.degree <= 1 ? 2 : CURVE_POINTS
  const out: number[] = []
  for (let i = 0; i < n; i += 1) {
    const x = fit.xMin + ((fit.xMax - fit.xMin) * i) / (n - 1)
    out.push(x, evalPoly(fit.coeffs, x))
  }
  return out
}

/** The physical model sampled over [xMin, xMax] (or between any two speeds). */
export function physicalCurve(fit: PhysicalFit, from = fit.xMin, to = fit.xMax): number[] {
  const out: number[] = []
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const x = from + ((to - from) * i) / (CURVE_POINTS - 1)
    out.push(x, physicalValue(fit, x))
  }
  return out
}

// ------------------------------------------------------------------ labels

export interface XYLabels {
  title: string
  x: string
  y: string
}

/**
 * Default title and axis names from the channels: "Elevator vs CL", "CL [-]"; several Y channels in one unit share
 * it ("Thrust 1, Drag [lb]"), mixed units list each title.
 */
export function defaultLabels(x: Channel | null, ys: readonly Channel[]): XYLabels {
  const xName = x ? channelTitle(x) : 'X'
  let yName = 'Y'
  if (ys.length === 1) yName = channelTitle(ys[0])
  else if (ys.length > 1) {
    const units = new Set(ys.map((ch) => ch.meta.unit))
    const [unit] = [...units]
    yName =
      units.size === 1 && unit
        ? `${ys.map((ch) => ch.meta.short).join(', ')} [${unit}]`
        : ys.map((ch) => channelTitle(ch)).join(', ')
  }
  const yShort = ys.length ? ys.map((ch) => ch.meta.short).join(', ') : 'Y'
  const title = x && ys.length ? `${yShort} vs ${x.meta.short}` : ''
  return { title, x: xName, y: yName }
}

/** The user's labels where given, else the defaults. */
export function finalLabels(xy: Pick<XYConfig, 'title' | 'xLabel' | 'yLabel'>, defaults: XYLabels): XYLabels {
  return {
    title: xy.title.trim() || defaults.title,
    x: xy.xLabel.trim() || defaults.x,
    y: xy.yLabel.trim() || defaults.y,
  }
}

/** A warning when the Y channels have different units (they share one axis), else null. */
export function unitMismatch(ys: readonly Channel[]): string | null {
  const byUnit = new Map<string, Channel[]>()
  for (const ch of ys) {
    const list = byUnit.get(ch.meta.unit) ?? []
    list.push(ch)
    byUnit.set(ch.meta.unit, list)
  }
  if (byUnit.size < 2) return null
  const parts = [...byUnit.entries()].map(
    ([unit, chs]) => `${chs.map((ch) => ch.meta.short).join(', ')} ${unit ? `in ${unit}` : 'without a unit'}`,
  )
  return `They share one axis, but the units differ (${parts.join('; ')}). Plot one unit at a time to compare them fairly.`
}
