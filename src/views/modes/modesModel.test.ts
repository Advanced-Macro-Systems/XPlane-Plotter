import { describe, expect, it } from 'vitest'
import { MINUS } from '../../charts/format'
import { fileChannel, makeDataset } from '../../core/export/testFixtures'
import type { TestPoint } from '../../core/types'
import {
  MODE_PRESETS,
  channelFamily,
  crossesSegment,
  eigenvalueText,
  figureSubtitle,
  fitCsv,
  fittedCurve,
  interpretFit,
  oscillationEnvelope,
  peakRows,
  plainNumber,
  presetChannel,
  presetPoint,
  resolveModeRows,
  resultTiles,
  resultsTsv,
  runModeFit,
  sourceKind,
  sourcePointId,
  windowSeries,
  type ModeFit,
} from './modesModel'

/** A damped oscillation sampled at `rate` Hz: y = c + A·e^(−σt)·cos(ωd t). */
function damped(periodS: number, zeta: number, seconds: number, rate = 10, offset = 250, amplitude = 8) {
  const omegaD = (2 * Math.PI) / periodS
  const sigma = (zeta * omegaD) / Math.sqrt(1 - zeta * zeta)
  const n = Math.round(seconds * rate)
  const t = Float64Array.from({ length: n }, (_, i) => i / rate)
  const y = t.map((x) => offset + amplitude * Math.exp(-sigma * x) * Math.cos(omegaD * x))
  return { t, y }
}

function firstOrder(tau: number, seconds: number, rate = 20) {
  const n = Math.round(seconds * rate)
  const t = Float64Array.from({ length: n }, (_, i) => i / rate)
  const y = t.map((x) => 1 + 20 * Math.exp(-x / tau))
  return { t, y }
}

const point = (id: string, name: string, start: number, end: number): TestPoint => ({
  id,
  name,
  groupId: 'g1',
  start,
  end,
})

describe('sources and rows', () => {
  it('names the source kinds', () => {
    expect(sourceKind('selection')).toBe('selection')
    expect(sourceKind('view')).toBe('view')
    expect(sourceKind('point:t1')).toBe('point')
    expect(sourcePointId('point:t1')).toBe('t1')
    expect(sourcePointId('view')).toBeNull()
  })

  const ctx = { selection: null, view: null, points: [point('t1', 'Phugoid', 10, 40)], rowCount: 100 }

  it('uses the selection, or reports there is none', () => {
    expect(resolveModeRows('selection', ctx)).toEqual({ rows: null, problem: 'no-selection', point: null })
    expect(resolveModeRows('selection', { ...ctx, selection: [5, 20] }).rows).toEqual([5, 20])
  })

  it('treats "no zoom" as missing unless the whole file is asked for', () => {
    expect(resolveModeRows('view', ctx).problem).toBe('no-zoom')
    expect(resolveModeRows('view', { ...ctx, wholeFile: true }).rows).toEqual([0, 100])
    expect(resolveModeRows('view', { ...ctx, view: [30, 60] }).rows).toEqual([30, 60])
  })

  it('finds the test point, or reports it gone', () => {
    const found = resolveModeRows('point:t1', ctx)
    expect(found.rows).toEqual([10, 40])
    expect(found.point?.name).toBe('Phugoid')
    expect(resolveModeRows('point:nope', ctx).problem).toBe('no-point')
  })

  it('clamps ranges to the file and rejects empty ones', () => {
    expect(resolveModeRows('selection', { ...ctx, selection: [-5, 500] }).rows).toEqual([0, 100])
    expect(resolveModeRows('selection', { ...ctx, selection: [50, 50] }).problem).toBe('no-selection')
  })
})

describe('windowSeries', () => {
  const ds = makeDataset(
    [fileChannel('_totl,_time', 1, 0, [100, 100.5, 101, 101.5, 102], 'Sim time', 's')],
    [0, 0.5, 1, 1.5, 2],
  )
  const values = Float64Array.from([1, 2, Number.NaN, 4, 5])

  it('takes time from elapsed seconds, starting at zero, and copies the values', () => {
    const w = windowSeries(ds, values, [1, 4])
    expect(Array.from(w.t)).toEqual([0, 0.5, 1])
    expect(Array.from(w.y)).toEqual([2, Number.NaN, 4])
    expect(w.t0).toBe(0.5)
    expect(w.durationS).toBe(1)
    expect(w.finite).toBe(2)
    expect(w.rows).toEqual([1, 4])
  })

  it('spots windows that cross a reset or gap', () => {
    const segmented = { ...ds, segments: [{ start: 0, end: 3, reason: 'start' as const }, { start: 3, end: 5, reason: 'reset' as const }] }
    expect(crossesSegment(segmented, [1, 5])).toBe(true)
    expect(crossesSegment(segmented, [3, 5])).toBe(false)
    expect(crossesSegment(segmented, [0, 3])).toBe(false)
  })
})

describe('runModeFit and the derived curves', () => {
  it('recovers a phugoid-like oscillation (T = 58 s, ζ = 0.06)', () => {
    const { t, y } = damped(58, 0.06, 180)
    const result = runModeFit({ t, y }, 'oscillation', 'linear')
    expect(result.model).toBe('oscillation')
    if (result.model !== 'oscillation') return
    expect(result.fit.ok).toBe(true)
    expect(result.fit.periodS).toBeCloseTo(58, 0)
    expect(result.fit.zeta).toBeCloseTo(0.06, 2)
    const envelope = oscillationEnvelope(t, result.fit)
    expect(envelope).not.toBeNull()
    // The envelope brackets the data.
    for (let k = 0; k < t.length; k += 50) {
      expect(y[k]).toBeLessThanOrEqual(envelope!.upper[k] + 1e-6)
      expect(y[k]).toBeGreaterThanOrEqual(envelope!.lower[k] - 1e-6)
    }
    expect(fittedCurve(result)).toBe(result.fit.fitted)
  })

  it('recovers a first-order decay (τ = 0.7 s)', () => {
    const { t, y } = firstOrder(0.7, 3)
    const result = runModeFit({ t, y }, 'first-order', 'none')
    if (result.model !== 'first-order') throw new Error('wrong model')
    expect(result.fit.ok).toBe(true)
    expect(result.fit.tau).toBeCloseTo(0.7, 3)
  })

  it('has no curve or envelope for a failed fit', () => {
    const result = runModeFit({ t: Float64Array.of(0, 1), y: Float64Array.of(1, 2) }, 'oscillation', 'none')
    expect(result.fit.ok).toBe(false)
    expect(fittedCurve(result)).toBeNull()
    if (result.model === 'oscillation') expect(oscillationEnvelope(Float64Array.of(0, 1), result.fit)).toBeNull()
  })
})

describe('resultTiles', () => {
  const { t, y } = damped(58, 0.06, 180)
  const ok = runModeFit({ t, y }, 'oscillation', 'linear')

  it('lists the oscillation quantities in a fixed order', () => {
    const tiles = resultTiles(ok, 'kt')
    expect(tiles.map((tile) => tile.key)).toEqual(['period', 'zeta', 'omegaN', 'omegaD', 'half', 'cycles', 'r2', 'zetaLogDec'])
    expect(tiles[0].unit).toBe('s')
    expect(Number(tiles[0].value)).toBeCloseTo(58, 0)
    expect(tiles.every((tile) => tile.value.length > 0)).toBe(true)
  })

  it('shows dashes for a rejected fit but keeps the tiles', () => {
    const failed = runModeFit({ t: Float64Array.of(0, 1, 2), y: Float64Array.of(1, 2, 3) }, 'oscillation', 'none')
    const tiles = resultTiles(failed, 'kt')
    expect(tiles).toHaveLength(8)
    expect(tiles.every((tile) => tile.value === '—')).toBe(true)
  })

  it('reports time to double for a growing oscillation', () => {
    const growing: ModeFit = { ...ok, fit: { ...(ok.fit as Extract<ModeFit, { model: 'oscillation' }>['fit']), sigma: -0.02, halfLifeS: -34.7 } } as ModeFit
    const half = resultTiles(growing, 'kt').find((tile) => tile.key === 'half')
    expect(half?.label).toBe('Time to double')
    expect(half?.value).toBe('34.7')
  })

  it('lists τ, t½, R² and the final value for a first-order fit', () => {
    const { t: t1, y: y1 } = firstOrder(0.7, 3)
    const tiles = resultTiles(runModeFit({ t: t1, y: y1 }, 'first-order', 'none'), 'deg/s')
    expect(tiles.map((tile) => tile.key)).toEqual(['tau', 'half', 'r2', 'final'])
    expect(tiles[3].unit).toBe('deg/s')
  })

  it('writes the eigenvalue pair with true minus signs', () => {
    expect(eigenvalueText(0.0066, 0.108)).toBe(`${MINUS}0.0066 ± 0.108i`)
    expect(eigenvalueText(Number.NaN, 1)).toBe('—')
  })
})

describe('interpretFit', () => {
  const ktas = { token: 'Vtrue,_ktas' }

  it('reads a phugoid', () => {
    const { t, y } = damped(58, 0.06, 180)
    const reading = interpretFit(runModeFit({ t, y }, 'oscillation', 'linear'), ktas)
    expect(reading?.tone).toBe('good')
    expect(reading?.text).toMatch(/lightly damped, typical of a phugoid/)
    expect(reading?.text).toMatch(/^ζ = 0\.06/)
  })

  it('reads a short period and a dutch roll from the channel kind', () => {
    const sp = damped(3.4, 0.5, 8, 20, 2, 1)
    expect(interpretFit(runModeFit(sp, 'oscillation', 'none'), { token: 'alpha,__deg' })?.text).toMatch(/short period/)
    const dr = damped(5.6, 0.15, 25, 20, 0, 2)
    expect(interpretFit(runModeFit(dr, 'oscillation', 'none'), { token: '____R,deg/s' })?.text).toMatch(/dutch roll/)
    // Same signal, unknown channel: no mode is claimed.
    expect(interpretFit(runModeFit(dr, 'oscillation', 'none'), { token: 'foo' })?.text).not.toMatch(/typical/)
  })

  it('flags an unstable oscillation', () => {
    const omegaD = (2 * Math.PI) / 10
    const t = Float64Array.from({ length: 400 }, (_, i) => i / 10)
    const y = t.map((x) => Math.exp(0.03 * x) * Math.cos(omegaD * x))
    const reading = interpretFit(runModeFit({ t, y }, 'oscillation', 'none'), ktas)
    expect(reading?.tone).toBe('danger')
    expect(reading?.text).toMatch(/unstable/)
  })

  it('reads roll subsidence and a divergent spiral', () => {
    const { t, y } = firstOrder(0.7, 3)
    expect(interpretFit(runModeFit({ t, y }, 'first-order', 'none'), { token: '____P,deg/s' })?.text).toMatch(
      /roll subsidence/,
    )
    const tg = Float64Array.from({ length: 300 }, (_, i) => i / 10)
    const bank = tg.map((x) => 2 + 3 * Math.exp(x / 15))
    const spiral = interpretFit(runModeFit({ t: tg, y: bank }, 'first-order', 'none'), { token: '_roll,__deg' })
    expect(spiral?.tone).toBe('danger')
    expect(spiral?.text).toMatch(/unstable spiral/)
  })

  it('says nothing about a rejected fit', () => {
    const failed = runModeFit({ t: Float64Array.of(0, 1, 2), y: Float64Array.of(1, 2, 3) }, 'oscillation', 'none')
    expect(interpretFit(failed, ktas)).toBeNull()
  })

  it('knows the channel families', () => {
    expect(channelFamily({ token: '____P,deg/s' })).toBe('roll-rate')
    expect(channelFamily({ token: '_roll,__deg' })).toBe('bank')
    expect(channelFamily({ token: '_beta,__deg' })).toBe('lateral')
    expect(channelFamily({ token: 'alpha,__deg' })).toBe('short-period')
    expect(channelFamily({ token: '_Vind,_kias' })).toBe('speed-height')
    expect(channelFamily({ token: '' })).toBeNull()
    expect(channelFamily(undefined)).toBeNull()
  })
})

describe('quick picks', () => {
  const ds = makeDataset(
    [
      fileChannel('_totl,_time', 1, 0, [0, 1], 't', 's'),
      fileChannel('_Vind,_kias', 1, 1, [1, 2], 'KIAS', 'kt'),
      fileChannel('____Q,deg/s', 1, 2, [1, 2], 'Q', 'deg/s'),
    ],
    [0, 1],
  )
  const byId = (id: string) => MODE_PRESETS.find((p) => p.id === id)!

  it('chooses the first channel the file has, by token', () => {
    expect(presetChannel(ds, byId('phugoid'))).toBe('_Vind,_kias')
    expect(presetChannel(ds, byId('short-period'))).toBe('____Q,deg/s')
    expect(presetChannel(ds, byId('dutch-roll'))).toBeNull()
  })

  it('moves to the matching test point only when the source is already a point', () => {
    const points = [point('a', 'Trim 210 KIAS', 0, 1), point('b', 'Dutch roll', 1, 2), point('c', 'Short-period doublet', 2, 3)]
    expect(presetPoint(points, byId('dutch-roll'), 'point:a')).toBe('point:b')
    expect(presetPoint(points, byId('short-period'), 'point:a')).toBe('point:c')
    expect(presetPoint(points, byId('dutch-roll'), 'selection')).toBeNull()
    expect(presetPoint(points, byId('spiral'), 'point:a')).toBeNull()
  })
})

describe('peak rows and figure subtitle', () => {
  it('measures peak amplitudes about the equilibrium and the decrement per cycle', () => {
    const { t, y } = damped(10, 0.1, 40, 20, 50, 4)
    const result = runModeFit({ t, y }, 'oscillation', 'none')
    if (result.model !== 'oscillation') throw new Error('wrong model')
    const rows = peakRows(result.fit, 100)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows[0].n).toBe(1)
    expect(rows[0].elapsed).toBeCloseTo(100 + rows[0].t, 9)
    expect(Number.isNaN(rows[0].decrement)).toBe(true)
    // δ = 2πζ/√(1 − ζ²) per cycle for ζ = 0.1.
    const expected = (2 * Math.PI * 0.1) / Math.sqrt(1 - 0.01)
    const later = rows.filter((r) => Number.isFinite(r.decrement))
    expect(later.length).toBeGreaterThan(2)
    for (const row of later) expect(row.decrement).toBeCloseTo(expected, 1)
  })

  it('summarises a fit in one line', () => {
    const { t, y } = damped(58, 0.06, 180)
    expect(figureSubtitle(runModeFit({ t, y }, 'oscillation', 'linear'))).toMatch(/^Td = 58(\.\d)? s · ζ = 0\.06\d* · ωn = /)
    const fo = firstOrder(0.7, 3)
    expect(figureSubtitle(runModeFit(fo, 'first-order', 'none'))).toMatch(/^τ = 0\.7 s · t½ = 0\.485 s · R² = 1$/)
    const failed = runModeFit({ t: Float64Array.of(0, 1), y: Float64Array.of(1, 2) }, 'first-order', 'none')
    expect(figureSubtitle(failed)).toBe('No accepted fit')
  })
})

describe('copy and CSV text', () => {
  const { t, y } = damped(20, 0.1, 60, 10, -5, 3)
  const result = runModeFit({ t, y }, 'oscillation', 'none')
  const ctx = { dataset: 'Data.txt', channel: 'Pitch [deg]', window: 'Selection', rows: [10, 610] as const, t0: 12.5, durationS: 59.9, detrend: 'none' as const }

  it('copies plain numbers (ASCII minus, no typographic signs)', () => {
    const text = resultsTsv(result, ctx)
    expect(text).not.toContain(MINUS)
    expect(text.split('\r\n')[0]).toBe('quantity\tvalue\tunit')
    expect(text).toMatch(/^period Td\t20(\.\d+)?\ts$/m)
    expect(text).toMatch(/^offset c\t-5(\.\d+)?\t$/m)
  })

  it('writes plain numbers', () => {
    expect(plainNumber(-0.000123456789)).toBe('-0.0001234568')
    expect(plainNumber(Number.NaN)).toBe('')
  })

  it('writes the window as CSV with the fit and residual', () => {
    const w = { rows: [0, t.length] as const, t, y, t0: 100, durationS: t[t.length - 1], finite: t.length }
    const envelope = result.model === 'oscillation' ? oscillationEnvelope(t, result.fit) : null
    const csv = fitCsv(w, result, '=cmd|x', envelope)
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe("t_s,elapsed_s,'=cmd|x,fit,residual,envelope_upper,envelope_lower")
    expect(lines).toHaveLength(t.length + 1)
    const first = lines[1].split(',')
    expect(Number(first[0])).toBe(0)
    expect(Number(first[1])).toBe(100)
    expect(Number(first[2])).toBeCloseTo(-2, 6)
    expect(csv).not.toContain(MINUS)
  })
})
