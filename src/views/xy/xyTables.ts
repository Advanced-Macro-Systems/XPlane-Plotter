// The X–Y plot's table views and text exports: the fit results (equation, R², n, coefficients ± standard error), the
// test-point means, and the plotted samples as CSV. Display strings use real minus signs; copied TSV and downloaded
// CSV use plain numbers (ASCII '-', full precision) so spreadsheets read them as numbers. Pure.

import { channelTitle } from '../../core/channels'
import { formatFit } from '../../core/analysis/fit'
import type { RangeStats } from '../../core/analysis/stats'
import { csvField } from '../../core/export/csv'
import type { Dataset, PointGroup, TestPoint } from '../../core/types'
import { SAMPLE_STRIDE, type XYData, type XYFit } from './xyModel'

const EOL = '\r\n'
const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆']

// ------------------------------------------------------------------ fit results

export interface FitCoefficient {
  /** "slope", "intercept", "c₂ (x²)" ... */
  name: string
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
      target: f.target,
      excluded: f.excluded,
    }
    if (!f.fit) {
      return { ...base, problem: f.problem, equation: '', r2: NaN, rmse: NaN, n: 0, coefficients: [] }
    }
    const fit = f.fit
    const equation = formatFit(fit, xShort, f.y.ch.meta.short).replace(/\s+\(R² = [^)]*\)$/, '')
    const coefficients: FitCoefficient[] = []
    for (let power = fit.coeffs.length - 1; power >= 0; power -= 1) {
      coefficients.push({ name: coefficientName(power, fit.degree), power, value: fit.coeffs[power], se: fit.stderr[power] })
    }
    return { ...base, problem: '', equation, r2: fit.r2, rmse: fit.rmse, n: fit.n, coefficients }
  })
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

/** Fit results as TSV: one line per fit, every coefficient and its standard error as plain numbers. */
export function fitTableTsv(data: XYData, rows: readonly FitRow[]): string {
  const t = '\t'
  const maxDegree = rows.reduce((m, r) => Math.max(m, r.degree), 1)
  // left_out: samples off the axes (absurd values) that the fit did not use.
  const header = ['series', 'x', 'y', 'fit', 'through', 'equation', 'r2', 'rmse', 'n', 'left_out']
  for (let p = 0; p <= maxDegree; p += 1) header.push(`c${p}`, `c${p}_se`)
  const xTitle = data.x ? channelTitle(data.x) : ''
  const lines = [header.join(t)]
  for (const r of rows) {
    const cells = [
      textCell(r.name, t),
      textCell(xTitle, t),
      textCell(r.yTitle, t),
      ['', 'linear', 'quadratic', 'cubic'][r.degree] ?? `degree ${r.degree}`,
      r.target,
      textCell(r.problem || r.equation, t),
      plainNumber(r.r2),
      plainNumber(r.rmse),
      r.n ? String(r.n) : '',
      String(r.excluded),
    ]
    for (let p = 0; p <= maxDegree; p += 1) {
      const c = r.coefficients.find((k) => k.power === p)
      cells.push(c ? plainNumber(c.value) : '', c ? plainNumber(c.se) : '')
    }
    lines.push(cells.join(t))
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
