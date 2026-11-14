// Pointer maths for the X–Y plot: the nearest sample or test-point mean to the pointer (measured in screen pixels,
// so a dense cloud of 3 px dots can still be hovered), the zoom box, and the tooltip HTML. Pure: the view converts
// pixels to data once per pointer move and hands the scales in.

import { formatNumber, tooltipHeader, tooltipRow } from '../../charts/format'
import { formatMeanSd } from '../points/pointsModel'
import { SAMPLE_STRIDE, type XYMean, type XYSampleSeries } from './xyModel'

/** Data units per screen pixel along each axis (y is usually negative: pixels grow downwards). */
export interface PixelScale {
  /** Data coordinates under the pointer */
  x: number
  y: number
  /** Data units per pixel to the right / downwards */
  ux: number
  uy: number
}

/** How far (px) the pointer may be from a sample, and from a mean marker, for it to count as hovered. */
export const SAMPLE_REACH_PX = 24
export const MEAN_REACH_PX = 14

export interface SampleHit {
  kind: 'sample'
  /** Index into XYData.series */
  series: number
  /** Sample index within the series */
  index: number
  /** Offset of the sample from the pointer, px */
  dx: number
  dy: number
}

export interface MeanHit {
  kind: 'mean'
  /** Index into XYData.means */
  mean: number
  dx: number
  dy: number
}

export type Hit = SampleHit | MeanHit

function validScale(scale: PixelScale): boolean {
  return Number.isFinite(scale.x) && Number.isFinite(scale.y) && Math.abs(scale.ux) > 0 && Math.abs(scale.uy) > 0
}

/** The sample nearest the pointer within `reachPx` (screen distance), or null. Linear scan, early-out on x. */
export function nearestSample(
  series: readonly Pick<XYSampleSeries, 'data'>[],
  scale: PixelScale,
  reachPx = SAMPLE_REACH_PX,
): SampleHit | null {
  if (!validScale(scale)) return null
  const { x, y, ux, uy } = scale
  let best = reachPx * reachPx
  let hit: SampleHit | null = null
  for (let s = 0; s < series.length; s += 1) {
    const d = series[s].data
    for (let i = 0; i < d.length; i += SAMPLE_STRIDE) {
      const dx = (d[i] - x) / ux
      if (dx > reachPx || dx < -reachPx) continue
      const dy = (d[i + 1] - y) / uy
      const d2 = dx * dx + dy * dy
      if (d2 <= best) {
        best = d2
        hit = { kind: 'sample', series: s, index: i / SAMPLE_STRIDE, dx, dy }
      }
    }
  }
  return hit
}

/** The test-point mean nearest the pointer within `reachPx`, or null. */
export function nearestMean(means: readonly Pick<XYMean, 'x' | 'yStats'>[], scale: PixelScale, reachPx = MEAN_REACH_PX): MeanHit | null {
  if (!validScale(scale)) return null
  let best = reachPx * reachPx
  let hit: MeanHit | null = null
  means.forEach((m, i) => {
    const dx = (m.x.mean - scale.x) / scale.ux
    const dy = (m.yStats.mean - scale.y) / scale.uy
    const d2 = dx * dx + dy * dy
    if (d2 <= best) {
      best = d2
      hit = { kind: 'mean', mean: i, dx, dy }
    }
  })
  return hit
}

/** What the pointer is on: a mean marker wins over the samples under it. */
export function hitTest(
  data: { series: readonly Pick<XYSampleSeries, 'data'>[]; means: readonly Pick<XYMean, 'x' | 'yStats'>[] },
  scale: PixelScale,
  opts: { samples: boolean; means: boolean },
): Hit | null {
  const mean = opts.means ? nearestMean(data.means, scale) : null
  if (mean) return mean
  return opts.samples ? nearestSample(data.series, scale) : null
}

// ------------------------------------------------------------------ zoom box

export interface PixelBox {
  left: number
  top: number
  width: number
  height: number
}

/** The box spanned by two pointer positions; null when it is too small to mean a zoom (a click). */
export function pixelBox(from: readonly number[], to: readonly number[], minPx = 6): PixelBox | null {
  const left = Math.min(from[0], to[0])
  const top = Math.min(from[1], to[1])
  const width = Math.abs(to[0] - from[0])
  const height = Math.abs(to[1] - from[1])
  if (!(width >= minPx && height >= minPx)) return null
  return { left, top, width, height }
}

/** Axis value ranges [low, high] for the data coordinates of two opposite corners of a zoom box. */
export function boxRanges(a: readonly number[], b: readonly number[]): { x: [number, number]; y: [number, number] } | null {
  const values = [a[0], a[1], b[0], b[1]]
  if (!values.every(Number.isFinite)) return null
  const x: [number, number] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const y: [number, number] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  if (!(x[1] > x[0]) || !(y[1] > y[0])) return null
  return { x, y }
}

// ------------------------------------------------------------------ tooltips (HTML: every text is escaped)

export interface SampleTip {
  color: string
  /** The series name (Y channel title, or group name) */
  series: string
  xTitle: string
  yTitle: string
  x: number
  y: number
  /** The time of the sample as the time axis prints it */
  time: string
  /** Test point the sample belongs to ('' when not from a test point) */
  point: string
}

/** A sample: the series and time on top, then y (strong) and x. */
export function sampleTooltipHtml(tip: SampleTip): string {
  const header = [tip.point, tip.time].filter(Boolean).join(' · ')
  return (
    tooltipHeader(header || tip.series) +
    tooltipRow(tip.color, tip.yTitle, formatNumber(tip.y)) +
    tooltipRow('transparent', tip.xTitle, formatNumber(tip.x))
  )
}

export interface MeanTip {
  color: string
  point: string
  group: string
  xTitle: string
  yTitle: string
  x: { mean: number; std: number }
  y: { mean: number; std: number }
  rows: number
}

/** A test-point mean: the point and group on top, then mean ± σ of y (strong) and x, and the row count. */
export function meanTooltipHtml(tip: MeanTip): string {
  return (
    tooltipHeader(tip.group ? `${tip.point} · ${tip.group}` : tip.point) +
    tooltipRow(tip.color, `${tip.yTitle}, mean ± 1σ`, meanSd(tip.y)) +
    tooltipRow('transparent', `${tip.xTitle}, mean ± 1σ`, meanSd(tip.x)) +
    tooltipRow('transparent', 'rows in the test point', String(tip.rows))
  )
}

/** Mean ± σ to matching decimals (σ to 2 significant figures), as the tables print it. */
function meanSd(stats: { mean: number; std: number }): string {
  const text = formatMeanSd(stats.mean, stats.std)
  return text.sd ? `${text.mean} ± ${text.sd}` : text.mean
}
