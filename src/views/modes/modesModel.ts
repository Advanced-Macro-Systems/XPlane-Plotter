// Pure logic of the Dynamic modes tab: which rows to analyse, the window's time/value series, running the fit, the
// result tiles, the plain-language reading of the result, the quick picks, and the text for copying and CSV export.
// No React here (unit-tested in node).

import { MISSING, formatNumber } from '../../charts/format'
import type { ModesPlotInput } from '../../charts/options/modes'
import type { OscillationFit } from '../../core/analysis/modes'
import { channelById } from '../../core/dataset'
import type { Channel, Dataset, ModesConfig, RowRange, TestPoint } from '../../core/types'
import type { ModeDetrend, ModeFit, ModeModel } from './modeFit'

// The fit itself (it runs in a worker, see useModeFit.ts).
export { oscillationR2, runModeFit, type ModeDetrend, type ModeFit, type ModeModel } from './modeFit'
export type ModeSource = ModesConfig['source']
export type SourceKind = 'selection' | 'view' | 'point'

export function sourceKind(source: ModeSource): SourceKind {
  return source === 'selection' || source === 'view' ? source : 'point'
}

/** The test-point id of a `point:<id>` source, else null. */
export function sourcePointId(source: ModeSource): string | null {
  return source.startsWith('point:') ? source.slice('point:'.length) : null
}

// ------------------------------------------------------------------------------------------------ rows to analyse

export type RowsProblem = 'no-selection' | 'no-zoom' | 'no-point'

export interface ModeRows {
  /** Half-open [start, end) rows to fit, or null when the source has none */
  rows: RowRange | null
  problem: RowsProblem | null
  /** The test point, when the source is one that exists */
  point: TestPoint | null
}

export interface RowsContext {
  selection: RowRange | null
  /** Time-history zoom (null = whole file) */
  view: RowRange | null
  points: readonly TestPoint[]
  rowCount: number
  /** With the 'view' source and no zoom: fit the whole file instead of asking for a zoom */
  wholeFile?: boolean
}

function clampRows(range: RowRange, rowCount: number): RowRange | null {
  const start = Math.max(0, Math.min(rowCount, Math.floor(Math.min(range[0], range[1]))))
  const end = Math.max(0, Math.min(rowCount, Math.ceil(Math.max(range[0], range[1]))))
  return end > start ? [start, end] : null
}

/**
 * The rows a mode source refers to. The zoom range "no zoom" is the whole file, which is never a mode window, so it
 * counts as missing unless `wholeFile` asks for it.
 */
export function resolveModeRows(source: ModeSource, ctx: RowsContext): ModeRows {
  const none = (problem: RowsProblem): ModeRows => ({ rows: null, problem, point: null })
  switch (sourceKind(source)) {
    case 'selection': {
      const rows = ctx.selection ? clampRows(ctx.selection, ctx.rowCount) : null
      return rows ? { rows, problem: null, point: null } : none('no-selection')
    }
    case 'view': {
      const range = ctx.view ?? (ctx.wholeFile ? ([0, ctx.rowCount] as const) : null)
      const rows = range ? clampRows(range, ctx.rowCount) : null
      return rows ? { rows, problem: null, point: null } : none('no-zoom')
    }
    case 'point': {
      const id = sourcePointId(source)
      const point = ctx.points.find((p) => p.id === id) ?? null
      const rows = point ? clampRows([point.start, point.end], ctx.rowCount) : null
      return point && rows ? { rows, problem: null, point } : none('no-point')
    }
  }
}

// ------------------------------------------------------------------------------------------------ the window

export interface WindowSeries {
  rows: RowRange
  /** Seconds since the window's first row, from Dataset.elapsed (sim time, resets and gaps collapsed) */
  t: Float64Array
  y: Float64Array
  /** Dataset.elapsed at the first row (s) */
  t0: number
  durationS: number
  /** Samples with a value */
  finite: number
}

/** Time (s from the first row, from ds.elapsed — never the hour clocks) and values of a channel over `rows`. */
export function windowSeries(ds: Dataset, values: Float64Array, rows: RowRange): WindowSeries {
  const [start, end] = rows
  const n = Math.max(0, end - start)
  const t = new Float64Array(n)
  const y = new Float64Array(n)
  const t0 = n > 0 ? ds.elapsed[start] : Number.NaN
  let finite = 0
  for (let k = 0; k < n; k += 1) {
    t[k] = ds.elapsed[start + k] - t0
    const v = values[start + k]
    y[k] = v
    if (Number.isFinite(v)) finite += 1
  }
  return { rows: [start, end], t, y, t0, durationS: n > 0 ? t[n - 1] : 0, finite }
}

/** True when the rows straddle a time reset or recording gap (elapsed time is collapsed there). */
export function crossesSegment(ds: Dataset, rows: RowRange): boolean {
  return ds.segments.some((s) => s.start > rows[0] && s.start < rows[1])
}

// ------------------------------------------------------------------------------------------------ fitting

/** Equilibrium ± decaying amplitude of an oscillation fit at each t (null when the fit has no parameters). */
export function oscillationEnvelope(
  t: Float64Array,
  fit: OscillationFit,
): { upper: Float64Array; lower: Float64Array } | null {
  const { amplitude, sigma, offset, slope, t0 } = fit
  if (![amplitude, sigma, offset, slope, t0].every(Number.isFinite)) return null
  const upper = new Float64Array(t.length)
  const lower = new Float64Array(t.length)
  for (let k = 0; k < t.length; k += 1) {
    const x = t[k] - t0
    const trend = offset + slope * x
    const swing = amplitude * Math.exp(-sigma * x)
    upper[k] = trend + swing
    lower[k] = trend - swing
  }
  return { upper, lower }
}

/** y − fitted (NaN where either is missing). */
export function residuals(y: Float64Array, fitted: Float64Array): Float64Array {
  const out = new Float64Array(y.length)
  for (let k = 0; k < y.length; k += 1) out[k] = y[k] - fitted[k]
  return out
}

// ------------------------------------------------------------------------------------------------ drawing long windows

/** Most samples per line the chart draws: a longer window (a whole file) is thinned for drawing only. */
export const PLOT_MAX_POINTS = 4096

/**
 * Which samples of a long window to draw: all of them up to `max` (null); else the first and the last, and in each of
 * about max/3 equal runs its lowest and highest value (in time order) and its first missing sample, so the peaks, the
 * band of noise and the gaps look as they do with every sample.
 */
export function plotIndices(y: ArrayLike<number>, max = PLOT_MAX_POINTS): Uint32Array | null {
  const n = y.length
  if (n <= max) return null
  const runs = Math.max(1, Math.floor((max - 2) / 3))
  const keep: number[] = [0]
  for (let r = 0; r < runs; r += 1) {
    const from = Math.floor((r * n) / runs)
    const to = Math.floor(((r + 1) * n) / runs)
    let lo = -1
    let hi = -1
    let gap = -1
    for (let i = from; i < to; i += 1) {
      const v = y[i]
      if (!Number.isFinite(v)) {
        if (gap < 0) gap = i
        continue
      }
      if (lo < 0 || v < y[lo]) lo = i
      if (hi < 0 || v > y[hi]) hi = i
    }
    const picked = [lo, hi, gap].filter((i) => i > 0 && i < n - 1).sort((a, b) => a - b)
    for (const i of picked) if (i !== keep[keep.length - 1]) keep.push(i)
  }
  keep.push(n - 1)
  return Uint32Array.from(keep)
}

/**
 * The chart's input with a long window thinned (plotIndices), so drawing stays quick; the fit, the peaks, the CSV and
 * the MATLAB export keep every sample.
 */
export function thinPlotInput(input: ModesPlotInput, max = PLOT_MAX_POINTS): ModesPlotInput {
  const keep = plotIndices(input.y, max)
  if (!keep) return input
  const pick = (values: Float64Array) => Float64Array.from(keep, (i) => values[i])
  return {
    ...input,
    t: pick(input.t),
    y: pick(input.y),
    fitted: input.fitted ? pick(input.fitted) : null,
    envelope: input.envelope ? { upper: pick(input.envelope.upper), lower: pick(input.envelope.lower) } : null,
  }
}

/** The fitted curve when it has any finite value. */
export function fittedCurve(result: ModeFit): Float64Array | null {
  const fitted = result.fit.fitted
  for (let k = 0; k < fitted.length; k += 1) if (Number.isFinite(fitted[k])) return fitted
  return null
}

// ------------------------------------------------------------------------------------------------ peaks table

export interface PeakRow {
  /** 1-based, in time order */
  n: number
  kind: 'max' | 'min'
  /** Seconds since the window start */
  t: number
  /** Dataset.elapsed (s) */
  elapsed: number
  /** The raw sample */
  value: number
  /** |value − fitted equilibrium| at that time */
  amplitude: number
  /** ln(previous / this amplitude) against the previous peak of the same kind (one cycle earlier); NaN for the first */
  decrement: number
}

/** The turning points of an oscillation fit, with the amplitudes behind the logarithmic-decrement cross-check. */
export function peakRows(fit: OscillationFit, t0Elapsed: number): PeakRow[] {
  const last: Partial<Record<'max' | 'min', number>> = {}
  return fit.peaks.map((p, i) => {
    const x = p.t - fit.t0
    const amplitude = Math.abs(p.value - (fit.offset + fit.slope * x))
    const previous = last[p.kind]
    last[p.kind] = amplitude
    return {
      n: i + 1,
      kind: p.kind,
      t: p.t,
      elapsed: t0Elapsed + p.t,
      value: p.value,
      amplitude,
      decrement: previous !== undefined && amplitude > 0 && previous > 0 ? Math.log(previous / amplitude) : Number.NaN,
    }
  })
}

/** The one-line summary under a figure's title. */
export function figureSubtitle(result: ModeFit): string {
  if (!result.fit.ok) return 'No accepted fit'
  if (result.model === 'oscillation') {
    const f = result.fit
    const r2 =
      result.detrend === 'linear' ? `R² (trend removed) = ${fmt(result.r2Oscillation, 4)}` : `R² = ${fmt(f.r2, 4)}`
    return `Td = ${fmt(f.periodS)} s · ζ = ${fmt(f.zeta)} · ωn = ${fmt(f.omegaN)} rad/s · ${r2}`
  }
  const f = result.fit
  const half = f.tau < 0 ? `t2 = ${fmt(-f.halfLifeS)} s` : `t½ = ${fmt(f.halfLifeS)} s`
  return `τ = ${fmt(f.tau)} s · ${half} · R² = ${fmt(f.r2, 4)}`
}

// ------------------------------------------------------------------------------------------------ result tiles

export interface ResultTile {
  key: string
  label: string
  /** Display text (typographic minus), '—' when unknown */
  value: string
  unit: string
  foot?: string
}

const fmt = (value: number, significant = 3): string => formatNumber(value, significant)

/** "−0.0066 ± 0.108i" — the eigenvalue pair of an oscillation (1/s). */
export function eigenvalueText(sigma: number, omegaD: number): string {
  if (!Number.isFinite(sigma) || !Number.isFinite(omegaD)) return MISSING
  return `${fmt(-sigma)} ± ${fmt(omegaD)}i`
}

/**
 * Stat tiles for a fit. A rejected fit (ok false) shows every value as '—' (its numbers would mislead) while keeping
 * the same tiles, so the layout does not jump. `unit` is the channel's unit (for the first-order final value).
 */
export function resultTiles(result: ModeFit, unit: string): ResultTile[] {
  const shown = result.fit.ok
  const value = (v: number, significant = 3) => (shown ? fmt(v, significant) : MISSING)
  if (result.model === 'oscillation') {
    const f = result.fit
    const growing = shown && f.sigma < 0
    return [
      {
        key: 'period',
        label: 'Period Td',
        value: value(f.periodS),
        unit: 's',
        foot: shown ? `${fmt(1 / f.periodS)} Hz` : 'Damped period 2π / ωd',
      },
      {
        key: 'zeta',
        label: 'Damping ratio ζ',
        value: value(f.zeta),
        unit: '',
        foot: shown ? `σ = ${fmt(f.sigma)} 1/s` : 'ζ = σ / ωn',
      },
      {
        key: 'omegaN',
        label: 'Natural frequency ωn',
        value: value(f.omegaN),
        unit: 'rad/s',
        foot: shown ? `λ = ${eigenvalueText(f.sigma, f.omegaD)}` : 'ωn = √(σ² + ωd²)',
      },
      {
        key: 'omegaD',
        label: 'Damped frequency ωd',
        value: value(f.omegaD),
        unit: 'rad/s',
        foot: 'ωd = 2π / Td',
      },
      {
        key: 'half',
        label: growing ? 'Time to double' : 'Time to half amplitude',
        value: value(growing ? -f.halfLifeS : f.halfLifeS),
        unit: 's',
        foot: growing ? 'Growing: ln 2 / |σ|' : 'ln 2 / σ',
      },
      {
        key: 'cycles',
        label: 'Cycles in window',
        value: value(f.cycles, 2),
        unit: '',
        foot: shown && f.cycles < 2 ? (diedOut(f) ? 'It has died out by the end' : 'Two or more are firmer') : 'Of the fitted period',
      },
      // The R² the fit is judged by ("explains N%"): with a linear trend, the share of what the trend leaves.
      result.detrend === 'linear'
        ? {
            key: 'r2',
            label: 'R² (trend removed)',
            value: value(result.r2Oscillation, 4),
            unit: '',
            foot: shown ? `With the trend ${fmt(f.r2, 4)}` : 'Of what the trend leaves',
          }
        : { key: 'r2', label: 'R²', value: value(f.r2, 4), unit: '', foot: 'Variance explained' },
      {
        key: 'zetaLogDec',
        label: 'ζ from log decrement',
        value: shown && Number.isFinite(f.zetaLogDec) ? fmt(f.zetaLogDec) : MISSING,
        unit: '',
        foot: shown && !Number.isFinite(f.zetaLogDec) ? 'Not enough peaks' : 'Cross-check',
      },
    ]
  }
  const f = result.fit
  const divergent = shown && f.tau < 0
  return [
    {
      key: 'tau',
      label: 'Time constant τ',
      value: value(f.tau),
      unit: 's',
      foot: shown ? (divergent ? 'Negative: the response grows' : `λ = ${fmt(-1 / f.tau)} 1/s`) : 'y = c + A·e^(−t/τ)',
    },
    {
      key: 'half',
      label: divergent ? 'Time to double' : 'Time to half',
      value: value(divergent ? -f.halfLifeS : f.halfLifeS),
      unit: 's',
      foot: divergent ? '|τ| · ln 2' : 'τ · ln 2',
    },
    { key: 'r2', label: 'R²', value: value(f.r2, 4), unit: '', foot: 'Variance explained' },
    {
      key: 'final',
      label: divergent ? 'Offset c' : 'Settles at',
      value: value(f.offset, 4),
      unit,
      foot: shown ? `A = ${fmt(f.amplitude)}${unit ? ` ${unit}` : ''}` : 'Final value c',
    },
  ]
}

// ------------------------------------------------------------------------------------------------ interpretation

export type ChannelFamily = 'speed-height' | 'pitch' | 'short-period' | 'lateral' | 'roll-rate' | 'bank' | null

/** Which kind of motion a channel shows (from its X-Plane token), to name the mode a result looks like. */
export function channelFamily(ch: Pick<Channel, 'token'> | undefined): ChannelFamily {
  const token = ch?.token ?? ''
  if (!token) return null
  if (/^____P,/.test(token) || /^_Pdot,/.test(token)) return 'roll-rate'
  if (/^_roll,/.test(token)) return 'bank'
  if (/^(_beta,|____R,|_slip,|hding,|Gload,_side|_Rdot,|hpath,)/.test(token)) return 'lateral'
  if (/^(alpha,|____Q,|Gload,norml|_Qdot,)/.test(token)) return 'short-period'
  if (/^pitch,/.test(token)) return 'pitch'
  if (/^(_Vind,|Vtrue,|_Mach,|__VVI,|p-alt,|vpath,|___CG,ftMSL|toten,)/.test(token)) return 'speed-height'
  return null
}

export interface Interpretation {
  tone: 'good' | 'neutral' | 'danger'
  text: string
}

function dampingWords(zeta: number): string {
  if (zeta < 0.1) return 'lightly damped'
  if (zeta < 0.3) return 'moderately damped'
  if (zeta < 0.7) return 'well damped'
  return 'heavily damped'
}

/**
 * The mode an oscillation looks like, from the kind of channel and the usual period and damping of each mode
 * (nothing is claimed for channels of unknown kind).
 */
function typicalOscillation(family: ChannelFamily, periodS: number, zeta: number): string | null {
  const longitudinalSlow = family === 'speed-height' || family === 'pitch'
  const longitudinalFast = family === 'short-period' || family === 'pitch'
  const lateral = family === 'lateral' || family === 'roll-rate' || family === 'bank'
  if (longitudinalSlow && periodS >= 15 && zeta < 0.2) return 'a phugoid'
  if (longitudinalFast && periodS < 10 && zeta >= 0.2 && zeta <= 0.9) return 'a short period'
  if (lateral && periodS < 20 && zeta < 0.5) return 'a dutch roll'
  return null
}

/** The fitted oscillation decays below a tenth of its first amplitude within the window: it holds the whole response. */
function diedOut(fit: Pick<OscillationFit, 'sigma' | 'cycles' | 'periodS'>): boolean {
  return fit.sigma * fit.cycles * fit.periodS >= Math.LN10
}

/**
 * Why an accepted oscillation fit is still too doubtful to name a mode: fewer than two cycles while the oscillation is
 * still going at the end of the window (a well-damped short period dies out within about one cycle: that is the whole
 * response, not too little of it), ζ from the log decrement far from the fitted ζ, or notes on the fit (fair fit,
 * solver stopped early...). Empty when it is sound.
 */
export function oscillationDoubts(fit: OscillationFit): string[] {
  const doubts: string[] = []
  if (fit.cycles < 2 && !diedOut(fit)) doubts.push(`only ${fmt(fit.cycles, 2)} cycles`)
  if (Number.isFinite(fit.zetaLogDec) && Math.abs(fit.zetaLogDec - fit.zeta) > 0.5 * Math.abs(fit.zeta)) {
    doubts.push(`the log decrement gives ζ = ${fmt(fit.zetaLogDec, 2)}`)
  }
  if (fit.message && doubts.length === 0) doubts.push('see the note')
  return doubts
}

/** One plain-language sentence about a successful fit (null when the fit was rejected). */
export function interpretFit(result: ModeFit, ch: Pick<Channel, 'token'> | undefined): Interpretation | null {
  if (!result.fit.ok) return null
  const family = channelFamily(ch)
  if (result.model === 'oscillation') {
    const f = result.fit
    if (!(Number.isFinite(f.zeta) && Number.isFinite(f.periodS))) return null
    const zeta = `ζ = ${fmt(f.zeta, 2)}`
    // A doubtful fit (few cycles, a fair fit, or one its own cross-check disagrees with) never names a mode or shows
    // green: it says what to check instead.
    const doubts = oscillationDoubts(f)
    const check = doubts.length ? ` (${doubts.join('; ')}) — check the window` : ''
    if (f.sigma < 0) {
      return doubts.length
        ? { tone: 'neutral', text: `${zeta} — the fitted oscillation grows${check}.` }
        : {
            tone: 'danger',
            text: `${zeta} — unstable: the oscillation grows, doubling its amplitude every ${fmt(-f.halfLifeS, 2)} s.`,
          }
    }
    const typical = doubts.length ? null : typicalOscillation(family, f.periodS, f.zeta)
    return {
      tone: typical ? 'good' : 'neutral',
      text: `${zeta} — ${dampingWords(f.zeta)}${typical ? `, typical of ${typical}` : ''}${check}.`,
    }
  }
  const f = result.fit
  if (!Number.isFinite(f.tau)) return null
  if (f.tau < 0) {
    const spiral = family === 'bank' || family === 'lateral'
    return {
      tone: 'danger',
      text:
        `τ = ${fmt(f.tau, 2)} s — divergent: the response doubles every ${fmt(-f.halfLifeS, 2)} s` +
        `${spiral ? ', an unstable spiral' : ''}.`,
    }
  }
  const mode =
    family === 'roll-rate' && f.tau < 5
      ? ', typical of roll subsidence'
      : family === 'bank' || family === 'lateral'
        ? ', a convergent (stable) spiral'
        : ''
  return {
    tone: mode ? 'good' : 'neutral',
    text: `τ = ${fmt(f.tau, 2)} s — the response halves every ${fmt(f.halfLifeS, 2)} s${mode}.`,
  }
}

// ------------------------------------------------------------------------------------------------ quick picks

export interface ModePreset {
  id: 'phugoid' | 'short-period' | 'dutch-roll' | 'roll-subsidence' | 'spiral'
  label: string
  model: ModeModel
  /** Channel ids (header tokens) in order of preference */
  channels: readonly string[]
  hint: string
}

export const MODE_PRESETS: readonly ModePreset[] = [
  {
    id: 'phugoid',
    label: 'Phugoid',
    model: 'oscillation',
    channels: ['Vtrue,_ktas', '_Vind,_kias', 'pitch,__deg'],
    hint: 'Slow speed–height exchange after a pulse: true airspeed (else KIAS, else pitch), oscillation model.',
  },
  {
    id: 'short-period',
    label: 'Short period',
    model: 'oscillation',
    channels: ['alpha,__deg', '____Q,deg/s'],
    hint: 'Quick pitch response to an elevator doublet: angle of attack (else pitch rate), oscillation model.',
  },
  {
    id: 'dutch-roll',
    label: 'Dutch roll',
    model: 'oscillation',
    channels: ['____R,deg/s', '_beta,__deg'],
    hint: 'Yaw–roll oscillation after a rudder doublet: yaw rate (else sideslip), oscillation model.',
  },
  {
    id: 'roll-subsidence',
    label: 'Roll subsidence',
    model: 'first-order',
    channels: ['____P,deg/s'],
    hint: 'Roll rate dying away after an aileron step is released: roll rate, first-order model.',
  },
  {
    id: 'spiral',
    label: 'Spiral',
    model: 'first-order',
    channels: ['_roll,__deg'],
    hint: 'Slow bank-angle convergence or divergence with hands off: bank angle, first-order model.',
  },
]

/** The first of the preset's channels that this dataset has (looked up by id), or null. */
export function presetChannel(ds: Dataset, preset: ModePreset): string | null {
  return preset.channels.find((id) => channelById(ds, id) !== undefined) ?? null
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * When the mode window already comes from a test point, the test point named after the preset (e.g. "Dutch roll"),
 * so a quick pick also moves to that manoeuvre's window. Null when the source is not a point or nothing matches.
 */
export function presetPoint(points: readonly TestPoint[], preset: ModePreset, source: ModeSource): `point:${string}` | null {
  if (sourceKind(source) !== 'point') return null
  const target = words(preset.label)
  const match = points.find((p) => words(p.name).includes(target))
  return match ? `point:${match.id}` : null
}

/** The quick pick a test point is named after ("Short period", "dutch roll 2"), or null: the inverse of presetPoint. */
export function presetForPoint(name: string): ModePreset | null {
  const text = words(name)
  return MODE_PRESETS.find((preset) => text.includes(words(preset.label))) ?? null
}

/**
 * What choosing a test point as the window changes: the source, and, when the point is named after a mode and this log
 * has that quick pick's channel, its channel and model too (one update), so "Short period" is fitted on α with the
 * oscillation model rather than on whatever channel the last fit used.
 */
export function modesForPoint(ds: Dataset, point: Pick<TestPoint, 'id' | 'name'>): Partial<ModesConfig> {
  const source: ModeSource = `point:${point.id}`
  const preset = presetForPoint(point.name)
  const channelId = preset ? presetChannel(ds, preset) : null
  return preset && channelId ? { source, channelId, model: preset.model } : { source }
}

/**
 * Whether a quick pick shows as on: the channel and model are its own, and the window is not a test point named after
 * another mode (the Phugoid pick stays off while "Short period" is analysed on its airspeed).
 */
export function presetActive(
  ds: Dataset,
  preset: ModePreset,
  modes: Pick<ModesConfig, 'channelId' | 'model' | 'source'>,
  points: readonly TestPoint[],
): boolean {
  const id = presetChannel(ds, preset)
  if (!id || id !== modes.channelId || preset.model !== modes.model) return false
  const pointId = sourcePointId(modes.source)
  const point = pointId ? points.find((p) => p.id === pointId) : undefined
  const named = point ? presetForPoint(point.name) : null
  return !named || named.id === preset.id
}

// ------------------------------------------------------------------------------------------------ copy and CSV

/** A number as plain text for spreadsheets: ASCII minus, up to 7 significant figures, '' when missing. */
export function plainNumber(value: number, significant = 7): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(significant))) : ''
}

/**
 * Text cell for TSV: tabs and line breaks become spaces, and text a spreadsheet would run as a formula (=, +, −, @
 * first) gets a leading apostrophe, as in every other CSV / TSV the app writes.
 */
function tsvText(text: string): string {
  const flat = text.replace(/[\t\r\n]+/g, ' ').trim()
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat
}

export interface ResultsContext {
  dataset: string
  channel: string
  window: string
  rows: RowRange
  /** Dataset.elapsed at the first row (s) */
  t0: number
  durationS: number
  detrend: ModeDetrend
}

/** Results as tab-separated "quantity, value, unit" lines with plain numbers (for pasting into a spreadsheet). */
export function resultsTsv(result: ModeFit, ctx: ResultsContext): string {
  const lines: string[][] = [
    ['quantity', 'value', 'unit'],
    ['dataset', tsvText(ctx.dataset), ''],
    ['channel', tsvText(ctx.channel), ''],
    ['window', tsvText(ctx.window), ''],
    ['first row (0-based)', String(ctx.rows[0]), ''],
    ['end row (exclusive)', String(ctx.rows[1]), ''],
    ['window start (elapsed)', plainNumber(ctx.t0), 's'],
    ['window length', plainNumber(ctx.durationS), 's'],
    ['model', result.model, ''],
  ]
  if (result.model === 'oscillation') {
    const o = result.fit
    lines.push(
      ['detrend', ctx.detrend, ''],
      ['fit accepted', o.ok ? '1' : '0', ''],
      ['period Td', plainNumber(o.periodS), 's'],
      ['damping ratio zeta', plainNumber(o.zeta), ''],
      ['natural frequency wn', plainNumber(o.omegaN), 'rad/s'],
      ['damped frequency wd', plainNumber(o.omegaD), 'rad/s'],
      ['decay rate sigma', plainNumber(o.sigma), '1/s'],
      [o.sigma < 0 ? 'time to double' : 'time to half amplitude', plainNumber(Math.abs(o.halfLifeS)), 's'],
      ['cycles in window', plainNumber(o.cycles), ''],
      ...(result.detrend === 'linear'
        ? [
            ['R2 (trend removed)', plainNumber(result.r2Oscillation), ''],
            ['R2 (with trend)', plainNumber(o.r2), ''],
          ]
        : [['R2', plainNumber(o.r2), '']]),
      ['zeta from log decrement', plainNumber(o.zetaLogDec), ''],
      ['amplitude A', plainNumber(o.amplitude), ''],
      ['offset c', plainNumber(o.offset), ''],
      ['slope b', plainNumber(o.slope), '1/s'],
      ['peaks found', String(o.peaks.length), ''],
    )
  } else {
    const o = result.fit
    lines.push(
      ['fit accepted', o.ok ? '1' : '0', ''],
      ['time constant tau', plainNumber(o.tau), 's'],
      [o.tau < 0 ? 'time to double' : 'time to half', plainNumber(Math.abs(o.halfLifeS)), 's'],
      ['R2', plainNumber(o.r2), ''],
      ['offset c', plainNumber(o.offset), ''],
      ['amplitude A', plainNumber(o.amplitude), ''],
    )
  }
  if (result.fit.message) lines.push(['note', tsvText(result.fit.message), ''])
  return lines.map((cells) => cells.join('\t')).join('\r\n') + '\r\n'
}

/** A CSV header cell: quoted when needed, and defused when a spreadsheet would read it as a formula. */
function csvHeader(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * The window as CSV (the table behind the chart): time since the window start, elapsed time, the value, the fit, the
 * residual and (oscillation) the envelope. Plain numbers, empty cells for missing values, CRLF line ends.
 */
export function fitCsv(
  series: WindowSeries,
  result: ModeFit | null,
  title: string,
  envelope: { upper: Float64Array; lower: Float64Array } | null,
): string {
  const fitted = result ? fittedCurve(result) : null
  const header = ['t_s', 'elapsed_s', title, 'fit', 'residual']
  if (envelope) header.push('envelope_upper', 'envelope_lower')
  const lines = [header.map(csvHeader).join(',')]
  const cell = (v: number) => (Number.isFinite(v) ? String(v) : '')
  for (let k = 0; k < series.t.length; k += 1) {
    const fit = fitted ? fitted[k] : Number.NaN
    const row = [cell(series.t[k]), cell(series.t0 + series.t[k]), cell(series.y[k]), cell(fit), cell(series.y[k] - fit)]
    if (envelope) row.push(cell(envelope.upper[k]), cell(envelope.lower[k]))
    lines.push(row.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
