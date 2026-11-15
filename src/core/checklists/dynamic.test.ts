import { describe, expect, it } from 'vitest'
import { fitFirstOrder, fitOscillation } from '../analysis/modes'
import type { Dataset, RowRange } from '../types'
import { fitSummary, runDynamicChecks, type DynamicInput, type FitSummary, type ModeId } from './dynamic'
import { checklistCell, checklistCsv, dynamicReportRows } from './export'
import { doublet, fill, makeLog, pulse, ramp, times, type Columns } from './fixtures'

// Synthetic manoeuvres at 25 Hz (invented values): trimmed flight, an input on the mode's axis, a free response.
const RATE = 25
const TD_SP = 2.5
const ZETA_SP = 0.35

interface SpOptions {
  input?: (t: number) => number
  servoFollows?: boolean
  noServo?: boolean
  surfaceOnly?: boolean
  start?: number
  drop?: string[]
  extra?: (t: Float64Array) => Columns
  /** An earlier elevator pulse (0.4 s from `at`) and its free α response (`amp` degrees, default 1), decaying at `sigma` per second until 30 s */
  earlier?: { at: number; sigma: number; amp?: number }
}

/** A short-period run: trim, an elevator input from 30 s, the free α response; constant everything else. */
function spLog(options: SpOptions = {}): Dataset {
  const t = times(60 - (options.start ?? 0), RATE, options.start ?? 0)
  const early = options.earlier
  const main = options.input ?? ((tt: number) => 0.1 * doublet(tt, 30, TD_SP / 2))
  const input = (tt: number) => main(tt) + (early ? 0.1 * pulse(tt, early.at, 0.4) : 0)
  const earlyResponse = (tt: number) =>
    early && tt >= early.at + 0.5 && tt < 30 ? (early.amp ?? 1) * Math.exp(-early.sigma * (tt - early.at - 0.5)) * Math.sin(2.5 * (tt - early.at - 0.5)) : 0
  const wd = (2 * Math.PI) / TD_SP
  const sigma = (ZETA_SP * wd) / Math.sqrt(1 - ZETA_SP ** 2)
  const t1 = 30 + TD_SP + 0.1
  const a0 = 4.4
  const alpha = fill(t, (tt) => earlyResponse(tt) + (tt < 30 ? a0 : tt < t1 ? a0 + 10 * main(tt) : a0 + Math.exp(-sigma * (tt - t1)) * Math.cos(wd * (tt - t1))))
  const stickValues = fill(t, (tt) => (options.servoFollows || options.surfaceOnly ? 0 : input(tt)))
  const surf = fill(t, (tt) => input(tt))
  const zero = fill(t, () => 0)
  const cols: Columns = {
    '_Vind,_kias': fill(t, (tt) => 260 + 0.02 * Math.sin(tt)),
    'Vtrue,_ktas': fill(t, () => 300),
    '__VVI,__fpm': fill(t, (tt) => 5 * Math.sin(0.3 * tt)),
    '_Mach,ratio': fill(t, () => 0.5),
    'Gload,norml': fill(t, (_, i) => 1 + 0.1 * (alpha[i] - a0)),
    'alpha,__deg': alpha,
    'pitch,__deg': alpha,
    '_roll,__deg': zero,
    '_beta,__deg': zero,
    '____P,deg/s': zero,
    '____Q,deg/s': fill(t, (_, i) => (i > 0 ? (alpha[i] - alpha[i - 1]) * RATE : 0)),
    '____R,deg/s': zero,
    '_elev,stick': stickValues,
    'ailrn,stick': zero,
    'ruddr,stick': zero,
    '_elev,_surf': surf,
    'ailrn,_surf': zero,
    'ruddr,_surf': zero,
    '_elev,astab': zero,
    'ailrn,astab': zero,
    'ruddr,astab': zero,
    'thro1,handl': fill(t, () => 0.6),
    'thro2,handl': fill(t, () => 0.6),
    'N1__1,_pcnt': fill(t, () => 85),
    'N1__2,_pcnt': fill(t, () => 85),
    '_flap,postn': zero,
    '_slat,ratio': zero,
    'sbrak,postn': zero,
    '_gear,__0/1': zero,
    '_trim,_elev': fill(t, () => 0.1),
    '_trim,ailrn': zero,
    '_trim,ruddr': zero,
    '_turb,_locl': zero,
    '_wind,knots': zero,
    '_wind,v_fpm': zero,
    '_gear,ftagl': fill(t, () => 10000),
    'total,___lb': fill(t, () => 100000),
    '___cg,ftref': fill(t, () => 1),
    ...(options.extra?.(t) ?? {}),
  }
  if (!options.noServo) {
    cols['_elev,servo'] = options.servoFollows ? surf : options.surfaceOnly ? zero : fill(t, () => 0.3)
    cols['ailrn,servo'] = fill(t, () => (options.surfaceOnly ? 0 : 0.3))
    cols['ruddr,servo'] = fill(t, () => (options.surfaceOnly ? 0 : 0.3))
  }
  for (const token of options.drop ?? []) delete cols[token]
  return makeLog(t, cols)
}

function rowsAt(ds: Dataset, start: number, end: number): RowRange {
  let a = 0
  while (ds.elapsed[a] < start) a += 1
  let b = a
  while (b < ds.rowCount && ds.elapsed[b] <= end) b += 1
  return [a, b]
}

function oscillationFit(ds: Dataset, rows: RowRange, token = 'alpha,__deg'): FitSummary {
  const ch = ds.channels.find((c) => c.token === token)
  if (!ch) throw new Error(token)
  const t = Float64Array.from({ length: rows[1] - rows[0] }, (_, k) => ds.elapsed[rows[0] + k] - ds.elapsed[rows[0]])
  const y = ch.values.slice(rows[0], rows[1])
  return fitSummary({ model: 'oscillation', fit: fitOscillation(t, y, { detrend: 'none' }) })
}

function run(ds: Dataset, mode: ModeId, rows: RowRange, fit: FitSummary | null, extra: Partial<DynamicInput> = {}) {
  return runDynamicChecks({ ds, mode, rows, fit, ...extra })
}

const check = (report: ReturnType<typeof run>, id: string) => {
  const c = report.checks.find((k) => k.id === id)
  if (!c) throw new Error(`no check ${id}`)
  return c
}

describe('dynamic checklist (synthetic short period)', () => {
  it('1: a clean short-period doublet at 25 Hz with AP, YD and A/T off is acceptable for analysis', () => {
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    const fit = oscillationFit(ds, rows)
    expect(fit.ok).toBe(true)
    const report = run(ds, 'short-period', rows, fit)
    expect(report.verdict.kind).toBe('acceptable')
    expect(report.verdict.text).toMatch(/^Acceptable for analysis \(\d+ notes?\)$/)
    expect(report.input?.shape).toBe('doublet')
    expect(report.input?.variant).toBe('decay')
    expect(check(report, 'autopilot-off').status).toBe('pass')
    expect(check(report, 'trimmed-start').status).toBe('pass')
    expect(check(report, 'input-detected').status).toBe('pass')
    expect(check(report, 'input-shape').status).toBe('pass')
    expect(check(report, 'controls-fixed').status).toBe('pass')
    expect(check(report, 'sample-rate').status).toBe('pass')
    // Every check names its criterion and cites a source; judgement thresholds are flagged.
    for (const c of report.checks) {
      expect(c.citations.length).toBeGreaterThan(0)
      if (c.status !== 'not-checkable') expect(c.criterion).not.toBe('')
    }
    expect(check(report, 'controls-fixed').judgement).toBe(true)
    expect(check(report, 'controls-fixed').citations).toContain('NATO AG-300 v14 p.15-6')
  })

  it('2: the same run with each surface equal to its servo (autopilot on) fails autopilot-off', () => {
    const ds = spLog({ servoFollows: true })
    const rows = rowsAt(ds, 33, 45)
    const report = run(ds, 'short-period', rows, oscillationFit(ds, rows))
    expect(check(report, 'autopilot-off').status).toBe('fail')
    expect(report.verdict.kind).toBe('retest')
  })

  it('3: a servo frozen away from the stick passes; no servo row or a still stick is inconclusive', () => {
    const rows = rowsAt(spLog(), 33, 45)
    expect(check(run(spLog(), 'short-period', rows, null), 'autopilot-off').status).toBe('pass')
    const noServo = run(spLog({ noServo: true }), 'short-period', rows, null)
    expect(check(noServo, 'autopilot-off').status).toBe('warn')
    expect(check(noServo, 'autopilot-off').hint).toMatch(/Inconclusive/)
    const still = run(spLog({ surfaceOnly: true }), 'short-period', rows, null)
    expect(check(still, 'autopilot-off').status).toBe('warn')
  })

  it('4: a throttle change of 0.05 during the response fails throttle-fixed', () => {
    const ds = spLog({ extra: (t) => ({ 'thro1,handl': fill(t, (tt) => 0.6 + 0.05 * ramp(tt, 38, 1)) }) })
    const rows = rowsAt(ds, 33, 45)
    expect(check(run(ds, 'short-period', rows, null), 'throttle-fixed').status).toBe('fail')
  })

  it('7: an earlier input 3 s before the input fails trimmed-start; a trim window at the log start is not checkable', () => {
    const early = spLog({ input: (tt) => 0.1 * pulse(tt, 26.6, 0.4) + 0.1 * doublet(tt, 30, TD_SP / 2) })
    const rows = rowsAt(early, 33, 45)
    const report = run(early, 'short-period', rows, null)
    expect(check(report, 'trimmed-start').status).toBe('fail')
    expect(check(report, 'trimmed-start').measured).toMatch(/earlier input/)
    const late = spLog({ start: 25 })
    const lateReport = run(late, 'short-period', rowsAt(late, 33, 45), null)
    expect(check(lateReport, 'trimmed-start').status).toBe('not-checkable')
  })

  it('8: without rows 8, 10, 11, 13, 16 and 25 the verdict cannot confirm, and the input is estimated from the response', () => {
    const drop = [
      '_elev,stick', 'ailrn,stick', 'ruddr,stick', '_elev,_surf', 'ailrn,_surf', 'ruddr,_surf', '_elev,astab', 'ailrn,astab',
      'ruddr,astab', '_trim,_elev', '_trim,ailrn', '_trim,ruddr', '_flap,postn', '_slat,ratio', 'sbrak,postn', '____P,deg/s',
      '____Q,deg/s', '____R,deg/s', 'thro1,handl', 'thro2,handl', '_elev,servo', 'ailrn,servo', 'ruddr,servo',
    ]
    const ds = spLog({ drop })
    const report = run(ds, 'short-period', rowsAt(ds, 33, 45), null)
    expect(report.verdict.kind).toBe('cannot-confirm')
    expect(report.verdict.text).toMatch(/^Cannot confirm — tick rows .*8 \(Joystick/)
    expect(check(report, 'input-detected').status).toBe('not-checkable')
    expect(check(report, 'input-detected').criterion).toMatch(/estimated from the response/)
    expect(report.notes.join(' ')).toMatch(/estimated from the response/)
    expect(check(report, 'trimmed-start').status).toBe('pass')
  })

  it('9: a 4 s short-period step fails input-shape, a 1.5 s pulse warns, a doublet of 0.9·Td passes', () => {
    const fit: FitSummary = { model: 'oscillation', ok: true, r2: 0.98, periodS: TD_SP, zeta: ZETA_SP, zetaLogDec: ZETA_SP, omegaN: 2.7, sigma: 1, cycles: 3, peaks: 4, tau: NaN, halfLifeS: 0.7 }
    const step = spLog({ input: (tt) => 0.1 * pulse(tt, 28.4, 4) })
    const stepReport = run(step, 'short-period', rowsAt(step, 33, 45), fit)
    expect(check(stepReport, 'input-shape').status).toBe('fail')
    expect(check(stepReport, 'input-shape').severity).toBe('critical')
    expect(stepReport.verdict.kind).toBe('retest')
    const p15 = spLog({ input: (tt) => 0.1 * pulse(tt, 30, 1.5) })
    expect(check(run(p15, 'short-period', rowsAt(p15, 33, 45), fit), 'input-shape').status).toBe('warn')
    const d09 = spLog({ input: (tt) => 0.1 * doublet(tt, 30, (0.9 * TD_SP) / 2) })
    expect(check(run(d09, 'short-period', rowsAt(d09, 33, 45), fit), 'input-shape').status).toBe('pass')
  })

  it('10: a phugoid with 1.2 cycles fails record-length', () => {
    const ds = spLog()
    const fit: FitSummary = { model: 'oscillation', ok: true, r2: 0.97, periodS: 9, zeta: 0.05, zetaLogDec: 0.05, omegaN: 0.7, sigma: 0.035, cycles: 1.2, peaks: 2, tau: NaN, halfLifeS: 20 }
    const report = run(ds, 'phugoid', rowsAt(ds, 33, 44), fit)
    expect(check(report, 'record-length').status).toBe('fail')
    expect(check(report, 'record-length').severity).toBe('critical')
  })

  it('11: without row 152 the weather check is not checkable and the verdict does not change', () => {
    const ds = spLog({ drop: ['_turb,_locl', '_wind,knots', '_wind,v_fpm'] })
    const rows = rowsAt(ds, 33, 45)
    const report = run(ds, 'short-period', rows, oscillationFit(ds, rows))
    expect(check(report, 'weather').status).toBe('not-checkable')
    expect(check(report, 'weather').criterion).toBe('Not checkable — log row 152 (Aircraft point weather precip/wind)')
    expect(report.verdict.kind).toBe('acceptable')
  })

  it('reports the MIL-F-8785C level for an accepted fit as info only', () => {
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    const report = run(ds, 'short-period', rows, oscillationFit(ds, rows))
    const hq = check(report, 'hq-level')
    expect(hq.status).toBe('info')
    expect(hq.measured).toMatch(/Level [123]/)
    expect(hq.measured).toMatch(/bare airframe/)
  })
})

/** A dutch roll: a rudder doublet from 30 s, then the free β and yaw-rate oscillation. */
function drLog(astab: number): Dataset {
  const td = 5
  const t = times(70, RATE)
  const wd = (2 * Math.PI) / td
  const t1 = 30 + td + 0.1
  const beta = fill(t, (tt) => (tt < t1 ? 3 * doublet(tt, 30, td / 2) : 3 * Math.exp(-0.15 * (tt - t1)) * Math.cos(wd * (tt - t1))))
  const zero = fill(t, () => 0)
  return makeLog(t, {
    '_Vind,_kias': fill(t, () => 260),
    'Vtrue,_ktas': fill(t, () => 300),
    '__VVI,__fpm': zero,
    'alpha,__deg': fill(t, () => 4.4),
    'pitch,__deg': fill(t, () => 4.4),
    '_roll,__deg': fill(t, (_, i) => 0.8 * beta[i]),
    '_beta,__deg': beta,
    '____P,deg/s': zero,
    '____Q,deg/s': zero,
    '____R,deg/s': fill(t, (_, i) => 2 * beta[i]),
    '_elev,stick': zero,
    'ailrn,stick': zero,
    'ruddr,stick': fill(t, (tt) => 0.15 * doublet(tt, 30, td / 2)),
    '_elev,_surf': zero,
    'ailrn,_surf': zero,
    'ruddr,_surf': fill(t, (tt) => 0.15 * doublet(tt, 30, td / 2)),
    'ruddr,servo': fill(t, () => 0.2),
    'ruddr,astab': fill(t, () => astab),
    'ailrn,astab': zero,
    '_trim,_elev': zero,
    '_flap,postn': zero,
    '_gear,__0/1': zero,
  })
}

describe('dynamic checklist (dutch roll and roll subsidence)', () => {
  it('5: ruddr,astab = 0.01 in a dutch roll fails yaw-damper-off; declared on, it is info and the run is "augmented"', () => {
    const ds = drLog(0.01)
    const rows = rowsAt(ds, 36, 66)
    const report = run(ds, 'dutch-roll', rows, null)
    expect(check(report, 'yaw-damper-off').status).toBe('fail')
    expect(check(report, 'yaw-damper-off').severity).toBe('critical')
    const declared = run(ds, 'dutch-roll', rows, null, { settings: { yawDamper: 'on' } })
    expect(check(declared, 'yaw-damper-off').status).toBe('info')
    expect(declared.label).toBe('augmented')
    expect(check(run(drLog(0), 'dutch-roll', rows, null), 'yaw-damper-off').status).toBe('pass')
  })

  it('6: a roll-subsidence window at the step edge is an onset run; one starting at stick-centre is a decay run', () => {
    const t = times(60, RATE)
    const stick = fill(t, (tt) => 0.3 * pulse(tt, 30, 3))
    const p = fill(t, (tt) => (tt < 30 ? 0 : tt < 33.1 ? 20 * (1 - Math.exp(-(tt - 30) / 0.8)) : 20 * (1 - Math.exp(-3.1 / 0.8)) * Math.exp(-(tt - 33.1) / 0.8)))
    const zero = fill(t, () => 0)
    const ds = makeLog(t, {
      'ailrn,stick': stick,
      'ailrn,_surf': stick,
      'ruddr,stick': zero,
      '_elev,stick': zero,
      '____P,deg/s': p,
      '_roll,__deg': fill(t, (tt) => (tt < 30 ? 25 : 25 - 1.5 * (tt - 30))),
    })
    const onsetRows = rowsAt(ds, 30.05, 33)
    const tau = fitSummary({ model: 'first-order', fit: fitFirstOrder(Float64Array.from({ length: 50 }, (_, k) => k / RATE), Float64Array.from({ length: 50 }, (_, k) => Math.exp(-k / RATE / 0.8))) })
    expect(run(ds, 'roll-subsidence', onsetRows, tau).input?.variant).toBe('onset')
    expect(run(ds, 'roll-subsidence', rowsAt(ds, 33.3, 40), tau).input?.variant).toBe('decay')
  })
})

/** A roll-subsidence run from a steady turn at `bank0` degrees: a −0.3 lateral step held 3 s from 40 s, then released. */
function rsLog(bank0 = 30, pNoise = 0): Dataset {
  const t = times(60, RATE)
  const tau = 0.8
  const stick = fill(t, (tt) => -0.3 * pulse(tt, 40, 3))
  const p = fill(t, (tt) =>
    (tt < 40 ? 0 : tt < 43.1 ? -40 * (1 - Math.exp(-(tt - 40) / tau)) : -40 * (1 - Math.exp(-3.1 / tau)) * Math.exp(-(tt - 43.1) / tau)) +
    pNoise * Math.sin(7 * tt),
  )
  const phi = new Float64Array(t.length)
  phi[0] = bank0
  for (let i = 1; i < t.length; i += 1) phi[i] = phi[i - 1] + p[i] / RATE
  const zero = fill(t, () => 0)
  return makeLog(t, {
    '_Vind,_kias': fill(t, () => 210),
    'Vtrue,_ktas': fill(t, () => 250),
    '__VVI,__fpm': zero,
    'Gload,norml': fill(t, () => 1.15),
    'alpha,__deg': fill(t, () => 5),
    'pitch,__deg': fill(t, () => 3),
    '_roll,__deg': phi,
    '_beta,__deg': zero,
    '____P,deg/s': p,
    '____Q,deg/s': fill(t, () => 0.8),
    '____R,deg/s': fill(t, () => 2),
    '_elev,stick': zero,
    'ailrn,stick': stick,
    'ruddr,stick': zero,
    '_elev,_surf': zero,
    'ailrn,_surf': stick,
    'ruddr,_surf': zero,
  })
}

const rsFit = (): FitSummary =>
  fitSummary({
    model: 'first-order',
    fit: fitFirstOrder(Float64Array.from({ length: 75 }, (_, k) => k / RATE), Float64Array.from({ length: 75 }, (_, k) => Math.exp(-k / RATE / 0.8))),
  })

describe('dynamic checklist (review fixes)', () => {
  it('an autopilot that takes over after the pilot’s input (surface = moving servo, stick still) fails autopilot-off: short period and phugoid', () => {
    const t1 = 30 + TD_SP + 0.2
    const doubletIn = (tt: number) => 0.1 * doublet(tt, 30, TD_SP / 2)
    /** From `from` on the elevator surface follows a moving servo (the stick, the pilot's input only, stays still). */
    const takeOver = (from: number, main: (tt: number) => number, servo: (tt: number) => number) => (t: Float64Array): Columns => {
      const sv = fill(t, (tt) => (tt < from ? 0 : servo(tt)))
      return {
        '_elev,servo': sv,
        'ailrn,servo': fill(t, () => 0.3),
        'ruddr,servo': fill(t, () => 0.3),
        '_elev,_surf': fill(t, (tt, i) => (tt < from ? main(tt) : sv[i])),
      }
    }
    const sp = spLog({ noServo: true, extra: takeOver(t1, doubletIn, (tt) => 0.02 * Math.sin(2 * (tt - t1)) + 0.005 * Math.sin(0.5 * (tt - t1))) })
    const rows = rowsAt(sp, 33, 45)
    const report = run(sp, 'short-period', rows, oscillationFit(sp, rows))
    expect(report.input?.channelId).toBe('_elev,stick')
    const ap = check(report, 'autopilot-off')
    expect(ap.status).toBe('fail')
    expect(ap.measured).toMatch(/elevator: autopilot during the response/)
    expect(report.verdict.kind).toBe('retest')
    expect(report.verdict.text).toMatch(/the autopilot moved the surfaces/)
    // Phugoid (attitude hold, FD13 p.13): a held elevator pulse, then a slowly moving servo drives the surface.
    const pulseIn = (tt: number) => 0.1 * pulse(tt, 24, 4)
    const ph = spLog({ noServo: true, input: pulseIn, extra: takeOver(28.5, pulseIn, (tt) => 0.01 * Math.sin(0.3 * (tt - 28.5))) })
    const phReport = run(ph, 'phugoid', rowsAt(ph, 29, 59), null)
    expect(phReport.input?.shape).toBe('step')
    expect(check(phReport, 'autopilot-off').status).toBe('fail')
    // Autopilot off: the surface follows the stick and the servo just holds a value after the input: pass.
    const frozen = spLog({ noServo: true, extra: (t) => ({ '_elev,servo': fill(t, (tt) => (tt < t1 ? 0 : 0.12)), 'ailrn,servo': fill(t, () => 0.3), 'ruddr,servo': fill(t, () => 0.3) }) })
    expect(check(run(frozen, 'short-period', rowsAt(frozen, 33, 45), null), 'autopilot-off').status).toBe('pass')
  })

  it('roll subsidence, onset window from a steady 30° turn: the held lateral step is not a control movement', () => {
    const ds = rsLog()
    const report = run(ds, 'roll-subsidence', rowsAt(ds, 40.05, 43), rsFit())
    expect(report.input?.variant).toBe('onset')
    const cf = check(report, 'controls-fixed')
    expect(cf.status).toBe('pass')
    expect(cf.measured).toMatch(/aileron \(held at −0\.30 from 40\.\d\d s\) 100 % still/)
    expect(check(report, 'trimmed-start').status).toBe('pass')
    expect(report.verdict.kind).not.toBe('retest')
    // The decay window after the release is judged from its start; an onset window running past the release fails.
    expect(check(run(ds, 'roll-subsidence', rowsAt(ds, 43.3, 48), rsFit()), 'controls-fixed').status).toBe('pass')
    expect(check(run(ds, 'roll-subsidence', rowsAt(ds, 40.05, 45), rsFit()), 'controls-fixed').status).toBe('fail')
  })

  it('roll subsidence from wings level: the steady turn is usual (FD12b p.37), so trimmed-start warns; unsteady or steeper than 45° fails', () => {
    const decay = (ds: Dataset) => run(ds, 'roll-subsidence', rowsAt(ds, 43.3, 48), rsFit())
    const level = decay(rsLog(0))
    const ts = check(level, 'trimmed-start')
    expect(ts.status).toBe('warn')
    expect(ts.measured).toMatch(/from wings level/)
    expect(ts.citations).toContain('FD12b p.37')
    expect(check(level, 'input-size').status).toBe('warn')
    expect(level.verdict.text).not.toMatch(/not trimmed and steady/)
    expect(check(decay(rsLog(0, 3)), 'trimmed-start').status).toBe('fail')
    expect(check(decay(rsLog(50)), 'trimmed-start').status).toBe('fail')
  })

  it('an earlier input inside the trim window: T starts once its response has settled (warn, shorter than 10 s); a response still going fails', () => {
    const settled = spLog({ earlier: { at: 21, sigma: 1.5 } })
    const r1 = run(settled, 'short-period', rowsAt(settled, 33, 45), null)
    expect(r1.trim?.cut).toBe('input')
    expect(r1.trim?.settled).toBe(true)
    expect(r1.trim!.seconds).toBeGreaterThan(5)
    expect(r1.trim!.seconds).toBeLessThan(8.5)
    const ts = check(r1, 'trimmed-start')
    expect(ts.status).toBe('warn')
    expect(ts.measured).toMatch(/response settled/)
    // The earlier response, 2° and slowly damped, keeps the rates above twice the limit until less than 5 s are left.
    const slow = spLog({ earlier: { at: 21, sigma: 0.2, amp: 2 } })
    const r2 = check(run(slow, 'short-period', rowsAt(slow, 33, 45), null), 'trimmed-start')
    expect(r2.status).toBe('fail')
    expect(r2.measured).toMatch(/an earlier input or its response was still in progress/)
  })

  it('no control channel: the input is estimated from dθ/dt (not θ), and a trim window placed by it never fails (capped at warn, labelled)', () => {
    // An earlier attitude change (6° to 2°) early in the look-back makes a 5σ band on θ itself wide enough to hold the
    // whole response, so θ would find "quiet" stretches inside it; dθ/dt is still before the 3° push at 40 s and loud after.
    const t = times(80, RATE)
    const theta = fill(t, (tt) =>
      tt < 8 ? 6 : tt < 10 ? 6 - 2 * (tt - 8) : tt < 40 ? 2 : tt < 42 ? 2 - 1.5 * (tt - 40) : -1 + 3 * Math.sin((2 * Math.PI * (tt - 42)) / 30),
    )
    const zero = fill(t, () => 0)
    const ds = makeLog(t, {
      '_Vind,_kias': fill(t, () => 120),
      'Vtrue,_ktas': fill(t, () => 130),
      '__VVI,__fpm': fill(t, (tt) => 900 * Math.sin(0.5 * tt)),
      'alpha,__deg': fill(t, () => 5),
      'pitch,__deg': theta,
      '_roll,__deg': zero,
    })
    // R starts half a period into the response, as a window chosen inside the free phugoid can.
    const report = run(ds, 'phugoid', rowsAt(ds, 57, 79), null)
    expect(report.estimatedInput).not.toBeNull()
    expect(Math.abs((report.estimatedInput as number) - 40)).toBeLessThan(0.2)
    const ts = check(report, 'trimmed-start')
    expect(ts.status).toBe('warn')
    expect(ts.measured).toMatch(/^input estimated from the response at 40\.0 s; /)
    expect(ts.hint).toMatch(/estimated from the response/)
    expect(report.verdict.kind).toBe('cannot-confirm')
    expect(report.verdict.text).toMatch(/; the input was estimated from the response$/)
  })

  it('CAP below the "Levels 2 & 3" boundary reads worse than Level 3 (MIL guide Figs 5–6); above 10 only Level 3 remains', () => {
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    // n/α in spLog: Δn_z = 0.1 g per degree of α = 5.73 g/rad, so CAP = ωn² / 5.73.
    const fit: FitSummary = { model: 'oscillation', ok: true, r2: 0.98, periodS: TD_SP, zeta: 0.5, zetaLogDec: 0.5, omegaN: 0.3, sigma: 1, cycles: 3, peaks: 4, tau: NaN, halfLifeS: 0.7 }
    expect(check(run(ds, 'short-period', rows, fit), 'hq-level').measured).toMatch(/CAP 0\.0157: worse than Level 3/)
    expect(check(run(ds, 'short-period', rows, { ...fit, omegaN: 0.6 }), 'hq-level').measured).toMatch(/CAP 0\.0628: Level 2/)
    expect(check(run(ds, 'short-period', rows, { ...fit, omegaN: 8 }), 'hq-level').measured).toMatch(/CAP 11\.2: Level 3/)
  })

  it('the configuration tolerance is engineering judgement', () => {
    const report = run(spLog(), 'short-period', rowsAt(spLog(), 33, 45), null)
    expect(check(report, 'configuration-constant').judgement).toBe(true)
    expect(check(report, 'configuration-constant').why).toMatch(/engineering judgement/)
  })
})

describe('checklist export', () => {
  it('12: text cells starting with = + − @ get a leading apostrophe; the rows carry the verdict', () => {
    expect(checklistCell('=SUM(A1)', ',')).toBe("'=SUM(A1)")
    expect(checklistCell('+1', ',')).toBe("'+1")
    expect(checklistCell('-2', ',')).toBe("'-2")
    expect(checklistCell('@me', ',')).toBe("'@me")
    expect(checklistCell('a, b', ',')).toBe('"a, b"')
    expect(checklistCell('−3 kt', ',')).toBe('−3 kt')
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    const report = run(ds, 'short-period', rows, oscillationFit(ds, rows))
    const csv = checklistCsv(dynamicReportRows(report, '=bad name'))
    expect(csv.split('\r\n')[0]).toBe('checklist,set,point,check,title,status,severity,measured,criterion,judgement,follows,citations,hint')
    expect(csv).toContain("Short period: =bad name")
    expect(csv).toMatch(/,verdict,Verdict,acceptable,/)
    const tsv = checklistCsv(dynamicReportRows(report, 'w'), '\t')
    expect(tsv.split('\r\n')[1].split('\t')).toHaveLength(13)
  })
})
