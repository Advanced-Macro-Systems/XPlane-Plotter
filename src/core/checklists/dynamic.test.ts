import { describe, expect, it } from 'vitest'
import { fitFirstOrder, fitOscillation } from '../analysis/modes'
import type { Dataset, RowRange } from '../types'
import { CHECK_THRESHOLDS, fitSummary, runDynamicChecks, type DynamicInput, type FitSummary, type ModeId } from './dynamic'
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
  /** Amplitude of the free α response, degrees (default 1) */
  amp?: number
  /** Normal load factor per degree of α (default 0.1 g/deg) */
  nzPerDeg?: number
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
  const a1 = options.amp ?? 1
  const alpha = fill(t, (tt) => earlyResponse(tt) + (tt < 30 ? a0 : tt < t1 ? a0 + 10 * main(tt) : a0 + a1 * Math.exp(-sigma * (tt - t1)) * Math.cos(wd * (tt - t1))))
  const stickValues = fill(t, (tt) => (options.servoFollows || options.surfaceOnly ? 0 : input(tt)))
  const surf = fill(t, (tt) => input(tt))
  const zero = fill(t, () => 0)
  const cols: Columns = {
    '_Vind,_kias': fill(t, (tt) => 260 + 0.02 * Math.sin(tt)),
    'Vtrue,_ktas': fill(t, () => 300),
    '__VVI,__fpm': fill(t, (tt) => 5 * Math.sin(0.3 * tt)),
    '_Mach,ratio': fill(t, () => 0.5),
    'Gload,norml': fill(t, (_, i) => 1 + (options.nzPerDeg ?? 0.1) * (alpha[i] - a0)),
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

  it('7: an earlier input 3 s before the input leaves a short T, a note (its steadiness decides); a trim window at the log start is not checkable', () => {
    const early = spLog({ input: (tt) => 0.1 * pulse(tt, 26.6, 0.4) + 0.1 * doublet(tt, 30, TD_SP / 2) })
    const rows = rowsAt(early, 33, 45)
    const report = run(early, 'short-period', rows, null)
    // No source gives a duration for the trimmed stretch: the steady 2.4 s left before the input only warns.
    expect(check(report, 'trimmed-start').status).toBe('warn')
    expect(check(report, 'trimmed-start').measured).toMatch(/T only 2\.\d s: an earlier input/)
    expect(report.verdict.kind).not.toBe('retest')
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

  it('10: a phugoid with 1.2 cycles warns (Cook’s own record holds about 1.6); under 1 cycle it fails: Fix the analysis while the log runs on, Retest at its end', () => {
    const ds = spLog()
    const fit: FitSummary = { model: 'oscillation', ok: true, r2: 0.97, periodS: 9, zeta: 0.05, zetaLogDec: 0.05, omegaN: 0.7, sigma: 0.035, cycles: 1.2, peaks: 2, tau: NaN, halfLifeS: 20 }
    const report = run(ds, 'phugoid', rowsAt(ds, 33, 44), fit)
    expect(check(report, 'record-length').status).toBe('warn')
    expect(check(report, 'record-length').severity).toBe('critical')
    expect(check(report, 'record-length').criterion).toMatch(/pass ≥ 2 cycles; warn 1–2; fail < 1/)
    expect(report.verdict.kind).toBe('acceptable')
    // 0.95 cycles with 16 s of log after the window: widen it.
    const short = { ...fit, cycles: 0.95 }
    const widen = run(ds, 'phugoid', rowsAt(ds, 33, 44), short)
    expect(check(widen, 'record-length').status).toBe('fail')
    expect(check(widen, 'record-length').severity).toBe('analysis')
    expect(check(widen, 'record-length').hint).toMatch(/^Widen the window: the log runs on 16 s past it/)
    expect(widen.verdict.kind).toBe('fix-analysis')
    expect(widen.verdict.text).toBe('Fix the analysis — too few cycles in the window: widen it, the log runs on past it')
    // The same at the end of the log: record more cycles.
    const ends = run(ds, 'phugoid', rowsAt(ds, 33, 60), short)
    expect(check(ends, 'record-length').severity).toBe('critical')
    expect(ends.verdict.kind).toBe('retest')
    expect(ends.verdict.text).toMatch(/too few cycles recorded \(the log ends\)/)
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

/**
 * A dutch roll: a rudder doublet from 30 s (or `cycles` cycles of cyclic pedalling at the mode's period), then the free
 * β and yaw-rate oscillation of amplitude `amp` degrees (default 3); `extra` adds or overrides columns.
 */
function drLog(astab: number, options: { amp?: number; cycles?: number; extra?: (t: Float64Array) => Columns } = {}): Dataset {
  const td = 5
  const t = times(70, RATE)
  const wd = (2 * Math.PI) / td
  const amp = options.amp ?? 3
  const cycles = options.cycles ?? 0
  const forcing = (tt: number) => (cycles ? (tt >= 30 && tt < 30 + cycles * td ? Math.sin(wd * (tt - 30)) : 0) : doublet(tt, 30, td / 2))
  const t1 = cycles ? 30 + cycles * td : 30 + td + 0.1
  const beta = fill(t, (tt) => (tt < t1 ? amp * forcing(tt) : amp * Math.exp(-0.15 * (tt - t1)) * Math.cos(wd * (tt - t1))))
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
    'ruddr,stick': fill(t, (tt) => 0.15 * forcing(tt)),
    '_elev,_surf': zero,
    'ailrn,_surf': zero,
    'ruddr,_surf': fill(t, (tt) => 0.15 * forcing(tt)),
    'ruddr,servo': fill(t, () => 0.2),
    'ruddr,astab': fill(t, () => astab),
    'ailrn,astab': zero,
    '_trim,_elev': zero,
    '_flap,postn': zero,
    '_gear,__0/1': zero,
    ...(options.extra?.(t) ?? {}),
  })
}

describe('dynamic checklist (dutch roll and roll subsidence)', () => {
  it('5: ruddr,astab = 0.01 in a dutch roll fails yaw-damper-off; declared on, it passes as augmented and the run is "augmented"', () => {
    const ds = drLog(0.01)
    const rows = rowsAt(ds, 36, 66)
    const report = run(ds, 'dutch-roll', rows, null)
    expect(check(report, 'yaw-damper-off').status).toBe('fail')
    expect(check(report, 'yaw-damper-off').severity).toBe('critical')
    const declared = run(ds, 'dutch-roll', rows, null, { settings: { yawDamper: 'on' } })
    expect(check(declared, 'yaw-damper-off').status).toBe('pass')
    expect(check(declared, 'yaw-damper-off').measured).toMatch(/declared augmented run \(passes as augmented\)$/)
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
function rsLog(bank0 = 30, pNoise = 0, extra: (t: Float64Array) => Columns = () => ({})): Dataset {
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
    ...extra(t),
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

  it('roll subsidence from wings level: the steady turn is usual (FD12b p.37), so trimmed-start warns; 35–60° warns (NATO 15-6’s usual starts); unsteady or steeper than 60° fails', () => {
    const decay = (ds: Dataset) => run(ds, 'roll-subsidence', rowsAt(ds, 43.3, 48), rsFit())
    const level = decay(rsLog(0))
    const ts = check(level, 'trimmed-start')
    expect(ts.status).toBe('warn')
    expect(ts.measured).toMatch(/from wings level/)
    expect(ts.citations).toContain('FD12b p.37')
    expect(check(level, 'input-size').status).toBe('warn')
    expect(level.verdict.text).not.toMatch(/not trimmed and steady/)
    expect(check(decay(rsLog(0, 3)), 'trimmed-start').status).toBe('fail')
    const steep = decay(rsLog(50))
    expect(check(steep, 'trimmed-start').status).toBe('warn')
    expect(check(steep, 'trimmed-start').sourced).toMatch(/NATO 15-6/)
    expect(check(steep, 'input-size').status).toBe('pass')
    expect(steep.verdict.kind).not.toBe('retest')
    const tooSteep = decay(rsLog(65))
    expect(check(tooSteep, 'trimmed-start').status).toBe('fail')
    // input-size is advisory: a start over 60° is a note there, never a fail.
    expect(check(tooSteep, 'input-size').status).toBe('warn')
  })

  it('an earlier input inside the trim window: T starts once its response has settled (warn, shorter than 10 s); a short settled T warns; a response still going at the input fails on its rates', () => {
    const settled = spLog({ earlier: { at: 21, sigma: 1.5 } })
    const r1 = run(settled, 'short-period', rowsAt(settled, 33, 45), null)
    expect(r1.trim?.cut).toBe('input')
    expect(r1.trim?.settled).toBe(true)
    expect(r1.trim!.seconds).toBeGreaterThan(5)
    expect(r1.trim!.seconds).toBeLessThan(8.5)
    const ts = check(r1, 'trimmed-start')
    expect(ts.status).toBe('warn')
    expect(ts.measured).toMatch(/response settled/)
    // The earlier response, 2° and slowly damped, keeps the rates above twice the limit until less than 5 s are left:
    // what is left is steady enough, so the short T is a note.
    const slow = spLog({ earlier: { at: 21, sigma: 0.2, amp: 2 } })
    const r2 = check(run(slow, 'short-period', rowsAt(slow, 33, 45), null), 'trimmed-start')
    expect(r2.status).toBe('warn')
    expect(r2.measured).toMatch(/an earlier input or its response was still in progress/)
    // Damped so little that it never settles before the input: judged from the end of that input, its rates fail.
    const going = spLog({ earlier: { at: 21, sigma: 0.05, amp: 2 } })
    const r3 = check(run(going, 'short-period', rowsAt(going, 33, 45), null), 'trimmed-start')
    expect(r3.status).toBe('fail')
    expect(r3.measured).toMatch(/judged from the end of that input/)
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

/** Trimmed, steady flight on every channel the checks read (invented values); `extra` overrides or adds columns. */
function flatLog(t: Float64Array, extra: Columns = {}): Dataset {
  const zero = fill(t, () => 0)
  return makeLog(t, {
    '_Vind,_kias': fill(t, () => 200),
    'Vtrue,_ktas': fill(t, () => 230),
    '__VVI,__fpm': zero,
    '_Mach,ratio': fill(t, () => 0.4),
    'Gload,norml': fill(t, () => 1),
    'alpha,__deg': fill(t, () => 4),
    'pitch,__deg': fill(t, () => 4),
    '_roll,__deg': zero,
    '_beta,__deg': zero,
    '____P,deg/s': zero,
    '____Q,deg/s': zero,
    '____R,deg/s': zero,
    '_elev,stick': zero,
    'ailrn,stick': zero,
    'ruddr,stick': zero,
    '_elev,_surf': zero,
    'ailrn,_surf': zero,
    'ruddr,_surf': zero,
    '_elev,servo': fill(t, () => 0.3),
    'ailrn,servo': fill(t, () => 0.3),
    'ruddr,servo': fill(t, () => 0.3),
    '_elev,astab': zero,
    'ailrn,astab': zero,
    'ruddr,astab': zero,
    'thro1,handl': fill(t, () => 0.6),
    'N1__1,_pcnt': fill(t, () => 85),
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
    '_gear,ftagl': fill(t, () => 8000),
    'total,___lb': fill(t, () => 90000),
    '___cg,ftref': fill(t, () => 1),
    ...extra,
  })
}

/** A phugoid run at `rate` Hz: the elevator held 5 s from `pulseAt` (the speed falls 5 %), then a free 40 s speed oscillation. */
function phLog(rate: number, seconds = 300, pulseAt = 20): Dataset {
  const t = times(seconds, rate)
  const t1 = pulseAt + 5
  const tas = fill(t, (tt) =>
    tt < pulseAt ? 230 : tt < t1 ? 230 - (11.5 * (tt - pulseAt)) / 5 : 230 - 11.5 * Math.exp(-0.01 * (tt - t1)) * Math.cos((2 * Math.PI * (tt - t1)) / 40),
  )
  const stick = fill(t, (tt) => 0.1 * pulse(tt, pulseAt, 5))
  return flatLog(t, { 'Vtrue,_ktas': tas, '_Vind,_kias': fill(t, (_, i) => tas[i] - 30), '_elev,stick': stick, '_elev,_surf': stick })
}

const PH_FIT: FitSummary = { model: 'oscillation', ok: true, r2: 0.98, periodS: 40, zeta: 0.05, zetaLogDec: 0.05, omegaN: 0.157, sigma: 0.0079, cycles: 3.5, peaks: 7, tau: NaN, halfLifeS: 88 }
const SP_FIT: FitSummary = { model: 'oscillation', ok: true, r2: 0.98, periodS: TD_SP, zeta: ZETA_SP, zetaLogDec: ZETA_SP, omegaN: 2.7, sigma: 1, cycles: 3, peaks: 4, tau: NaN, halfLifeS: 0.7 }
const firstOrder = (tau: number, ok = true, message?: string): FitSummary => ({
  model: 'first-order', ok, r2: ok ? 0.99 : 0.4, ...(message ? { message } : {}), periodS: NaN, zeta: NaN, zetaLogDec: NaN, omegaN: NaN, sigma: NaN, cycles: NaN, peaks: 0, tau, halfLifeS: Math.LN2 * tau,
})

describe('dynamic checklist (source audit: relaxations and fixes)', () => {
  it('sample rate: judged over T to R, not the whole file; every mode fails under NATO’s 10 samples/s', () => {
    // A file logged at 25 Hz for 200 s, then at 5 Hz: the run in the 5 Hz part fails although the file’s rate is 25 Hz.
    const t = Float64Array.from([...times(200, 25), ...times(100, 5, 200).subarray(1)])
    const input = fill(t, (tt) => 0.1 * doublet(tt, 230, TD_SP / 2))
    const mixed = flatLog(t, { '_elev,stick': input, '_elev,_surf': input })
    expect(Math.round(mixed.sampleRateHz)).toBe(25)
    const sr = check(run(mixed, 'short-period', rowsAt(mixed, 234, 250), null), 'sample-rate')
    expect(sr.status).toBe('fail')
    expect(sr.measured).toMatch(/^5 Hz/)
    expect(sr.sourced).toMatch(/NATO 15-5/)
    // A phugoid at 5 Hz fails too (it only warned between 2 and 10 Hz).
    const ph = phLog(5)
    const report = run(ph, 'phugoid', rowsAt(ph, 30, 200), PH_FIT)
    expect(check(report, 'sample-rate').status).toBe('fail')
    expect(check(report, 'sample-rate').criterion).toMatch(/fail < 10 Hz \(NATO 15-5\)/)
    expect(report.verdict.text).toMatch(/the sample rate is too low for the mode/)
    expect(check(run(phLog(10), 'phugoid', rowsAt(phLog(10), 30, 200), PH_FIT), 'sample-rate').status).toBe('pass')
  })

  it('sample rate: samples per period or τ only warn (a Jetstream-like τ of 0.4 s at 10 Hz), and a rejected fit gives no per-τ line', () => {
    const t = times(60, 10)
    const stick = fill(t, (tt) => -0.3 * pulse(tt, 40, 3))
    const ds = flatLog(t, { 'ailrn,stick': stick, 'ailrn,_surf': stick })
    const sr = check(run(ds, 'roll-subsidence', rowsAt(ds, 43.3, 48), firstOrder(0.4)), 'sample-rate')
    expect(sr.status).toBe('warn')
    expect(sr.measured).toMatch(/4 samples per time constant/)
    expect(sr.criterion).toMatch(/pass ≥ 20 Hz .* warn 10–20 Hz, fewer samples per period or per τ, or a dropout; fail < 10 Hz/)
    const rs = rsLog()
    const rejected = check(run(rs, 'roll-subsidence', rowsAt(rs, 43.3, 48), firstOrder(0.1, false, 'Poor fit (R² = 0.40): the window may not contain a first-order response.')), 'sample-rate')
    expect(rejected.measured).not.toMatch(/per time constant/)
    expect(rejected.status).toBe('pass')
  })

  it('input found further back than the look-back is a note; only no input at all fails', () => {
    // A window chosen in the fourth cycle of a long phugoid, 125 s after the input (the look-back is 90 s).
    const ph = phLog(10)
    const report = run(ph, 'phugoid', rowsAt(ph, 150, 290), PH_FIT)
    expect(report.input?.far).toBe(true)
    const found = check(report, 'input-detected')
    expect(found.status).toBe('warn')
    expect(found.measured).toMatch(/beyond the 90 s look-back/)
    expect(found.hint).toMatch(/^Move the window nearer the input/)
    expect(report.verdict.kind).toBe('acceptable')
    // No input anywhere before the window.
    const flat = flatLog(times(120, 10))
    const none = run(flat, 'phugoid', rowsAt(flat, 60, 110), PH_FIT)
    expect(check(none, 'input-detected').status).toBe('fail')
    expect(check(none, 'input-detected').measured).toMatch(/in the continuous record before the window/)
    expect(none.verdict.text).toMatch(/no input found before the window/)
  })

  it('autopilot only in the trim window, disconnected before the input, warns; the response decides the fail', () => {
    const trimmedOnAp = spLog({
      noServo: true,
      extra: (t) => {
        const servo = fill(t, (tt) => 0.02 * Math.sin(0.8 * Math.min(tt, 28)))
        return {
          '_elev,servo': servo,
          'ailrn,servo': fill(t, () => 0.3),
          'ruddr,servo': fill(t, () => 0.3),
          '_elev,_surf': fill(t, (tt, i) => (tt < 28 ? servo[i] : 0.1 * doublet(tt, 30, TD_SP / 2))),
        }
      },
    })
    const report = run(trimmedOnAp, 'short-period', rowsAt(trimmedOnAp, 33, 45), null)
    const ap = check(report, 'autopilot-off')
    expect(ap.status).toBe('warn')
    expect(ap.measured).toMatch(/elevator: autopilot before the input, .* \(trimmed on the autopilot, disconnected before the input\)/)
    expect(report.verdict.text).not.toMatch(/autopilot/)
    // An autopilot that flies the response still fails (test 2 and the take-over test above).
    expect(check(run(spLog({ servoFollows: true }), 'short-period', rowsAt(spLog(), 33, 45), null), 'autopilot-off').status).toBe('fail')
  })

  it('throttle: the lever decides; N1 alone warns, and fails only without a lever ("the power changed"); the legacy lever and the A/T code are read', () => {
    const n1 = (t: Float64Array) => ({ 'N1__1,_pcnt': fill(t, (tt) => 85 + 3 * ramp(tt, 36, 4)) })
    const rows = rowsAt(spLog(), 33, 45)
    const drift = check(run(spLog({ extra: n1 }), 'short-period', rows, null), 'throttle-fixed')
    expect(drift.status).toBe('warn')
    expect(drift.measured).toMatch(/lever range 0; N1 within 3\.00 %pt of trim/)
    const noLever = run(spLog({ drop: ['thro1,handl', 'thro2,handl'], extra: n1 }), 'short-period', rows, null)
    expect(check(noLever, 'throttle-fixed').status).toBe('fail')
    expect(noLever.verdict.text).toMatch(/the power changed/)
    expect(noLever.verdict.text).not.toMatch(/the throttle moved/)
    const legacy = run(spLog({ drop: ['thro1,handl', 'thro2,handl'], extra: (t) => ({ 'thro1,_part': fill(t, (tt) => 0.6 + 0.05 * ramp(tt, 38, 1)) }) }), 'short-period', rows, null)
    expect(check(legacy, 'throttle-fixed').status).toBe('fail')
    expect(legacy.verdict.text).toMatch(/the throttle moved/)
    const at = check(run(spLog({ extra: (t) => ({ '_auto,throt': fill(t, () => 1) }) }), 'short-period', rows, null), 'throttle-fixed')
    expect(at.status).toBe('warn')
    expect(at.measured).toMatch(/autothrottle mode code 1 \(not 0\)/)
  })

  it('yaw damper: critical for the dutch roll, a note for roll subsidence; the citations name Cook p.328 and MIL p.152', () => {
    const rs = rsLog(30, 0, (t) => ({ 'ruddr,astab': fill(t, () => 0.01) }))
    const report = run(rs, 'roll-subsidence', rowsAt(rs, 43.3, 48), rsFit())
    const yd = check(report, 'yaw-damper-off')
    expect(yd.severity).toBe('advisory')
    expect(yd.status).toBe('warn')
    expect(yd.hint).toMatch(/declare an augmented run/)
    expect(report.verdict.text).not.toMatch(/yaw damper/)
    expect(yd.citations).toEqual(expect.arrayContaining(['Cook p.328', 'MIL-F-8785C guide p.152', 'NATO AG-300 v14 p.29-1']))
    expect(yd.why).toMatch(/bare-airframe choice \(engineering judgement\)/)
  })

  it('input shape: the short-period pulse is judged on its full duration; dutch-roll pedalling of any number of cycles at the mode’s period passes', () => {
    // A triangular pulse 1.8 s long: half-amplitude width 0.9 s (it passed), full duration about 1.6 s (Cook: a second or less).
    const tri = spLog({ input: (tt) => 0.1 * Math.max(0, 1 - Math.abs(tt - 30.9) / 0.9) })
    const shape = check(run(tri, 'short-period', rowsAt(tri, 33, 45), SP_FIT), 'input-shape')
    expect(shape.status).toBe('warn')
    expect(shape.measured).toMatch(/^pulse, 1\.\d\d s/)
    expect(shape.criterion).toMatch(/pass: a pulse ≤ 1 s long from its 10 %-of-peak onset to its end \(Cook p\.176\)/)
    expect(shape.citations).not.toContain('NATO AG-300 v14 p.12-10')
    expect(shape.sourced).toMatch(/Cook p\.176/)
    // Four cycles of pedalling at the dutch-roll period (it warned beyond two).
    const dr = drLog(0, { cycles: 4 })
    const drFit: FitSummary = { ...SP_FIT, periodS: 5, omegaN: 1.26, zeta: 0.12, zetaLogDec: 0.12 }
    const pedalled = run(dr, 'dutch-roll', rowsAt(dr, 51, 66), drFit)
    expect(pedalled.input?.shape).toBe('cyclic')
    expect(check(pedalled, 'input-shape').status).toBe('pass')
    expect(check(pedalled, 'input-shape').measured).toMatch(/4\.0 forcing cycles, each 1\.00–1\.00 × Td$/)
    expect(pedalled.input?.periods).toHaveLength(6)
  })

  it('input size: the textbook’s own recorded inputs pass (short period Δα 4.3°, 0.8 g; dutch roll Δβ 8.7°); the check never fails', () => {
    const sp = spLog({ amp: 4.3, nzPerDeg: 0.186 })
    const size = check(run(sp, 'short-period', rowsAt(sp, 33, 45), null), 'input-size')
    expect(size.status).toBe('pass')
    expect(size.criterion).toBe('pass 0.5° ≤ peak |Δα| ≤ 5° and peak |Δn_z| ≤ 1 g with n_z above 0; warn otherwise (a note, never fails)')
    const dr = drLog(0, { amp: 8.7 })
    expect(check(run(dr, 'dutch-roll', rowsAt(dr, 36, 66), null), 'input-size').status).toBe('pass')
    const big = drLog(0, { amp: 14 })
    expect(check(run(big, 'dutch-roll', rowsAt(big, 36, 66), null), 'input-size').status).toBe('warn')
    expect(check(run(big, 'dutch-roll', rowsAt(big, 36, 66), null), 'input-size').citations).not.toContain('MIL-F-8785C guide p.51')
  })

  it('a rejected fit is an analysis fix ("Fix the analysis"), unless a critical check fails too (Retest required)', () => {
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    const rejected: FitSummary = { ...SP_FIT, ok: false, message: 'Poor fit: the oscillation explains only 30 % of the variation.' }
    const report = run(ds, 'short-period', rows, rejected)
    const fq = check(report, 'fit-quality')
    expect(fq.status).toBe('fail')
    expect(fq.severity).toBe('analysis')
    expect(report.verdict.kind).toBe('fix-analysis')
    expect(report.verdict.text).toBe('Fix the analysis — the fit was rejected: try another window or trend')
    expect(run(spLog({ servoFollows: true }), 'short-period', rows, rejected).verdict.kind).toBe('retest')
    // An accepted fit with a note warns, and the note is shown.
    const noted = check(run(ds, 'short-period', rows, { ...SP_FIT, message: 'Only 1.2 cycles in the window: frequency and damping are uncertain.' }), 'fit-quality')
    expect(noted.status).toBe('warn')
    expect(noted.measured).toMatch(/note: Only 1\.2 cycles/)
    expect(noted.criterion).toMatch(/any fit note/)
  })

  it('a bank change during a longitudinal mode is lateral motion (mode-purity, a note), not a control movement', () => {
    const banked = spLog({ extra: (t) => ({ '_roll,__deg': fill(t, (tt) => 20 * ramp(tt, 34, 8)) }) })
    const report = run(banked, 'short-period', rowsAt(banked, 33, 45), null)
    expect(check(report, 'controls-fixed').status).toBe('pass')
    expect(check(report, 'controls-fixed').criterion).toMatch(/Other axes: at most warn, except a lateral or pedal change > 0\.1 \(fail\)/)
    expect(check(report, 'mode-purity').status).toBe('warn')
    expect(check(report, 'mode-purity').measured).toMatch(/bank change 20\.0° \(lateral motion during the response\)/)
    expect(report.verdict.kind).not.toBe('retest')
  })

  it('window start: up to half a damped period after the input passes (the first peak, FD12b p.34); a window holding the input warns', () => {
    const ds = spLog()
    const late = rowsAt(ds, 33.7, 45)
    const ws = check(run(ds, 'short-period', late, oscillationFit(ds, late)), 'window-start')
    expect(ws.status).toBe('pass')
    expect(ws.criterion).toMatch(/^pass −0\.2 s ≤ gap ≤ 1\.2\d s after the input ends \(0\.5 × the damped period/)
    const early = check(run(ds, 'short-period', rowsAt(ds, 31.5, 45), null), 'window-start')
    expect(early.status).toBe('warn')
    expect(early.measured).toMatch(/holds the forced input/)
  })

  it('handling-qualities level: Category C proxy from flaps, slats or gear (not the speedbrake), with Fig 6’s Class III floors', () => {
    // n/α = 1.5 g/rad and ωn 0.6 rad/s: CAP 0.24 is inside the Category C Level 1 band but under its floors: Level 2.
    const flaps = spLog({ nzPerDeg: (1.5 * Math.PI) / 180, extra: (t) => ({ '_flap,postn': fill(t, () => 0.5) }) })
    const rows = rowsAt(flaps, 33, 45)
    const fit: FitSummary = { ...SP_FIT, zeta: 0.5, zetaLogDec: 0.5, omegaN: 0.6 }
    const report = run(flaps, 'short-period', rows, fit)
    const hq = check(report, 'hq-level')
    expect(hq.measured).toMatch(/ζ 0\.5: Level 1 \(Table IV, Category C proxy \(flaps, slats or gear out\)\); CAP 0\.24: Level 2 \(below Fig 6’s Level 1 floor/)
    expect(hq.measured).toMatch(/n\/α 1\.5 g\/rad \(estimated from the free response, engineering judgement\)/)
    expect(hq.criterion).toMatch(/Class III assumed/)
    expect(hq.follows).toBe('MIL-F-8785C (MIL p.47, p.51, p.53-54, p.96, p.99) where Cook’s tables differ or give no chart')
    expect(hq.citations).toEqual(expect.arrayContaining(['MIL-F-8785C guide p.53-54', 'MIL-F-8785C guide p.152', 'Cook p.271']))
    expect(hq.judgement).toBe(true)
    expect(check(report, 'configuration-constant').measured).toMatch(/Category C proxy \(flaps, slats or gear out\)/)
    const brake = spLog({ extra: (t) => ({ 'sbrak,postn': fill(t, () => 0.5) }) })
    const braked = run(brake, 'short-period', rows, { ...SP_FIT })
    expect(check(braked, 'configuration-constant').measured).toMatch(/Category B proxy/)
    expect(check(braked, 'hq-level').measured).toMatch(/Table IV, Category B proxy \(flaps, slats and gear in\)\)/)
  })

  it('repeats: the student is asked to compare the other runs (named); passed fits are compared', () => {
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    const alone = check(run(ds, 'short-period', rows, null), 'repeats')
    expect(alone.status).toBe('info')
    expect(alone.criterion).toBe('Compare your repeat runs yourself: the app does not compare them yet')
    expect(alone.measured).toBe('no other short period test point')
    expect(alone.citations).toContain('NATO AG-300 v14 p.13-3')
    expect(check(run(ds, 'short-period', rows, null, { otherPoints: ['SP 2', 'SP 3'] }), 'repeats').measured).toBe('other short period test points: SP 2, SP 3')
    const compared = check(run(ds, 'short-period', rows, null, { repeats: [{ name: 'a', zeta: 0.3, periodS: 2.5 }, { name: 'b', zeta: 0.4, periodS: 2.6 }] }), 'repeats')
    expect(compared.measured).toMatch(/^2 points: ζ range 0\.1, Td range 4 % \(flagged\)$/)
  })

  it('weather: a steady change of wind with height is not turbulence; gusts warn', () => {
    const rows = rowsAt(spLog(), 33, 45)
    const layered = check(run(spLog({ extra: (t) => ({ '_wind,knots': fill(t, (tt) => 10 + 0.1 * tt) }) }), 'short-period', rows, null), 'weather')
    expect(layered.status).toBe('pass')
    const gusty = check(run(spLog({ extra: (t) => ({ '_wind,knots': fill(t, (tt) => 10 + 2 * Math.sin(3 * tt)) }) }), 'short-period', rows, null), 'weather')
    expect(gusty.status).toBe('warn')
    expect(gusty.measured).toMatch(/gusts 3\.\d kt/)
  })

  it('envelope: info until the speed limits are set; the margins are named tolerances', () => {
    const ds = spLog()
    const rows = rowsAt(ds, 33, 45)
    const unset = check(run(ds, 'short-period', rows, null), 'envelope')
    expect(unset.status).toBe('info')
    expect(unset.measured).toMatch(/speed limits not set/)
    expect(unset.sourced).toMatch(/NATO 13-5/)
    expect(unset.citations).not.toContain('Cook p.271-272')
    const set = check(run(ds, 'short-period', rows, null, { settings: { limits: { vsKias: 120, vmoKias: 350, mmo: 0.82 } } }), 'envelope')
    expect(set.status).toBe('pass')
    expect(check(run(ds, 'short-period', rows, null, { settings: { limits: { vmoKias: 265 } } }), 'envelope').status).toBe('warn')
  })

  it('advisory checks never fail; pitch and roll augmentation rows are both read', () => {
    const offCentre = spLog({ input: (tt) => 0.2 + 0.1 * doublet(tt, 30, TD_SP / 2) })
    const hands = check(run(offCentre, 'short-period', rowsAt(offCentre, 33, 45), null), 'hands-off-trim')
    expect(hands.status).toBe('warn')
    expect(hands.criterion).toMatch(/never fails/)
    expect(hands.citations).toContain('Cook p.49')
    const roll = check(run(spLog({ extra: (t) => ({ 'ailrn,astab': fill(t, () => 0.01) }) }), 'short-period', rowsAt(spLog(), 33, 45), null), 'other-augmentation')
    expect(roll.status).toBe('warn')
    expect(roll.measured).toMatch(/max \|ailrn,astab\| 0\.01/)
  })

  it('dutch-roll mode purity never compares the fitted channel with itself', () => {
    const dr = drLog(0)
    const rows = rowsAt(dr, 36, 66)
    const fit: FitSummary = { ...SP_FIT, periodS: 5, omegaN: 1.26, zeta: 0.12, zetaLogDec: 0.12 }
    expect(check(run(dr, 'dutch-roll', rows, fit), 'mode-purity').measured).toMatch(/from β$/)
    const onBeta = check(run(dr, 'dutch-roll', rows, fit, { channelId: '_beta,__deg' }), 'mode-purity')
    expect(onBeta.measured).toMatch(/from yaw rate$/)
    expect(onBeta.status).toBe('pass')
  })

  it('labels: time-base and hq-level carry the judgement tag; sourced numbers name their source; weight-cg cites the brief only in general', () => {
    const report = run(spLog(), 'short-period', rowsAt(spLog(), 33, 45), SP_FIT)
    const tb = check(report, 'time-base')
    expect(tb.judgement).toBe(true)
    expect(tb.criterion).toMatch(/a forward step longer than max\(1 s, 20 × the median step\)/)
    expect(tb.why).toMatch(/this app’s own conventions/)
    expect(check(report, 'mode-purity').sourced).toMatch(/FD13 p\.9/)
    expect(check(report, 'record-length').sourced).toMatch(/NATO 15-7/)
    expect(check(report, 'input-size').sourced).toMatch(/spiral release 5–20°: NATO 15-7/)
    expect(check(report, 'weight-cg').judgement).toBe(false)
    expect(check(report, 'weight-cg').why).not.toMatch(/stated as assumptions/)
    expect(check(report, 'trimmed-start').citations).not.toEqual(expect.arrayContaining(['FD12b p.38']))
    expect(check(report, 'autopilot-off').why).toMatch(/raises the phugoid’s damping artificially/)
    for (const c of report.checks) if (c.severity === 'advisory') expect(c.status).not.toBe('fail')
  })
})

describe('dynamic checklist (review of the source-audit fixes)', () => {
  const lever = (t: Float64Array): Columns => ({ 'thro1,handl': fill(t, () => 0.6) })
  const DR_FIT: FitSummary = { ...SP_FIT, periodS: 5, omegaN: 1.26, zeta: 0.03, zetaLogDec: 0.03, sigma: 0.03, cycles: 4, peaks: 8, halfLifeS: 23 }

  it('a rejected phugoid or dutch-roll fit is an analysis fix, not "Cannot confirm"; too few cycles by the fitter’s count: Fix the analysis while the log runs on, Retest at its end', () => {
    const ds = spLog()
    const poor: FitSummary = { model: 'oscillation', ok: false, r2: 0.3, message: 'Poor fit: the oscillation explains only 30 % of the variation.', periodS: 9, zeta: 0.05, zetaLogDec: NaN, omegaN: 0.7, sigma: 0.035, cycles: 1.6, peaks: 2, tau: NaN, halfLifeS: 20 }
    const ph = run(ds, 'phugoid', rowsAt(ds, 33, 44), poor)
    const rl = check(ph, 'record-length')
    expect(rl.status).toBe('not-checkable')
    expect(rl.severity).toBe('advisory')
    expect(rl.criterion).toBe('Needs an accepted fit (see fit-quality)')
    expect(ph.verdict.kind).toBe('fix-analysis')
    expect(ph.verdict.text).toBe('Fix the analysis — the fit was rejected: try another window or trend')
    // Rejected for too few cycles (the fitter rejects under 0.9): judged too short, with 16 s of log after the window.
    const few: FitSummary = { ...poor, message: 'The window holds only 0.70 cycles of the fitted oscillation: select at least one full cycle (2–5 are better).', cycles: 0.7 }
    const widen = run(ds, 'phugoid', rowsAt(ds, 33, 44), few)
    expect(check(widen, 'record-length').status).toBe('fail')
    expect(check(widen, 'record-length').severity).toBe('analysis')
    expect(check(widen, 'record-length').measured).toMatch(/^0\.70 cycles \(the rejected fit’s count\); the log runs on 16 s past the window$/)
    expect(widen.verdict.text).toBe('Fix the analysis — too few cycles in the window: widen it, the log runs on past it; the fit was rejected: try another window or trend')
    const ends = run(ds, 'phugoid', rowsAt(ds, 33, 60), few)
    expect(check(ends, 'record-length').severity).toBe('critical')
    expect(ends.verdict.text).toBe('Retest required — too few cycles recorded (the log ends)')
    // The dutch roll: an accepted run is acceptable; a rejected fit is an analysis fix.
    const dr = drLog(0, { extra: lever })
    expect(run(dr, 'dutch-roll', rowsAt(dr, 36, 66), DR_FIT).verdict.kind).toBe('acceptable')
    const drPoor = run(dr, 'dutch-roll', rowsAt(dr, 36, 66), { ...DR_FIT, ok: false, message: 'Poor fit: the oscillation explains only 40 % of the variation.', cycles: 6 })
    expect(check(drPoor, 'record-length').status).toBe('not-checkable')
    expect(drPoor.verdict.text).toBe('Fix the analysis — the fit was rejected: try another window or trend')
  })

  it('dutch roll: too few cycles is an analysis fix while the log runs on past the window, and critical at its end', () => {
    const dr = drLog(0, { extra: lever })
    const short = { ...DR_FIT, cycles: 1.2 }
    const widen = run(dr, 'dutch-roll', rowsAt(dr, 36, 50), short)
    const rl = check(widen, 'record-length')
    expect(rl.status).toBe('fail')
    expect(rl.severity).toBe('analysis')
    expect(rl.hint).toMatch(/^Widen the window: the log runs on 20 s past it/)
    expect(rl.criterion).toMatch(/^pass ≥ 3 cycles or the envelope below 10 %; warn 1\.5–3; fail < 1\.5/)
    expect(widen.verdict.text).toBe('Fix the analysis — too few cycles in the window: widen it, the log runs on past it')
    const ends = run(dr, 'dutch-roll', rowsAt(dr, 36, 70), short)
    expect(check(ends, 'record-length').severity).toBe('critical')
    expect(ends.verdict.kind).toBe('retest')
    expect(ends.verdict.text).toBe('Retest required — too few cycles recorded (the log ends)')
  })

  it('the threshold table: only the numbers a source gives are untagged, and the per-mode T lengths and look-backs are named', () => {
    const untagged = Object.entries(CHECK_THRESHOLDS).filter(([, th]) => !th.judgement).map(([name]) => name).sort()
    expect(untagged).toEqual(['phTdMinS', 'pulseMaxS', 'rateMinHz', 'rollBankMaxDeg', 'spTdMinS', 'spiralBankMaxDeg', 'spiralBankMinDeg', 'vsFactor'])
    expect(CHECK_THRESHOLDS.pulseMaxS).toEqual({ value: 1, unit: 's', source: 'Cook p.176', judgement: false })
    expect(CHECK_THRESHOLDS.rateMinHz.source).toBe('NATO 15-3, NATO 15-5')
    expect(CHECK_THRESHOLDS.rollBankMaxDeg.source).toMatch(/^NATO 15-6 .*borrowed/)
    expect(CHECK_THRESHOLDS.vsFactor.source).toMatch(/^NATO 13-5 .*borrowed/)
    for (const [, th] of Object.entries(CHECK_THRESHOLDS)) if (th.judgement) expect(th.source).toMatch(/^(EJ|App )/)
    expect(CHECK_THRESHOLDS.lookbackPhS).toEqual({ value: 90, unit: 's', source: 'EJ', judgement: true })
    expect(CHECK_THRESHOLDS.tTrimRsS).toEqual({ value: 3, unit: 's', source: 'EJ', judgement: true })
    // Overrides by name: a 200 s phugoid look-back makes an input 125 s back near (no longer "beyond the look-back").
    const ph = phLog(10)
    const near = run(ph, 'phugoid', rowsAt(ph, 150, 290), PH_FIT, { thresholds: { lookbackPhS: 200 } })
    expect(near.input?.far).toBe(false)
    const found = check(near, 'input-detected')
    expect(found.status).toBe('warn')
    expect(found.measured).not.toMatch(/beyond/)
    expect(found.criterion).toMatch(/beyond the app’s 200 s look-back included/)
    expect(found.hint).toMatch(/^Move the window nearer the input/)
    // A short-period trim window of 5 s instead of 10 s.
    const sp = spLog()
    expect(run(sp, 'short-period', rowsAt(sp, 33, 45), null, { thresholds: { tTrimSpS: 5 } }).trim?.seconds).toBeCloseTo(5, 1)
  })

  it('the search for a far input stops at the last power, configuration or trim change before the window', () => {
    // An elevator input at 200 s, the throttle moved at 800 s and the flaps at 900 s; a phugoid window at 1300–1450 s.
    const t = times(1500, 10)
    const stick = fill(t, (tt) => 0.1 * pulse(tt, 200, 5))
    const changed = flatLog(t, {
      '_elev,stick': stick,
      '_elev,_surf': stick,
      'thro1,handl': fill(t, (tt) => (tt >= 800 ? 0.7 : 0.6)),
      '_flap,postn': fill(t, (tt) => (tt >= 900 ? 0.25 : 0)),
    })
    const report = run(changed, 'phugoid', rowsAt(changed, 1300, 1450), PH_FIT)
    expect(report.input).toBeNull()
    const found = check(report, 'input-detected')
    expect(found.status).toBe('fail')
    expect(found.measured).toBe('no input on _elev,stick after the configuration changed at 900.0 s')
    expect(found.hint).toMatch(/a run does not span a power, configuration or trim change/)
    expect(report.verdict.text).toBe('Retest required — no input found before the window')
    // Without the changes the same input is found, further back than the look-back: a note.
    const quiet = flatLog(t, { '_elev,stick': stick, '_elev,_surf': stick })
    const far = run(quiet, 'phugoid', rowsAt(quiet, 1300, 1450), PH_FIT)
    expect(far.input?.far).toBe(true)
    expect(check(far, 'input-detected').status).toBe('warn')
  })

  it('a short-period pulse of exactly Cook’s second passes at 25 and 10 samples/s (one sample interval for the interpolated edges)', () => {
    const rect = (rate: number, width: number) => {
      const t = times(60, rate)
      const stick = fill(t, (tt) => (tt >= 30 && tt < 30 + width - 1e-9 ? 0.1 : 0))
      const ds = flatLog(t, { '_elev,stick': stick, '_elev,_surf': stick })
      return check(run(ds, 'short-period', rowsAt(ds, 32, 45), null), 'input-shape')
    }
    const at25 = rect(25, 1)
    expect(at25.measured).toBe('pulse, 1.03 s')
    expect(at25.status).toBe('pass')
    expect(at25.criterion).toMatch(/one sample interval \(0\.04 s\) allowed for the interpolated edges/)
    const at10 = rect(10, 1)
    expect(at10.measured).toBe('pulse, 1.08 s')
    expect(at10.status).toBe('pass')
    expect(rect(25, 1.2).status).toBe('warn')
  })

  it('reasons, criteria and labels: the roll-start bank names itself in the verdict; criteria follow the threshold table; α_max alone is not a speed limit', () => {
    const decay = (ds: Dataset) => run(ds, 'roll-subsidence', rowsAt(ds, 43.3, 48), rsFit())
    const steep = decay(rsLog(65))
    expect(steep.verdict.text).toMatch(/the roll started from more than 60° of bank/)
    expect(steep.verdict.text).not.toMatch(/not trimmed and steady/)
    expect(decay(rsLog(65, 3)).verdict.text).toMatch(/not trimmed and steady before the input; the roll started from more than 60° of bank/)
    expect(check(steep, 'trimmed-start').hint).toMatch(/NATO’s usual bank-to-bank starts are 30, 45 or 60°/)
    // Criteria built from the (overridable) thresholds.
    const sp = spLog()
    const rows = rowsAt(sp, 33, 45)
    const custom = run(sp, 'short-period', rows, null, { thresholds: { trimRange: 0.004, trimRangeWarn: 0.01, astabOff: 2e-4, configRange: 0.002, spMaxCycles: 3 } })
    expect(check(custom, 'trim-fixed').criterion).toBe('pass ≤ 0.004; warn ≤ 0.01; fail above (pilot trim, autotrim or speed trim)')
    expect(check(custom, 'other-augmentation').criterion).toMatch(/≤ 2e−4 from T to R/)
    expect(check(custom, 'configuration-constant').criterion).toMatch(/^pass: every range ≤ 0\.002/)
    expect(check(custom, 'input-shape').criterion).toMatch(/3–6 lobes/)
    const dr = drLog(0, { extra: lever })
    const yd = check(run(dr, 'dutch-roll', rowsAt(dr, 36, 66), null, { thresholds: { astabOn: 2e-3 } }), 'yaw-damper-off')
    expect(yd.criterion).toMatch(/or ≤ 2e−3; fail > 2e−3$/)
    // The autopilot and input criteria state every line the code applies.
    const report = run(sp, 'short-period', rows, null)
    expect(check(report, 'autopilot-off').criterion).toMatch(/over the look-back before R when no input was found/)
    expect(check(report, 'input-detected').criterion).toMatch(/a window starting during the input \(other modes than roll subsidence\)/)
    // Only a speed limit ends the "speed limits not set" note.
    const alphaOnly = check(run(sp, 'short-period', rows, null, { settings: { limits: { alphaMaxDeg: 15 } } }), 'envelope')
    expect(alphaOnly.status).toBe('info')
    expect(alphaOnly.measured).toMatch(/speed limits not set/)
  })

  it('source wording: Cook’s 30° is an illustration, NATO’s starts are usual, and the 3–10 % phugoid band is the app’s', () => {
    const report = run(spLog(), 'short-period', rowsAt(spLog(), 33, 45), SP_FIT)
    const size = check(report, 'input-size')
    expect(size.sourced).toMatch(/phugoid speed change about 5 %: Cook p\.177;/)
    expect(size.sourced).not.toMatch(/3–10 %/)
    expect(size.why).toMatch(/the 3–10 % pass band around it is engineering judgement/)
    expect(size.why).toMatch(/usually from 30, 45 or 60° \(NATO 15-6\)/)
    expect(size.why).toMatch(/\(NATO 15-7; up to 20°, MIL p\.99\)/)
    expect(check(report, 'trimmed-start').sourced).toMatch(/^roll start: a steady turn first is usual, −30° in the illustration \(Cook p\.211\)/)
    expect(check(report, 'mode-purity').sourced).toMatch(/Lanchester frequency ωp = g√2\/V0/)
    expect(check(report, 'envelope').why).toMatch(/1\.3 V_S is borrowed from NATO’s usual approach speed \(NATO 13-5\)/)
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
    expect(csv.split('\r\n')[0]).toBe('checklist,set,point,check,title,status,severity,measured,criterion,judgement,sourced,follows,citations,hint')
    expect(csv).toContain("Short period: =bad name")
    expect(csv).toMatch(/,verdict,Verdict,acceptable,/)
    const tsv = checklistCsv(dynamicReportRows(report, 'w'), '\t')
    expect(tsv.split('\r\n')[1].split('\t')).toHaveLength(14)
  })
})
