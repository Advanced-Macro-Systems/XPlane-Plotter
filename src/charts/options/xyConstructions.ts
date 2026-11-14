// The range and endurance constructions of the X–Y plot (views/xy/xyRange.ts), drawn like the classic hand-drawn
// figure: for each fit, its minimum (maximum endurance) with a vertical guide down to the x axis and a horizontal guide
// across the plot, and the tangent from the origin (maximum range) running a little past the point where it touches,
// with a vertical guide at V_R; a marker at both points, the fitted curve extended (dashed) to a point outside the
// fitted speeds, and a short label beside each marker in ink colour, placed where it covers the fewest data.
//
// Labels are placed for the plotting area as it is drawn: its size in pixels and the part of the axes it shows (a
// zoom window). The screen measures both on the chart; an exported figure estimates its size and keeps its zoom; tests
// use a nominal size. Each label tries a few spots, best first: beside its marker on the upper left (like the
// hand-drawn figure), then the other sides, then above or below the marker (ending at it, centred on it or starting at
// it; moved sideways to stay inside), each in up to three forms: one line, " (extrapolated)" on a second line, and the
// short "V_E = 72 kt". Every try is scored by the data points, curves, guide lines, markers and earlier labels it would
// cover and by leaving the plot; a label that fits nowhere is moved inside as far as it can be. ECharts does not clip
// series labels to the grid, so this is what keeps them inside it. When both constructions are in ink (the data use
// their colours), the V_R guide is dash-dot. Pure.

import type { XYData, XYFit } from '../../views/xy/xyModel'
import { fitStats, fitValue, SAMPLE_STRIDE } from '../../views/xy/xyModel'
import {
  CONSTRUCTION_NAME,
  EXTRAPOLATED,
  constructionLabel,
  constructionSlots,
  dataSlots,
  type Construction,
  type ConstructionLabel,
  type ConstructionSlots,
  type XYRange,
} from '../../views/xy/xyRange'
import type { REPoint } from '../../core/analysis/rangeEndurance'
import { seriesColor, type ChartTheme } from '../theme'

/** Nominal size of the plotting area (px) the label layout assumes when it is not given (tests). */
export const LAYOUT_SIZE = { width: 820, height: 460 }
/** The tangent from the origin runs this share past the tangent point. */
export const TANGENT_PAST = 0.4
/**
 * Line patterns (px): the guides are dashed; when both constructions are drawn in ink (constructionSlots) the V_R guide
 * is dash-dot, so the line styles tell them apart (MATLAB: '--' and '-.').
 */
const DASHED = [4, 3]
const DASH_DOT = [8, 3, 1.5, 3]
/** Construction markers: 9 px across, with a 2 px ring in the surface colour. */
const MARKER_SIZE = 9
const LABEL_GAP = 5
/** Label text: the line height, and the label box's padding around the text (px). */
const LINE_HEIGHT = 16
const PAD_X = 4
const PAD_Y = 2
/** Average width of a character of the label text, in ems (Geist), and the subscript's size beside it. */
const CHAR_EM = 0.55
const SUB_SCALE = 0.75

export type LabelSide = 'left' | 'right' | 'top' | 'bottom'
/** Where a label above or below its marker sits sideways: ending at the marker (to its left), centred, or starting at it. */
type LabelAlign = 'end' | 'middle' | 'start'
/**
 * Spots tried for each label, best first: the side of the marker, a vertical offset in label heights (−1 = one up)
 * and, above and below the marker, the label's place sideways; those move sideways to stay inside the plot.
 */
const SPOTS: readonly (readonly [LabelSide, number, LabelAlign?])[] = [
  ['left', -1],
  ['left', -2],
  ['right', 1],
  ['right', -1],
  ['left', 1],
  ['right', 2],
  ['left', -3],
  ['right', -2],
  ['left', 2],
  ['right', 3],
  ['right', -3],
  ['left', 3],
  ['top', 0, 'end'],
  ['bottom', 0, 'start'],
  ['top', 0, 'middle'],
  ['bottom', 0, 'middle'],
  ['top', 0, 'start'],
  ['bottom', 0, 'end'],
  ['top', -1, 'end'],
  ['top', -1, 'middle'],
  ['bottom', 1, 'middle'],
]
/** Label forms, best first, with the score each costs: the full words win unless they would cover data or not fit. */
type FormKind = 'line' | 'wrapped' | 'short'
const FORM_COST: Record<FormKind, number> = { line: 0, wrapped: 2, short: 12 }
/** Scores of what a label covers: the plot's edge, an earlier label, a line, a mean or construction marker. */
const OUTSIDE = 500
const ON_LABEL = 1000
const ON_LINE = 6
const ON_MARKER = 8
/** At most this many samples count as obstacles (evenly picked). */
const MAX_SAMPLE_OBSTACLES = 1500

export interface ConstructionInput {
  results: readonly XYRange[]
  data: XYData
  /** The axis ranges in force (the constructions need them: guides start at the axes) */
  x: readonly [number, number]
  y: readonly [number, number]
  /** The part of the axes shown (a zoom window) for the label layout; default the whole ranges */
  view?: { x: readonly [number, number]; y: readonly [number, number] } | null
  /** The samples are drawn (they count as obstacles for the labels) */
  showSamples: boolean
  /** The colour each fit's curve is drawn in */
  fitColor: (fit: XYFit) => string
  /** Size of the plotting area in pixels, for the label layout (default LAYOUT_SIZE) */
  size?: { width: number; height: number } | null
  /** The constructions' colour slots (null = neutral ink); default constructionSlots of the data's slots */
  slots?: ConstructionSlots
}

export interface PlacedLabel {
  /** The label's text, its lines joined by '\n' */
  text: string
  side: LabelSide
  /** Offset from the spot (px): sideways to stay inside, and in label heights up or down */
  dx: number
  dy: number
  form: FormKind
  /** The label's box in the plotting area's pixels (0, 0 = its top left) */
  box: Box
}

export interface ConstructionOutput {
  series: Record<string, unknown>[]
  /** Legend names of the constructions drawn (for an exported figure's legend) */
  legend: string[]
  /** The labels as placed, for tests and descriptions */
  labels: PlacedLabel[]
}

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

type Segment = readonly [number, number, number, number]

/** The points of a result that lie inside the axes' x range (both are drawn only there). */
function drawnPoints(r: XYRange, x: readonly [number, number]): { endurance: REPoint | null; range: REPoint | null } {
  const inside = (p: REPoint | null) => (p && p.v >= x[0] && p.v <= x[1] ? p : null)
  return { endurance: inside(r.re.endurance), range: inside(r.re.range) }
}

/** true when some result has a construction to draw inside the x range. */
export function hasConstructions(results: readonly XYRange[], x: readonly [number, number] | null): boolean {
  return results.some((r) => {
    const p = x ? drawnPoints(r, x) : r.re
    return p.endurance !== null || p.range !== null
  })
}

/** Legend names of the constructions drawn inside the x range, in legend order. */
export function constructionLegend(results: readonly XYRange[], x: readonly [number, number]): string[] {
  const drawn = results.map((r) => drawnPoints(r, x))
  return (['endurance', 'range'] as const).filter((kind) => drawn.some((d) => d[kind] !== null)).map((kind) => CONSTRUCTION_NAME[kind])
}

/** Escapes text for an ECharts rich-text formatter ("{style|text}"): braces become parentheses. */
function richText(text: string): string {
  return text.replace(/\{/g, '(').replace(/\}/g, ')')
}

function segmentHitsBox([x1, y1, x2, y2]: Segment, b: Box): boolean {
  // Liang–Barsky clipping of the segment against the box.
  const dx = x2 - x1
  const dy = y2 - y1
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, x1 - b.left],
    [dx, b.right - x1],
    [-dy, y1 - b.top],
    [dy, b.bottom - y1],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return t0 <= t1
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** The shift (px) that brings [lo, hi] inside [0, limit]; one wider than the limit starts at 0. */
function shiftInside(lo: number, hi: number, limit: number): number {
  if (lo < 0) return -lo
  if (hi > limit) return Math.max(limit - hi, -lo)
  return 0
}

/** One way to write a label: its rich-text lines, plain text and size in pixels. */
interface LabelForm {
  kind: FormKind
  formatter: string
  text: string
  width: number
  height: number
}

/** The forms a label can take, best first: one line; " (extrapolated)" on a line of its own; the short "V_E = 72 kt". */
function labelForms(label: ConstructionLabel, fontSize: number): LabelForm[] {
  const em = CHAR_EM * fontSize
  /** A line as runs of [text, subscript?]. */
  const form = (kind: FormKind, lines: (readonly [string, boolean])[][]): LabelForm => ({
    kind,
    formatter: lines.map((runs) => runs.map(([text, sub]) => `{${sub ? 's' : 't'}|${richText(text)}}`).join('')).join('\n'),
    text: lines.map((runs) => runs.map(([text, sub]) => (sub ? `_${text}` : text)).join('')).join('\n'),
    width:
      Math.max(...lines.map((runs) => runs.reduce((w, [text, sub]) => w + text.length * em * (sub ? SUB_SCALE : 1), 0))) +
      2 * PAD_X,
    height: lines.length * LINE_HEIGHT + 2 * PAD_Y,
  })
  const note: (readonly [string, boolean])[] = [[EXTRAPOLATED, false]]
  const forms = [form('line', [[[label.lead, false], [label.sub, true], [label.tail, false]]])]
  if (label.extrapolated) {
    forms.push(form('wrapped', [[[label.lead, false], [label.sub, true], [label.value, false]], note]))
  }
  const short: (readonly [string, boolean])[] = [[label.short, false], [label.sub, true], [label.value, false]]
  forms.push(form('short', label.extrapolated ? [short, note] : [short]))
  return forms
}

/** The construction series and their legend names. Draws nothing for results without points inside the x range. */
export function constructionSeries(input: ConstructionInput, theme: ChartTheme): ConstructionOutput {
  const { results, data, x, y } = input
  const series: Record<string, unknown>[] = []
  const labels: PlacedLabel[] = []
  const legend = new Set<string>()
  const drawn = results
    .map((r) => ({ r, ...drawnPoints(r, x) }))
    .filter((d) => d.endurance !== null || d.range !== null)
  if (!drawn.length || !(x[1] > x[0]) || !(y[1] > y[0])) return { series, legend: [], labels }

  const size = input.size && input.size.width > 0 && input.size.height > 0 ? input.size : LAYOUT_SIZE
  const { width: W, height: H } = size
  const view = input.view && input.view.x[1] > input.view.x[0] && input.view.y[1] > input.view.y[0] ? input.view : { x, y }
  const px = (v: number) => ((v - view.x[0]) / (view.x[1] - view.x[0])) * W
  const py = (v: number) => H - ((v - view.y[0]) / (view.y[1] - view.y[0])) * H
  const slots = input.slots ?? constructionSlots(dataSlots(data))
  const colorOf = (kind: Construction) => {
    const slot = slots[kind]
    return slot === null ? theme.text : seriesColor(theme, slot)
  }
  const colors: Record<Construction, string> = { endurance: colorOf('endurance'), range: colorOf('range') }
  const rangeGuide = slots.endurance === null && slots.range === null ? DASH_DOT : DASHED
  const xUnit = data.x?.meta.unit ?? ''
  const several = drawn.length > 1

  type Pattern = 'solid' | readonly number[]
  const line = (id: string, name: string | undefined, points: number[][], color: string, z: number, pattern: Pattern, width: number) => ({
    id,
    ...(name ? { name } : {}),
    type: 'line',
    data: points,
    showSymbol: false,
    symbol: 'none',
    silent: true,
    legendHoverLink: false,
    emphasis: { disabled: true },
    lineStyle: { width, color, type: pattern, cap: 'butt' },
    itemStyle: { color },
    clip: true,
    z,
  })

  // Obstacles for the labels, in layout pixels: means, construction markers, samples, curves; guide lines as segments.
  const points: { x: number; y: number; weight: number }[] = []
  if (data.effective.showMeans) for (const m of data.means) points.push({ x: px(m.x.mean), y: py(m.yStats.mean), weight: ON_MARKER })
  for (const { endurance, range } of drawn) {
    for (const p of [endurance, range]) if (p) points.push({ x: px(p.v), y: py(p.y), weight: ON_MARKER })
  }
  if (input.showSamples) {
    let total = 0
    for (const s of data.series) total += s.count
    const step = Math.max(1, Math.ceil(total / MAX_SAMPLE_OBSTACLES))
    let k = 0
    for (const s of data.series) {
      for (let i = 0; i < s.count; i += 1, k += 1) {
        if (k % step === 0) points.push({ x: px(s.data[i * SAMPLE_STRIDE]), y: py(s.data[i * SAMPLE_STRIDE + 1]), weight: 1 })
      }
    }
  }
  const segments: Segment[] = []

  for (const { r, endurance, range } of drawn) {
    const fit = r.fit
    const stats = fitStats(fit)
    const fitColor = input.fitColor(fit)
    for (let i = 0; i + 3 < fit.curve.length; i += 2) {
      segments.push([px(fit.curve[i]), py(fit.curve[i + 1]), px(fit.curve[i + 2]), py(fit.curve[i + 3])])
    }

    // The fitted curve carried on (dashed) to a point outside the fitted speeds.
    if (stats) {
      const speeds = [endurance?.v, range?.v].filter((v): v is number => v !== undefined)
      const below = Math.min(...speeds)
      const above = Math.max(...speeds)
      const extension = (from: number, to: number, side: string) => {
        const pts: number[][] = []
        for (let i = 0; i <= 24; i += 1) {
          const v = from + ((to - from) * i) / 24
          pts.push([v, fitValue(fit, v)])
        }
        for (let i = 0; i + 1 < pts.length; i += 1) segments.push([px(pts[i][0]), py(pts[i][1]), px(pts[i + 1][0]), py(pts[i + 1][1])])
        series.push(line(`re-ext-${side}:${r.key}`, undefined, pts, fitColor, 4, DASHED, 1.5))
      }
      if (below < stats.xMin) extension(below, stats.xMin, 'low')
      if (above > stats.xMax) extension(stats.xMax, above, 'high')
    }

    if (endurance) {
      const name = CONSTRUCTION_NAME.endurance
      legend.add(name)
      const vertical = [[endurance.v, y[0]], [endurance.v, endurance.y]]
      const across = [[x[0], endurance.y], [x[1], endurance.y]]
      series.push(line(`re-e-v:${r.key}`, name, vertical, colors.endurance, 1, DASHED, 1.25))
      series.push(line(`re-e-h:${r.key}`, name, across, colors.endurance, 1, DASHED, 1.25))
      segments.push([px(endurance.v), py(y[0]), px(endurance.v), py(endurance.y)], [px(x[0]), py(endurance.y), px(x[1]), py(endurance.y)])
    }
    if (range) {
      const name = CONSTRUCTION_NAME.range
      legend.add(name)
      const slope = range.y / range.v
      const end = Math.min(x[1], range.v * (1 + TANGENT_PAST))
      series.push(line(`re-r-t:${r.key}`, name, [[0, 0], [end, slope * end]], colors.range, 3, 'solid', 1.5))
      series.push(line(`re-r-v:${r.key}`, name, [[range.v, y[0]], [range.v, range.y]], colors.range, 1, rangeGuide, 1.25))
      segments.push([px(0), py(0), px(end), py(slope * end)], [px(range.v), py(y[0]), px(range.v), py(range.y)])
    }
  }

  // Markers with their labels, placed one after another (each avoids the ones before it).
  const placed: Box[] = []
  const outside = (b: Box) => b.left < 0 || b.right > W || b.top < 0 || b.bottom > H
  for (const { r, endurance, range } of drawn) {
    const items: Record<string, unknown>[] = []
    for (const [kind, p] of [
      ['endurance', endurance],
      ['range', range],
    ] as const) {
      if (!p) continue
      const item = {
        value: [p.v, p.y],
        itemStyle: { color: colors[kind], borderColor: theme.surface, borderWidth: 2, opacity: 1 },
      }
      const ax = px(p.v)
      const ay = py(p.y)
      // A marker zoomed out of view is not drawn, and neither is its label.
      if (!(ax >= 0 && ax <= W && ay >= 0 && ay <= H)) {
        items.push(item)
        continue
      }
      const forms = labelForms(constructionLabel(kind, p, xUnit, several ? r.fit.name : undefined), theme.fontSize)
      const near = MARKER_SIZE / 2 + LABEL_GAP
      let chosen: { form: LabelForm; side: LabelSide; dx: number; dy: number; box: Box; score: number } | null = null
      for (const form of forms) {
        for (let rank = 0; rank < SPOTS.length; rank += 1) {
          const [side, steps, align = 'middle'] = SPOTS[rank]
          const dy = steps * (form.height - 1)
          let dx = 0
          let box: Box
          if (side === 'left' || side === 'right') {
            const left = side === 'left' ? ax - near - form.width : ax + near
            box = { left, right: left + form.width, top: ay + dy - form.height / 2, bottom: ay + dy + form.height / 2 }
          } else {
            // ECharts centres a label above or below its marker: dx moves it to its place sideways, then inside the plot.
            const centred = ax - form.width / 2
            const wanted = align === 'end' ? ax - form.width : align === 'start' ? ax : centred
            const left = wanted + shiftInside(wanted, wanted + form.width, W)
            dx = left - centred
            const top = side === 'top' ? ay - near + dy - form.height : ay + near + dy
            box = { left, right: left + form.width, top, bottom: top + form.height }
          }
          let score = FORM_COST[form.kind] + rank * 0.01
          if (outside(box)) score += OUTSIDE
          for (const other of placed) if (overlaps(box, other)) score += ON_LABEL
          const padded = { left: box.left - 2, right: box.right + 2, top: box.top - 2, bottom: box.bottom + 2 }
          for (const o of points) {
            if (o.x >= padded.left && o.x <= padded.right && o.y >= padded.top && o.y <= padded.bottom) score += o.weight
          }
          for (const s of segments) if (segmentHitsBox(s, box)) score += ON_LINE
          if (!chosen || score < chosen.score) chosen = { form, side, dx, dy, box, score }
        }
      }
      if (!chosen) {
        items.push(item)
        continue
      }
      // Nowhere fits: move the label inside the plot as far as it goes.
      if (outside(chosen.box)) {
        const sx = shiftInside(chosen.box.left, chosen.box.right, W)
        const sy = shiftInside(chosen.box.top, chosen.box.bottom, H)
        chosen.dx += sx
        chosen.dy += sy
        chosen.box = { left: chosen.box.left + sx, right: chosen.box.right + sx, top: chosen.box.top + sy, bottom: chosen.box.bottom + sy }
      }
      placed.push(chosen.box)
      labels.push({ text: chosen.form.text, side: chosen.side, dx: chosen.dx, dy: chosen.dy, form: chosen.form.kind, box: chosen.box })
      items.push({
        ...item,
        label: {
          show: true,
          position: chosen.side,
          distance: LABEL_GAP,
          offset: [chosen.dx, chosen.dy],
          formatter: chosen.form.formatter,
          backgroundColor: theme.surface,
          padding: [PAD_Y, PAD_X],
          borderRadius: 3,
          rich: {
            t: { color: theme.text, fontFamily: theme.font, fontSize: theme.fontSize, lineHeight: LINE_HEIGHT, verticalAlign: 'middle' },
            s: { color: theme.text, fontFamily: theme.font, fontSize: theme.fontSize - 3, lineHeight: LINE_HEIGHT, verticalAlign: 'bottom' },
          },
        },
      })
    }
    series.push({
      id: `re-pts:${r.key}`,
      type: 'scatter',
      data: items,
      symbol: 'circle',
      symbolSize: MARKER_SIZE,
      silent: true,
      legendHoverLink: false,
      emphasis: { disabled: true },
      // Opaque (ECharts draws scatter points at 0.8 by default): the lines behind must not show through.
      itemStyle: { opacity: 1 },
      clip: true,
      z: 6,
    })
  }
  return { series, legend: [...legend], labels }
}
