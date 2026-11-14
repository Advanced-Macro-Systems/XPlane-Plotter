// The X–Y plot's table views and text exports: the fit results (equation, R², n, coefficients ± standard error), range
// and endurance (V_E, V_R and the curve there), the test-point means, and the plotted samples as CSV. Display strings
// use real minus signs; copied TSV and downloaded CSV use plain numbers (ASCII '-', full precision) so spreadsheets
// read them as numbers. Pure.

import { channelTitle } from '../../core/channels'
import { formatFit, formatNumber } from '../../core/analysis/fit'
import { formatPhysical, PHYSICAL_RATIO, type REPoint } from '../../core/analysis/rangeEndurance'
import type { RangeStats } from '../../core/analysis/stats'
import { csvField } from '../../core/export/csv'
import type { Dataset, PointGroup, TestPoint } from '../../core/types'
import { SAMPLE_STRIDE, fitStats, type FitKind, type XYData, type XYFit } from './xyModel'
import type { XYRange } from './xyRange'

const EOL = '\r\n'
const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆']

// ------------------------------------------------------------------ fit results

export interface FitCoefficient {
  /** "slope", "intercept", "c₂ (x²)" ..., "A (V³)", "B (1/V)" */
  name: string
  /** The power of x the coefficient multiplies (A of the power model: 3, its B: −1) */
  power: number
  value: number
  se: number
}

export interface FitRow {
  key: string
  name: string
  /** A test-point group's fit (its name is the group's), not a channel's */
  grouped: boolean
  /** The fitted Y channel's title ("Elevator [deg]") */
  yTitle: string
  slot: number
  /** The fit, or why there is none */
  problem: string
  /** "elev = −3.01·CL + 1.23" (without the R²/n note: they have their own columns) */
  equation: string
  r2: number
  rmse: number
  n: number
  degree: number
  kind: FitKind
  target: XYFit['target']
  /** Samples left out because they lie off the axes */
  excluded: number
  /** Highest power first */
  coefficients: FitCoefficient[]
}

function coefficientName(power: number, degree: number): string {
  if (degree === 1) return power === 1 ? 'slope' : 'intercept'
  if (power === 0) return `c${SUBSCRIPT[0]}`
  return `c${SUBSCRIPT[power] ?? power} (x${power === 1 ? '' : power === 2 ? '²' : '³'})`
}

/** One row per fit, named with the channels' short names ("KIAS", "Elevator"). */
export function fitRows(data: XYData, fits: readonly XYFit[]): FitRow[] {
  const xShort = data.x?.meta.short ?? 'x'
  return fits.map((f) => {
    const base = {
      key: f.key,
      name: f.name,
      grouped: f.group !== null,
      yTitle: channelTitle(f.y.ch),
      slot: f.slot,
      degree: f.degree,
      kind: f.kind,
      target: f.target,
      excluded: f.excluded,
    }
    const stripStats = (text: string) => text.replace(/\s+\(R² = [^)]*\)$/, '')
    if (f.physical) {
      const fit = f.physical
      const power = fit.model === 'power'
      const equation = stripStats(formatPhysical(fit, xShort, f.y.ch.meta.short))
      const coefficients: FitCoefficient[] = [
        { name: power ? 'A (V³)' : 'A (V²)', power: power ? 3 : 2, value: fit.a, se: fit.aSe },
        { name: power ? 'B (1/V)' : 'B (1/V²)', power: power ? -1 : -2, value: fit.b, se: fit.bSe },
      ]
      return { ...base, problem: '', equation, r2: fit.r2, rmse: fit.rmse, n: fit.n, coefficients }
    }
    if (!f.fit) {
      return { ...base, problem: f.problem, equation: '', r2: NaN, rmse: NaN, n: 0, coefficients: [] }
    }
    const fit = f.fit
    const equation = stripStats(formatFit(fit, xShort, f.y.ch.meta.short))
    const coefficients: FitCoefficient[] = []
    for (let power = fit.coeffs.length - 1; power >= 0; power -= 1) {
      coefficients.push({ name: coefficientName(power, fit.degree), power, value: fit.coeffs[power], se: fit.stderr[power] })
    }
    return { ...base, problem: '', equation, r2: fit.r2, rmse: fit.rmse, n: fit.n, coefficients }
  })
}

/** The fit's name in a table or a TSV: "linear" ... "cubic", "power model", "drag model". */
export function fitKindName(kind: FitKind): string {
  const names: Record<FitKind, string> = {
    linear: 'linear',
    poly2: 'quadratic',
    poly3: 'cubic',
    'power-model': 'power model',
    'drag-model': 'drag model',
  }
  return names[kind]
}

/**
 * The text of a fit's chip under the plot. With several fits each says whose it is, so the colour dot is never the only
 * clue: a group's fit starts with the group ("Trim points: δe = …"; a channel's equation already starts with the
 * channel), and a fit that could not be made names the one that failed ("Trim points: Needs 2 or more …").
 */
export function equationText(row: Pick<FitRow, 'name' | 'grouped' | 'equation' | 'problem'>, several: boolean): string {
  if (row.problem) return several ? `${row.name}: ${row.problem}` : row.problem
  return several && row.grouped ? `${row.name}: ${row.equation}` : row.equation
}

/** A spreadsheet number: shortest round-trip digits with an ASCII minus; '' for NaN/∞. */
export function plainNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : ''
}

/** A text cell: quoted when needed, defused when a spreadsheet would read it as a formula, ASCII minus signs. */
export function textCell(text: string, delimiter: string): string {
  const plain = text.replace(/−/g, '-')
  return csvField(/^[=+\-@\t\r]/.test(plain) ? `'${plain}` : plain, delimiter)
}

/**
 * Fit results as TSV: one line per fit, every coefficient and its standard error as plain numbers (c0, c1 ... for a
 * polynomial; A and B for a physical model: the fits of one plot are all of one kind).
 */
export function fitTableTsv(data: XYData, rows: readonly FitRow[]): string {
  const t = '\t'
  const physical = rows.some((r) => r.kind === 'power-model' || r.kind === 'drag-model')
  const maxDegree = rows.reduce((m, r) => Math.max(m, r.degree), 1)
  // left_out: samples off the axes (absurd values) that the fit did not use.
  const header = ['series', 'x', 'y', 'fit', 'through', 'equation', 'r2', 'rmse', 'n', 'left_out']
  if (physical) header.push('A', 'A_se', 'B', 'B_se')
  else for (let p = 0; p <= maxDegree; p += 1) header.push(`c${p}`, `c${p}_se`)
  const xTitle = data.x ? channelTitle(data.x) : ''
  const lines = [header.join(t)]
  for (const r of rows) {
    const cells = [
      textCell(r.name, t),
      textCell(xTitle, t),
      textCell(r.yTitle, t),
      fitKindName(r.kind),
      r.target,
      textCell(r.problem || r.equation, t),
      plainNumber(r.r2),
      plainNumber(r.rmse),
      r.n ? String(r.n) : '',
      String(r.excluded),
    ]
    if (physical) {
      // A (the positive power) first, then B; a row without a fit gets empty cells.
      const ordered = [...r.coefficients].sort((a, b) => b.power - a.power)
      for (let k = 0; k < 2; k += 1) cells.push(ordered[k] ? plainNumber(ordered[k].value) : '', ordered[k] ? plainNumber(ordered[k].se) : '')
    } else {
      for (let p = 0; p <= maxDegree; p += 1) {
        const c = r.coefficients.find((k) => k.power === p)
        cells.push(c ? plainNumber(c.value) : '', c ? plainNumber(c.se) : '')
      }
    }
    lines.push(cells.join(t))
  }
  return lines.join(EOL) + EOL
}

// ------------------------------------------------------------------ range and endurance

export interface RangeRow {
  key: string
  /** The fit's name (its group or Y channel) */
  name: string
  slot: number
  /** The Y channel's title ("Power 1 [hp]") */
  yTitle: string
  xUnit: string
  yUnit: string
  kind: FitKind
  target: XYFit['target']
  /** The fit's equation, without the R²/n note */
  equation: string
  r2: number
  n: number
  /** Maximum endurance (the minimum) and maximum range (the origin tangent), or null */
  endurance: REPoint | null
  range: REPoint | null
  /** y/V at V_R: the tangent's slope */
  slope: number
  /** V_R / V_E */
  ratio: number
  /** 3^¼ for a physical model (fixed by the model), null for a polynomial */
  modelRatio: number | null
  /** Extrapolation warnings, and why a point is missing */
  notes: string[]
}

/** The extrapolation warning for a point outside the fitted speeds, or ''. */
function extrapolationNote(what: 'V_E' | 'V_R', p: REPoint | null, xMin: number, xMax: number, unit: string): string {
  if (!p?.extrapolated) return ''
  const u = unit ? ` ${unit}` : ''
  return p.v < xMin
    ? `${what} is extrapolated: below the slowest point fitted (${formatNumber(xMin)}${u}).`
    : `${what} is extrapolated: above the fastest point fitted (${formatNumber(xMax)}${u}).`
}

/** One row per fit with range and endurance results. */
export function rangeRows(data: XYData, results: readonly XYRange[]): RangeRow[] {
  const equations = new Map(fitRows(data, results.map((r) => r.fit)).map((row) => [row.key, row]))
  const xUnit = data.x?.meta.unit ?? ''
  return results.map(({ key, fit, re }) => {
    const stats = fitStats(fit)
    const xMin = stats?.xMin ?? NaN
    const xMax = stats?.xMax ?? NaN
    const notes = [
      extrapolationNote('V_E', re.endurance, xMin, xMax, xUnit),
      extrapolationNote('V_R', re.range, xMin, xMax, xUnit),
      re.enduranceNote,
      re.rangeNote !== re.enduranceNote ? re.rangeNote : '',
    ].filter(Boolean)
    return {
      key,
      name: fit.name,
      slot: fit.slot,
      yTitle: channelTitle(fit.y.ch),
      xUnit,
      yUnit: fit.y.ch.meta.unit,
      kind: fit.kind,
      target: fit.target,
      equation: equations.get(key)?.equation ?? '',
      r2: stats?.r2 ?? NaN,
      n: stats?.n ?? 0,
      endurance: re.endurance,
      range: re.range,
      slope: re.slope,
      ratio: re.ratio,
      modelRatio: fit.physical ? PHYSICAL_RATIO : null,
      notes,
    }
  })
}

/** Range and endurance as TSV: one line per fit, plain numbers, the units in columns of their own. */
export function rangeTableTsv(data: XYData, rows: readonly RangeRow[]): string {
  const t = '\t'
  const header = [
    'series',
    'x',
    'y',
    'x_unit',
    'y_unit',
    'fit',
    'through',
    'V_E',
    'y_at_V_E',
    'V_R',
    'y_at_V_R',
    'y_over_V_at_V_R',
    'V_R_over_V_E',
    'model_V_R_over_V_E',
    'V_E_extrapolated',
    'V_R_extrapolated',
    'equation',
    'r2',
    'n',
    'notes',
  ]
  const xTitle = data.x ? channelTitle(data.x) : ''
  const flag = (p: REPoint | null) => (p ? (p.extrapolated ? 'yes' : 'no') : '')
  const lines = [header.join(t)]
  for (const r of rows) {
    lines.push(
      [
        textCell(r.name, t),
        textCell(xTitle, t),
        textCell(r.yTitle, t),
        textCell(r.xUnit, t),
        textCell(r.yUnit, t),
        fitKindName(r.kind),
        r.target,
        plainNumber(r.endurance?.v ?? NaN),
        plainNumber(r.endurance?.y ?? NaN),
        plainNumber(r.range?.v ?? NaN),
        plainNumber(r.range?.y ?? NaN),
        plainNumber(r.slope),
        plainNumber(r.ratio),
        plainNumber(r.modelRatio ?? NaN),
        flag(r.endurance),
        flag(r.range),
        textCell(r.equation, t),
        plainNumber(r.r2),
        r.n ? String(r.n) : '',
        textCell(r.notes.join(' '), t),
      ].join(t),
    )
  }
  return lines.join(EOL) + EOL
}

// ------------------------------------------------------------------ test-point means

export interface MeanRow {
  point: TestPoint
  group: PointGroup | null
  rows: number
  x: RangeStats
  /** One per Y channel of the model (null where the point has no value of it) */
  ys: (RangeStats | null)[]
}

/** One row per plotted test point (in workspace order), with mean ± σ of x and of every Y channel. */
export function meanRows(data: XYData): MeanRow[] {
  const byPoint = new Map<number, MeanRow>()
  for (const m of data.means) {
    let row = byPoint.get(m.pointIndex)
    if (!row) {
      row = { point: m.point, group: m.group, rows: m.rows, x: m.x, ys: data.ys.map(() => null) }
      byPoint.set(m.pointIndex, row)
    }
    const yAt = data.ys.findIndex((y) => y.ch.id === m.y.ch.id)
    if (yAt >= 0) row.ys[yAt] = m.yStats
  }
  return [...byPoint.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row)
}

/** The means table as TSV (plain numbers): point, group, rows, x mean & σ, then mean & σ of each Y channel. */
export function meansTableTsv(data: XYData, rows: readonly MeanRow[]): string {
  const t = '\t'
  const xTitle = data.x ? channelTitle(data.x) : 'x'
  const header = ['point', 'group', 'rows', `${xTitle} mean`, `${xTitle} sd`]
  for (const y of data.ys) header.push(`${channelTitle(y.ch)} mean`, `${channelTitle(y.ch)} sd`)
  const lines = [header.map((h) => textCell(h, t)).join(t)]
  for (const r of rows) {
    const cells = [textCell(r.point.name, t), textCell(r.group?.name ?? '', t), String(r.rows), plainNumber(r.x.mean), plainNumber(r.x.std)]
    for (const s of r.ys) cells.push(s ? plainNumber(s.mean) : '', s ? plainNumber(s.std) : '')
    lines.push(cells.join(t))
  }
  return lines.join(EOL) + EOL
}

// ------------------------------------------------------------------ plotted samples

/**
 * Every plotted sample as CSV: series, Y channel, test point, row (0-based), elapsed_s, then x and y at full precision
 * (read back from the channels, not the Float32 drawing copy). '' when nothing is plotted.
 */
export function samplesCsv(ds: Dataset, data: XYData): string {
  if (!data.x || data.sampleCount === 0) return ''
  const d = ','
  const xValues = data.x.values
  const header = ['series', 'y_channel', 'point', 'row', 'elapsed_s', `x: ${channelTitle(data.x)}`, 'y']
  const lines = [header.map((h) => textCell(h, d)).join(d)]
  const pointNames = data.effective.points.map((p) => textCell(p.name, d))
  for (const s of data.series) {
    const name = textCell(s.name, d)
    const yName = textCell(channelTitle(s.y.ch), d)
    const yValues = s.y.ch.values
    for (let k = 0; k < s.count; k += 1) {
      const row = s.data[k * SAMPLE_STRIDE + 3]
      const point = s.pointIndex ? (pointNames[s.pointIndex[k]] ?? '') : ''
      lines.push(
        [name, yName, point, String(row), plainNumber(ds.elapsed[row]), plainNumber(xValues[row]), plainNumber(yValues[row])].join(d),
      )
    }
  }
  return lines.join(EOL) + EOL
}
