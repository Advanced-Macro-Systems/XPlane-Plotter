import { describe, expect, it } from 'vitest'
import type { Dataset, TestPoint, XYConfig } from '../types'
import { makeLog, pointAt, ramp, type Columns } from './fixtures'
import { runPerfChecks, type PerfCheckSettings } from './performance'
import { recutFailing, recutPlan } from './recut'

// A synthetic twin jet (invented values, unrelated to any log): S = 1000 ft², CD0 = 0.025, K = 0.04, lift line
// C_L = 0.08/deg × (α + 2°), κ = 0, W from 100,000 lb falling by the integrated fuel flow, 8,000 ft ISA, calm,
// 8,000 ft AGL, TSFC 0.10 lb/(lbf·h) (unrealistically low so the burn stays under 1 %), __L/D,*etaP = 0. Each point:
// 120 s at a fixed lever, a 60 s record, then 30 s to the next speed; thrust = D/cos α, so dV/dt = dh/dt = 0.
const RATE = 10
const S = 1000
const CD0 = 0.025
const K = 0.04
const KT = 1.68781
const RHO0 = 0.0023769
const SETTLE = 120
const RECORD = 60
const CHANGE = 30
const BLOCK = SETTLE + RECORD + CHANGE

function isa(hp: number) {
  const theta = 1 - 6.8755856e-6 * hp
  const delta = theta ** 5.2558797
  return { theta, sigma: delta / theta, a: 661.48 * Math.sqrt(theta), tK: 288.15 * theta, delta }
}

interface PerfSpec {
  speeds?: number[]
  tsfc?: (k: number) => number
  weight?: (k: number) => number
  altitude?: (k: number) => number
  dIsa?: number
  record?: number
  etaP?: number
  power?: boolean
  hook?: (cols: Record<string, Float64Array>, t: Float64Array, recs: { k: number; start: number; end: number }[]) => void
  drop?: string[]
}

interface Fixture {
  ds: Dataset
  points: TestPoint[]
  recs: { k: number; start: number; end: number }[]
}

function perfFixture(spec: PerfSpec = {}): Fixture {
  const speeds = spec.speeds ?? [170, 190, 210, 230, 250, 270, 290, 310, 330]
  const record = spec.record ?? RECORD
  const n = speeds.length * BLOCK * RATE
  const t = Float64Array.from({ length: n }, (_, i) => i / RATE)
  const cols: Record<string, Float64Array> = {}
  const col = (token: string) => (cols[token] ??= new Float64Array(n))
  const recs = speeds.map((_, k) => ({ k, start: k * BLOCK + SETTLE, end: k * BLOCK + SETTLE + record }))
  let w = 100000
  let fuel = 20000
  let ffPrev = NaN
  for (let i = 0; i < n; i += 1) {
    const k = Math.min(speeds.length - 1, Math.floor(t[i] / BLOCK))
    const inBlock = t[i] - k * BLOCK
    const next = speeds[Math.min(speeds.length - 1, k + 1)]
    const v = inBlock > SETTLE + RECORD ? speeds[k] + (next - speeds[k]) * ramp(inBlock, SETTLE + RECORD, CHANGE) : speeds[k]
    const hp = spec.altitude?.(k) ?? 8000
    const atm = isa(hp)
    const tK = atm.tK + (spec.dIsa ?? 0)
    const sigma = (atm.sigma * atm.tK) / tK
    const rho = RHO0 * sigma
    const weight = spec.weight ? spec.weight(k) : w
    const vf = v * KT
    const q = 0.5 * rho * vf * vf
    const cl = weight / (q * S)
    const alpha = cl / 0.08 - 2
    const cd = CD0 + K * cl * cl
    const drag = q * S * cd
    const thrust = drag / Math.cos((alpha * Math.PI) / 180)
    const tsfc = spec.tsfc?.(k) ?? 0.1
    const ff = tsfc * thrust
    const a = 661.48 * Math.sqrt(tK / 288.15)
    col('_Vind,_kias')[i] = v * Math.sqrt(sigma)
    col('_Vind,_keas')[i] = v * Math.sqrt(sigma)
    col('Vtrue,_ktas')[i] = v
    col('Vtrue,_ktgs')[i] = v
    col('_Mach,ratio')[i] = v / a
    col('__VVI,__fpm')[i] = 0
    col('Gload,norml')[i] = Math.cos((alpha * Math.PI) / 180)
    col('alpha,__deg')[i] = alpha
    col('_beta,__deg')[i] = 0
    col('vpath,__deg')[i] = 0
    col('pitch,__deg')[i] = alpha
    col('_roll,__deg')[i] = 0
    col('hding,_true')[i] = 0
    col('__lat,__deg')[i] = 51 + (i > 0 ? cols['__lat,__deg'][i - 1] - 51 + v / 216000 / RATE : 0)
    col('__lon,__deg')[i] = -2.5
    col('___CG,ftMSL')[i] = hp + 300
    col('_gear,ftagl')[i] = 8000
    col('p-alt,ftMSL')[i] = hp
    col('total,___lb')[i] = weight
    col('gross,___lb')[i] = 150000
    col('_fuel,___lb')[i] = fuel
    col('___cg,ftref')[i] = 1
    col('_flap,postn')[i] = 0
    col('_slat,ratio')[i] = 0
    col('sbrak,postn')[i] = 0
    col('_trim,_elev')[i] = 0.2
    col('_gear,__0/1')[i] = 0
    const lever = speeds[k] / 400
    col('thro1,handl')[i] = inBlock > SETTLE + RECORD ? lever + (next / 400 - lever) * ramp(inBlock, SETTLE + RECORD, 2) : lever
    col('thro2,handl')[i] = cols['thro1,handl'][i]
    col('thrst,_1,lb')[i] = thrust / 2
    col('thrst,_2,lb')[i] = thrust / 2
    col('FF__1,_lb/h')[i] = ff / 2
    col('FF__2,_lb/h')[i] = ff / 2
    if (spec.power) {
      col('engn1,___hp')[i] = (thrust * vf) / 550 / 2
      col('engn2,___hp')[i] = (thrust * vf) / 550 / 2
    }
    col('_drag,___lb')[i] = drag
    col('___cl,total')[i] = cl
    col('___cd,total')[i] = cd
    col('S-ref,ft*ft')[i] = S
    col('__L/D,*etaP')[i] = spec.etaP ?? 0
    col('AMtmp,_degC')[i] = tK - 273.15
    col('_dens,ratio')[i] = sigma
    col('_wind,knots')[i] = 0
    col('_wind,v_fpm')[i] = 0
    col('_turb,_locl')[i] = 0
    // Weight and fuel fall by the integrated fuel flow (trapezoids).
    if (i + 1 < n) {
      const burn = Number.isFinite(ffPrev) ? ((ff + ff) / 2) * (1 / RATE / 3600) : (ff * (1 / RATE)) / 3600
      w -= burn
      fuel -= burn
    }
    ffPrev = ff
  }
  spec.hook?.(cols, t, recs)
  const kept: Columns = {}
  for (const [token, values] of Object.entries(cols)) if (!spec.drop?.includes(token)) kept[token] = values
  const formulas: Record<string, [string, Float64Array]> = {
    'fx:total_thrust': ['thrst_1_lb + thrst_2_lb', Float64Array.from(cols['thrst,_1,lb'], (x, i) => x + cols['thrst,_2,lb'][i])],
  }
  const ds = makeLog(t, kept, { formulas })
  const points = recs.map((r) => pointAt(ds, `${speeds[r.k]} KTAS`, r.start, r.end))
  return { ds, points, recs }
}

interface RunOptions {
  points?: TestPoint[]
  x?: string
  y?: string
  fit?: XYConfig['fit']
  settings?: PerfCheckSettings
  ds?: Dataset
}

function run(fx: Fixture, o: RunOptions = {}) {
  const ds = o.ds ?? fx.ds
  const ch = (id: string) => ds.channels.find((c) => c.id === id) ?? null
  return runPerfChecks({ ds, points: o.points ?? fx.points, x: ch(o.x ?? 'Vtrue,_ktas'), y: ch(o.y ?? 'fx:total_thrust'), fit: o.fit ?? 'drag-model', fitTarget: 'means', settings: o.settings })
}

type Report = ReturnType<typeof run>
const setCheck = (r: Report, id: string) => {
  const c = r.set.find((k) => k.id === id)
  if (!c) throw new Error(`no set check ${id}`)
  return c
}
const pointCheck = (r: Report, name: string, id: string) => {
  const c = r.points.find((p) => p.name === name)?.checks.find((k) => k.id === id)
  if (!c) throw new Error(`no ${id} at ${name}`)
  return c
}
const status = (r: Report, name: string) => r.points.find((p) => p.name === name)?.status

/** Overwrites a column inside one record (plus 1 s each side). */
function inRecord(cols: Record<string, Float64Array>, t: Float64Array, rec: { start: number; end: number }, token: string, f: (time: number, v: number) => number) {
  const v = cols[token]
  for (let i = 0; i < t.length; i += 1) if (t[i] >= rec.start - 1 && t[i] <= rec.end + 1) v[i] = f(t[i], v[i])
}

const DEFAULT = perfFixture()

describe('performance checklist (synthetic twin jet)', () => {
  it('1: the default set is acceptable — 9 points used; back side info at 170, 190 and 210; open U1, U3, U5, U7', () => {
    const r = run(DEFAULT)
    expect(r.verdict.kind).toBe('acceptable')
    expect(r.verdict.text).toMatch(/^Acceptable for analysis — 9 points used,/)
    expect(r.points.every((p) => p.checks.every((c) => c.status !== 'fail'))).toBe(true)
    expect(r.set.every((c) => c.status !== 'fail')).toBe(true)
    for (const name of ['170 KTAS', '190 KTAS', '210 KTAS']) expect(pointCheck(r, name, 'near-stall').status).toBe('info')
    expect(pointCheck(r, '250 KTAS', 'near-stall').status).toBe('pass')
    expect(r.open.map((o) => o.id)).toEqual(['U1', 'U3', 'U5', 'U7'])
    // The optima land near the analytic ones for the set's own weight: V_E = √(2W/(ρS))·(K/CD0)^¼, V_R = 3^¼ V_E.
    const w = r.metrics.reduce((s, m) => s + m.w, 0) / r.metrics.length
    const vE = Math.sqrt((2 * w) / (RHO0 * isa(8000).sigma * S)) * (K / CD0) ** 0.25 / KT
    expect(r.fitU?.vE).toBeGreaterThan(vE * 0.97)
    expect(r.fitU?.vE).toBeLessThan(vE * 1.03)
    expect(r.fitU?.vR).toBeGreaterThan(vE * 3 ** 0.25 * 0.97)
    expect(setCheck(r, 'bracket-endurance').status).toBe('pass')
    expect(setCheck(r, 'bracket-range').status).toBe('pass')
    expect(setCheck(r, 'construction').status).toBe('pass')
    expect(pointCheck(r, '250 KTAS', 'thrust-drag').status).toBe('pass')
    expect(setCheck(r, 'fuel-bookkeeping').status).toBe('pass')
  })

  it('2: record length and sample rate: 30 s and 8 s warn, 4 s fails; 0.1 Hz fails, 1 Hz passes; a 2 s gap warns', () => {
    for (const [seconds, expected] of [[30, 'warn'], [8, 'warn'], [4, 'fail']] as const) {
      const fx = perfFixture({ record: seconds })
      expect(pointCheck(run(fx), '250 KTAS', 'record-length').status).toBe(expected)
    }
    const thin = (k: number) => {
      const ds = dropRows(DEFAULT.ds, (_, i) => i % k !== 0)
      return run(DEFAULT, { ds, points: DEFAULT.recs.map((rec, j) => pointAt(ds, DEFAULT.points[j].name, rec.start, rec.end)) })
    }
    expect(pointCheck(thin(100), '250 KTAS', 'sample-rate').status).toBe('fail')
    expect(pointCheck(thin(100), '250 KTAS', 'record-length').status).toBe('fail')
    expect(pointCheck(thin(10), '250 KTAS', 'sample-rate').status).toBe('pass')
    const rec = DEFAULT.recs[4]
    const gap = dropRows(DEFAULT.ds, (time) => time > rec.start + 20 && time < rec.start + 22)
    const gapRun = run(DEFAULT, { ds: gap, points: DEFAULT.recs.map((r0, j) => pointAt(gap, DEFAULT.points[j].name, r0.start, r0.end)) })
    expect(pointCheck(gapRun, '250 KTAS', 'sample-rate').status).toBe('warn')
  })

  it('3: a lever change 30 s before a flat, steady record is info; with a +1 kt/min drift it warns; 90 s before passes; 20 s of log is not checkable', () => {
    const lever = (before: number, drift = 0) =>
      perfFixture({
        hook: (cols, t, recs) => {
          const rec = recs[4]
          for (const token of ['thro1,handl', 'thro2,handl']) {
            const v = cols[token]
            for (let i = 0; i < t.length; i += 1) if (t[i] >= rec.start - SETTLE && t[i] < rec.start - before) v[i] += 0.05
          }
          if (drift) inRecord(cols, t, rec, 'Vtrue,_ktas', (tt, v) => v + (drift * (tt - rec.start - 30)) / 60)
        },
      })
    expect(pointCheck(run(lever(30)), '250 KTAS', 'stabilised').status).toBe('info')
    expect(pointCheck(run(lever(30, 1)), '250 KTAS', 'stabilised').status).toBe('warn')
    expect(pointCheck(run(lever(90)), '250 KTAS', 'stabilised').status).toBe('pass')
    const rec = DEFAULT.recs[0]
    const cropped = dropRows(DEFAULT.ds, (time) => time < rec.start - 20)
    const c = run(DEFAULT, { ds: cropped, points: [pointAt(cropped, '170 KTAS', rec.start, rec.end)] })
    expect(pointCheck(c, '170 KTAS', 'stabilised').status).toBe('not-checkable')
  })

  it('4: a lever step of +0.05 (+8 % thrust) inside the 250 KTAS record fails it; a change 0.5 s after a record passes', () => {
    const fx = perfFixture({
      hook: (cols, t, recs) => {
        const rec = recs[4]
        for (const token of ['thro1,handl', 'thro2,handl']) inRecord(cols, t, rec, token, (tt, v) => (tt >= rec.start + 30 ? v + 0.05 : v))
        for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) inRecord(cols, t, rec, token, (tt, v) => (tt >= rec.start + 30 ? v * 1.08 : v))
      },
    })
    const r = run(fx)
    expect(pointCheck(r, '250 KTAS', 'throttle-fixed').status).toBe('fail')
    expect(status(r, '250 KTAS')).toBe('excluded')
    expect(r.points.find((p) => p.name === '250 KTAS')?.label).toBe('Retest')
    expect(r.verdict.text).toMatch(/^Acceptable for analysis — 8 points used, 1 left out \(throttle moved inside the record: 250 KTAS\)/)
    expect(r.verdict.text).toMatch(/tick 'Fit the used points only'/)
    const after = perfFixture({
      hook: (cols, t, recs) => {
        const rec = recs[4]
        for (const token of ['thro1,handl', 'thro2,handl']) {
          const v = cols[token]
          for (let i = 0; i < t.length; i += 1) if (t[i] >= rec.end + 0.5 && t[i] < rec.end + 5) v[i] += 0.05
        }
      },
    })
    expect(pointCheck(run(after), '250 KTAS', 'throttle-fixed').status).toBe('pass')
  })

  it('5: autothrottle-like levers warn and show U2 (throttle-fixed warns on the lever range); _auto,throt 1 warns, 0 passes', () => {
    const at = perfFixture({
      hook: (cols, t, recs) => {
        const rec = recs[4]
        let i0 = 0
        for (const token of ['thro1,handl', 'thro2,handl']) {
          i0 = 0
          inRecord(cols, t, rec, token, (_, v) => {
            i0 += 1
            const phase = i0 % 8
            return v + 0.001 * (phase < 4 ? phase : 8 - phase)
          })
        }
      },
    })
    const r = run(at)
    expect(pointCheck(r, '250 KTAS', 'autothrottle-off').status).toBe('warn')
    expect(pointCheck(r, '250 KTAS', 'throttle-fixed').status).toBe('warn')
    expect(r.open.map((o) => o.id)).toContain('U2')
    const code = (value: number) => perfFixture({ hook: (cols, t) => (cols['_auto,throt'] = Float64Array.from(t, () => value)) })
    expect(pointCheck(run(code(1)), '250 KTAS', 'autothrottle-off').status).toBe('warn')
    expect(pointCheck(run(code(0)), '250 KTAS', 'autothrottle-off').status).toBe('pass')
  })

  it('6: a +1 kt/min drift warns speed-steady with ΔT_acc = (W/g)·dV/dt; a ±3 kt sinusoid fails', () => {
    const drift = perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], 'Vtrue,_ktas', (tt, v) => v + (tt - recs[4].start - 30) / 60) })
    const r = run(drift)
    expect(pointCheck(r, '250 KTAS', 'speed-steady').status).toBe('warn')
    const m = r.metrics[4]
    const expected = (m.w / 32.174) * (1 / 60) * KT
    expect(Math.abs(m.acc / expected - 1)).toBeLessThan(1e-9)
    const wobble = perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], 'Vtrue,_ktas', (tt, v) => v + 3 * Math.sin(0.4 * tt)) })
    expect(pointCheck(run(wobble), '250 KTAS', 'speed-steady').status).toBe('fail')
  })

  it('7: climbing at 190 KTAS: 10 fpm passes, 30 fpm warns energy-correction, 300 fpm fails; ±80 ft porpoising fails level', () => {
    const climb = (fpm: number) => perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[1], '___CG,ftMSL', (tt, v) => v + (fpm / 60) * (tt - recs[1].start)) })
    for (const [fpm, expected] of [[10, 'pass'], [30, 'warn'], [300, 'fail']] as const) {
      const r = run(climb(fpm))
      const m = r.metrics[1]
      const share = (m.w * (fpm / 60)) / (m.v * KT) / m.dCorr
      expect(Math.abs(m.share - share) / share).toBeLessThan(1e-6)
      expect(pointCheck(r, '190 KTAS', 'energy-correction').status).toBe(expected)
      if (expected === 'fail') expect(status(r, '190 KTAS')).toBe('excluded')
      if (expected === 'warn') expect(status(r, '190 KTAS')).toBe('correct')
    }
    const porpoise = perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[1], '___CG,ftMSL', (tt, v) => v + 80 * Math.sin(0.2 * tt)) })
    expect(pointCheck(run(porpoise), '190 KTAS', 'level').status).toBe('fail')
  })

  it('8: thrust = D/cos α + ΔT_E matches the drag; 5 % high thrust warns without changing the verdict', () => {
    const matched = perfFixture({
      hook: (cols, t, recs) => {
        const rec = recs[4]
        inRecord(cols, t, rec, '___CG,ftMSL', (tt, v) => v + 0.2 * (tt - rec.start))
        for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) {
          inRecord(cols, t, rec, token, (tt, v) => {
            const i = Math.round(tt * RATE)
            const vf = cols['Vtrue,_ktas'][i] * KT
            return v + (cols['total,___lb'][i] * 0.2) / vf / 2 / Math.cos((cols['alpha,__deg'][i] * Math.PI) / 180)
          })
        }
      },
    })
    const tdc = pointCheck(run(matched), '250 KTAS', 'thrust-drag')
    expect(tdc.status).toBe('pass')
    expect(Math.abs(Number(tdc.measured.match(/corrected ([−+\d.]+)/)?.[1].replace('−', '-')))).toBeLessThan(0.1)
    const high = perfFixture({ hook: (cols, t, recs) => ['thrst,_1,lb', 'thrst,_2,lb'].forEach((token) => inRecord(cols, t, recs[4], token, (_, v) => v * 1.05)) })
    const r = run(high)
    expect(pointCheck(r, '250 KTAS', 'thrust-drag').status).toBe('warn')
    expect(r.verdict.kind).toBe('acceptable')
  })

  it('9: configuration: flaps at one point fail configuration-match; flaps everywhere warn (not clean); no gear warns; moving flaps fail', () => {
    const one = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[3], '_flap,postn', () => 0.25) }))
    expect(pointCheck(one, '230 KTAS', 'configuration-match').status).toBe('fail')
    expect(status(one, '230 KTAS')).toBe('excluded')
    const all = run(perfFixture({ hook: (cols) => cols['_flap,postn'].fill(0.25) }))
    expect(pointCheck(all, '230 KTAS', 'configuration-match').status).toBe('warn')
    expect(pointCheck(run(perfFixture({ drop: ['_gear,__0/1'] })), '230 KTAS', 'configuration-constant').status).toBe('warn')
    const moving = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[3], '_flap,postn', (tt) => 0.1 * ramp(tt, recs[3].start + 20, 2)) }))
    expect(pointCheck(moving, '230 KTAS', 'configuration-constant').status).toBe('fail')
  })

  it('10: weight: a formula with gross_lb fails (fix the analysis); a 2 % burn warns with U4; 100,000 → 80,000 lb fails; a constant weight warns', () => {
    const fx = DEFAULT
    const total = fx.ds.channels.find((c) => c.id === 'fx:total_thrust')!
    const grossDs: Dataset = { ...fx.ds, channels: [...fx.ds.channels, { ...total, id: 'fx:thrust_w', derived: { expression: 'total_thrust * gross_lb / 150000' } }] }
    const gross = run(fx, { ds: grossDs, y: 'fx:thrust_w' })
    expect(setCheck(gross, 'weight-column').status).toBe('fail')
    expect(gross.verdict.kind).toBe('fix-analysis')
    const burn = run(perfFixture({ tsfc: () => 0.6 }))
    expect(setCheck(burn, 'weight-spread').status).toBe('warn')
    expect(burn.open.map((o) => o.id)).toContain('U4')
    const direct = run(perfFixture({ weight: (k) => 100000 - (2000 * k) / 8 }))
    expect(setCheck(direct, 'weight-spread').status).toBe('warn')
    const heavy = run(perfFixture({ weight: (k) => 100000 - (20000 * k) / 8 }))
    expect(setCheck(heavy, 'weight-spread').status).toBe('fail')
    expect(heavy.verdict.kind).toBe('fix-analysis')
    const frozen = run(perfFixture({ hook: (cols) => cols['total,___lb'].fill(100000) }))
    expect(setCheck(frozen, 'weight-column').status).toBe('warn')
  })

  it('11: altitude: 8,000 and 8,500 ft warn altitude-band; 8,000 and 12,000 ft fail (fix the analysis)', () => {
    const near = run(perfFixture({ altitude: (k) => (k % 2 ? 8500 : 8000) }))
    expect(setCheck(near, 'altitude-band').status).toBe('warn')
    const far = run(perfFixture({ altitude: (k) => (k % 2 ? 12000 : 8000) }))
    expect(setCheck(far, 'altitude-band').status).toBe('fail')
    expect(far.verdict.kind).toBe('fix-analysis')
  })

  it('12: point count: drag model 5 pass, 3 warn, 2 fail; cubic 6 pass, 5 warn, 4 fail', () => {
    const take = (n: number, fit: XYConfig['fit']) => setCheck(run(DEFAULT, { points: DEFAULT.points.slice(0, n), fit }), 'point-count').status
    expect(take(5, 'drag-model')).toBe('pass')
    expect(take(3, 'drag-model')).toBe('warn')
    expect(take(2, 'drag-model')).toBe('fail')
    expect(take(6, 'poly3')).toBe('pass')
    expect(take(5, 'poly3')).toBe('warn')
    expect(take(4, 'poly3')).toBe('fail')
  })

  it('13: bracketing the plotted curve (no fuel flow): one point below V_E or limited extrapolation warn; beyond two spacings fails', () => {
    const noFf = perfFixture({ drop: ['FF__1,_lb/h', 'FF__2,_lb/h'] })
    const between = (lo: number, hi: number) => run(noFf, { points: noFf.points.filter((p) => parseInt(p.name) >= lo && parseInt(p.name) <= hi) })
    expect(setCheck(between(210, 330), 'bracket-endurance').status).toBe('warn')
    expect(setCheck(between(230, 330), 'bracket-endurance').status).toBe('warn')
    expect(setCheck(between(230, 330), 'bracket-endurance').hint).toMatch(/limited extrapolation/i)
    const slow = between(270, 330)
    expect(setCheck(slow, 'bracket-endurance').status).toBe('fail')
    expect(slow.verdict.text).toMatch(/^Retest required — fly slower points/)
    expect(setCheck(between(170, 290), 'bracket-range').status).toBe('warn')
    expect(setCheck(between(170, 270), 'bracket-range').status).toBe('warn')
    expect(setCheck(between(170, 230), 'bracket-range').status).toBe('fail')
  })

  it('14: the jet fuel-flow parts: both pass on the default set; edge and still-rising warnings never change the verdict', () => {
    const r = run(DEFAULT)
    // Thrust = D/cos α moves the least fuel flow a point faster than the drag minimum; it stays inside the data.
    expect(setCheck(r, 'bracket-endurance').measured).toMatch(/lowest corrected fuel flow at (210|230) kt \([2-9] slower, [2-9] faster\)/)
    expect(setCheck(r, 'bracket-endurance').status).toBe('pass')
    expect(setCheck(r, 'bracket-range').measured).toMatch(/specific air range peaks at (290|310) kt \([12] faster/)
    const fast = run(DEFAULT, { points: DEFAULT.points.filter((p) => parseInt(p.name) >= 210) })
    expect(setCheck(fast, 'bracket-endurance').hint).toMatch(/edge of the data/)
    expect(fast.verdict.kind).toBe('acceptable')
    const slow = run(DEFAULT, { points: DEFAULT.points.filter((p) => parseInt(p.name) <= 290) })
    expect(setCheck(slow, 'bracket-range').hint).toMatch(/still rising/)
    expect(slow.verdict.kind).toBe('acceptable')
  })

  it('15: near the stall: a 5 % lift deficit and 8 % polar excess at 170 KTAS make it "plot only"; 2.5 % is info', () => {
    const stall = (deficit: number, excess: number) =>
      perfFixture({
        hook: (cols, t, recs) => {
          inRecord(cols, t, recs[0], '___cl,total', (_, v) => v * (1 - deficit))
          for (const token of ['thrst,_1,lb', 'thrst,_2,lb', '_drag,___lb', '___cd,total']) inRecord(cols, t, recs[0], token, (_, v) => v * (1 + excess))
        },
      })
    const r = run(stall(0.05, 0.08))
    expect(pointCheck(r, '170 KTAS', 'near-stall').status).toBe('warn')
    expect(status(r, '170 KTAS')).toBe('plot-only')
    expect(r.points.find((p) => p.name === '170 KTAS')?.label).toBe('Plot only')
    const mild = run(stall(0.025, 0))
    expect(pointCheck(mild, '170 KTAS', 'near-stall').status).toBe('info')
    expect(pointCheck(mild, '170 KTAS', 'near-stall').hint).toMatch(/Approaching the stall/)
    expect(pointCheck(mild, '190 KTAS', 'near-stall').hint).toMatch(/Back side/)
  })

  it('16: Mach: the default set passes; points at 390 and 410 KTAS with 3 % excess drag warn and stay "Use"', () => {
    expect(pointCheck(run(DEFAULT), '330 KTAS', 'compressibility').status).toBe('pass')
    const fx = perfFixture({
      speeds: [170, 190, 210, 230, 250, 270, 290, 310, 330, 390, 410],
      hook: (cols, t, recs) => {
        for (const k of [9, 10]) for (const token of ['thrst,_1,lb', 'thrst,_2,lb', '_drag,___lb', '___cd,total']) inRecord(cols, t, recs[k], token, (_, v) => v * 1.03)
      },
    })
    const r = run(fx)
    expect(pointCheck(r, '390 KTAS', 'compressibility').status).toBe('warn')
    expect(pointCheck(r, '410 KTAS', 'compressibility').status).toBe('warn')
    expect(status(r, '410 KTAS')).toBe('used')
  })

  it('17: weather: a steady 20 kt wind warns (ground-speed axis fails); a 10 kt ramp or 100 fpm vertical wind fails; no row 152 or drag warns', () => {
    const windy = perfFixture({ hook: (cols) => cols['Vtrue,_ktgs'].forEach((v, i, a) => (a[i] = v + 20)) })
    const r = run(windy)
    expect(pointCheck(r, '250 KTAS', 'weather').status).toBe('warn')
    const gsAxis = run(windy, { x: 'Vtrue,_ktgs' })
    expect(setCheck(gsAxis, 'speed-axis').status).toBe('fail')
    expect(gsAxis.verdict.kind).toBe('fix-analysis')
    const ramping = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], 'Vtrue,_ktgs', (tt, v) => v + 10 * ramp(tt, recs[4].start + 10, 40)) }))
    expect(pointCheck(ramping, '250 KTAS', 'weather').status).toBe('fail')
    expect(status(ramping, '250 KTAS')).toBe('excluded')
    const updraft = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_wind,v_fpm', () => 100) }))
    expect(pointCheck(updraft, '250 KTAS', 'weather').status).toBe('fail')
    const unchecked = run(perfFixture({ drop: ['_wind,knots', '_wind,v_fpm', '_turb,_locl', '_drag,___lb'] }))
    expect(pointCheck(unchecked, '250 KTAS', 'weather').status).toBe('warn')
    expect(pointCheck(unchecked, '250 KTAS', 'weather').hint).toMatch(/vertical air motion unchecked/)
  })

  it('18: ISA + 10 K warns isa-day; without row 151 the TAS/Mach estimate agrees to 0.1 K', () => {
    const hot = perfFixture({ dIsa: 10 })
    const r = run(hot)
    expect(pointCheck(r, '250 KTAS', 'isa-day').status).toBe('warn')
    const est = run(perfFixture({ dIsa: 10, drop: ['AMtmp,_degC', '_dens,ratio'] }))
    expect(Math.abs(est.metrics[4].dIsa - 10)).toBeLessThan(0.1)
  })

  it('19: construction: a jet power curve fails; thrust with the drag model passes with U3; η_p 0.6 with thrust fails; fuel flow warns; unknown is not checkable', () => {
    const withPower = perfFixture({ power: true })
    const powerCh = { ...withPower.ds.channels.find((c) => c.id === 'fx:total_thrust')!, id: 'fx:total_engine_power', meta: { label: 'Total engine power', short: 'Total engine power', unit: 'hp', quantity: 'other', group: 'derived', known: false }, derived: { expression: 'engn1_hp + engn2_hp' } }
    const ds: Dataset = { ...withPower.ds, channels: [...withPower.ds.channels, powerCh] }
    const power = run(withPower, { ds, y: 'fx:total_engine_power', fit: 'power-model' })
    expect(setCheck(power, 'construction').status).toBe('fail')
    expect(power.verdict.kind).toBe('fix-analysis')
    const thrust = run(DEFAULT)
    expect(setCheck(thrust, 'construction').status).toBe('pass')
    expect(thrust.open.map((o) => o.id)).toContain('U3')
    expect(setCheck(run(perfFixture({ etaP: 0.6 })), 'construction').status).toBe('fail')
    const ffCh = { ...DEFAULT.ds.channels.find((c) => c.id === 'fx:total_thrust')!, id: 'fx:total_fuel_flow', meta: { label: 'Total fuel flow', short: 'Total fuel flow', unit: 'lb/h', quantity: 'other', group: 'derived', known: false }, derived: { expression: 'FF_1_lb_h + FF_2_lb_h' } }
    const ffRun = run(DEFAULT, { ds: { ...DEFAULT.ds, channels: [...DEFAULT.ds.channels, ffCh] }, y: 'fx:total_fuel_flow' })
    expect(setCheck(ffRun, 'construction').status).toBe('warn')
    const unknown = run(perfFixture({ drop: ['__L/D,*etaP'] }))
    expect(setCheck(unknown, 'construction').status).toBe('not-checkable')
    expect(unknown.verdict.kind).toBe('cannot-confirm')
  })

  it('20: fuel: rising TSFC warns; SFC stands in for fuel flow; neither is not checkable; bookkeeping passes, a 10 % larger drop warns', () => {
    expect(setCheck(run(perfFixture({ tsfc: (k) => 0.1 * (1 + 0.0125 * k) })), 'fuel-flow').status).toBe('warn')
    const sfc = perfFixture({ drop: ['FF__1,_lb/h', 'FF__2,_lb/h'], hook: (cols, t) => { cols['SFC_1,lblbh'] = Float64Array.from(t, () => 0.1); cols['SFC_2,lblbh'] = Float64Array.from(t, () => 0.1) } })
    const rs = run(sfc)
    expect(rs.metrics[4].ff).toBeCloseTo(0.1 * rs.metrics[4].thrust, 6)
    const none = run(perfFixture({ drop: ['FF__1,_lb/h', 'FF__2,_lb/h'] }))
    expect(setCheck(none, 'fuel-flow').criterion).toBe('Not checkable — log row 45 (Fuel flow (FF)) or the SFC row')
    expect(setCheck(run(DEFAULT), 'fuel-bookkeeping').status).toBe('pass')
    const leaky = perfFixture({ hook: (cols) => { const f = cols['_fuel,___lb']; const f0 = f[0]; for (let i = 0; i < f.length; i += 1) f[i] = f0 - (f0 - f[i]) * 1.1 } })
    expect(setCheck(run(leaky), 'fuel-bookkeeping').status).toBe('warn')
  })

  it('21: time base: a reset inside a record fails; one in the look-back only shortens it; real time warns', () => {
    const rec = DEFAULT.recs[4]
    const resetAt = (time: number) => {
      const row = Math.round(time * RATE)
      return { ...DEFAULT.ds, segments: [{ start: 0, end: row, reason: 'start' as const }, { start: row, end: DEFAULT.ds.rowCount, reason: 'reset' as const }] }
    }
    expect(pointCheck(run(DEFAULT, { ds: resetAt(rec.start + 30) }), '250 KTAS', 'time-base').status).toBe('fail')
    const look = run(DEFAULT, { ds: resetAt(rec.start - 30) })
    expect(pointCheck(look, '250 KTAS', 'time-base').status).toBe('pass')
    expect(['not-checkable', 'warn']).toContain(pointCheck(look, '250 KTAS', 'stabilised').status)
    const real = run(DEFAULT, { ds: { ...DEFAULT.ds, timeSourceId: '_real,_time', channels: [...DEFAULT.ds.channels, { ...DEFAULT.ds.channels[0], id: '_real,_time', token: '_real,_time' }] } })
    expect(pointCheck(real, '250 KTAS', 'time-base').status).toBe('warn')
  })

  it('22–23: α 12° level flight passes wings-level; 8° bank warns, 15° fails; β 3° warns; 300 ft AGL warns envelope', () => {
    const alpha12 = perfFixture({ hook: (cols, t, recs) => { inRecord(cols, t, recs[4], 'pitch,__deg', () => 12); inRecord(cols, t, recs[4], 'Gload,norml', () => Math.cos((12 * Math.PI) / 180)) } })
    expect(pointCheck(run(alpha12), '250 KTAS', 'wings-level').status).toBe('pass')
    const bank = (deg: number) => perfFixture({ hook: (cols, t, recs) => { inRecord(cols, t, recs[4], '_roll,__deg', () => deg); inRecord(cols, t, recs[4], 'Gload,norml', (_, v) => v * Math.cos((deg * Math.PI) / 180)) } })
    expect(pointCheck(run(bank(8)), '250 KTAS', 'wings-level').status).toBe('warn')
    expect(pointCheck(run(bank(15)), '250 KTAS', 'wings-level').status).toBe('fail')
    expect(status(run(bank(15)), '250 KTAS')).toBe('excluded')
    expect(pointCheck(run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_beta,__deg', () => 3) })), '250 KTAS', 'wings-level').status).toBe('warn')
    const low = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_gear,ftagl', () => 300) }))
    expect(pointCheck(low, '250 KTAS', 'envelope').status).toBe('warn')
    expect(low.verdict.kind).toBe('acceptable')
  })

  it('24: without row 63 the verdict is "Cannot confirm — tick rows 63 (Weight and balance)"', () => {
    const r = run(perfFixture({ drop: ['total,___lb', 'gross,___lb', '_fuel,___lb', '___cg,ftref'] }))
    expect(setCheck(r, 'weight-column').status).toBe('not-checkable')
    expect(setCheck(r, 'weight-spread').status).toBe('not-checkable')
    expect(pointCheck(r, '250 KTAS', 'energy-correction').status).toBe('not-checkable')
    expect(r.verdict.text).toBe('Cannot confirm — tick rows 63 (Weight and balance)')
  })

  it('25–26: an inferred autopilot warns autopilot-record; open items U1, U5, U7 always; U6 only with the drag output plotted', () => {
    const ap = perfFixture({
      hook: (cols, t) => {
        cols['_elev,servo'] = Float64Array.from(t, (x) => 0.02 * Math.sin(0.5 * x))
        cols['_elev,_surf'] = Float64Array.from(cols['_elev,servo'], (v) => 0.6 * v)
        cols['_elev,stick'] = new Float64Array(t.length)
      },
    })
    const r = run(ap)
    expect(setCheck(r, 'autopilot-record').status).toBe('warn')
    expect(setCheck(r, 'autopilot-record').measured).toMatch(/inferred.*autopilot 9/)
    for (const id of ['U1', 'U5', 'U7']) expect(r.open.map((o) => o.id)).toContain(id)
    expect(r.open.map((o) => o.id)).not.toContain('U6')
    expect(run(DEFAULT, { y: '_drag,___lb' }).open.map((o) => o.id)).toContain('U6')
    expect(r.verdict.kind).toBe('acceptable')
  })

  it('throttle hunting at the start of every record: the verdict says re-cut (fix the analysis), not fly more points; re-cut, the set is acceptable', () => {
    const hunting = perfFixture({
      hook: (cols, t, recs) => {
        for (const rec of recs) {
          for (const token of ['thro1,handl', 'thro2,handl']) inRecord(cols, t, rec, token, (tt, v) => v + 0.012 * ramp(tt, rec.start + 5, 0.5) - 0.006 * ramp(tt, rec.start + 10, 0.5))
          for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) inRecord(cols, t, rec, token, (tt, v) => v * (1 + 0.03 * ramp(tt, rec.start + 5, 0.5) - 0.015 * ramp(tt, rec.start + 10, 0.5)))
        }
      },
    })
    const r = run(hunting)
    expect(r.points.every((p) => p.status === 'excluded')).toBe(true)
    expect(r.verdict.kind).toBe('fix-analysis')
    expect(r.verdict.text).toMatch(/^Fix the analysis — re-cut the 9 flagged points .*\(Re-cut\), then check again: as cut, only 0 are usable$/)
    expect(r.verdict.text).not.toMatch(/fly more points/)
    expect(pointCheck(r, '250 KTAS', 'throttle-fixed').hint).not.toMatch(/Find steady points/)
    const plan = recutPlan(hunting.ds, hunting.points, recutFailing(r.points, 'performance'))
    expect(plan).toHaveLength(9)
    const cut = hunting.points.map((p) => {
      const x = plan.find((q) => q.point.id === p.id)
      return x ? { ...p, start: x.recut.start, end: x.recut.end } : p
    })
    expect(run(hunting, { points: cut }).verdict.kind).toBe('acceptable')
  })

  it('set checks over the used points need two of them: none or one is not checkable, never a pass on no data', () => {
    const p = DEFAULT.points[4]
    const tooShort = { ...p, end: p.start + 30 } // 3 s: record-length fails, so no point is used
    for (const [points, used] of [[[tooShort], 0], [[p], 1]] as const) {
      const r = run(DEFAULT, { points: [...points] })
      expect(r.used).toHaveLength(used)
      for (const id of ['weight-column', 'altitude-band', 'fuel-flow']) {
        expect(setCheck(r, id).status).toBe('not-checkable')
        expect(setCheck(r, id).criterion).toMatch(/Needs two or more used points/)
      }
    }
    // A plotted formula with the maximum weight still fails at any count.
    const withGross = makeLog(DEFAULT.ds.elapsed, Object.fromEntries(DEFAULT.ds.channels.filter((c) => !c.derived && c.token !== '_totl,_time').map((c) => [c.token, c.values])), {
      formulas: { 'fx:w_over': ['gross_lb * 1', DEFAULT.ds.channels.find((c) => c.token === 'gross,___lb')!.values] },
    })
    const one = runPerfChecks({ ds: withGross, points: [pointAt(withGross, 'P', DEFAULT.recs[4].start, DEFAULT.recs[4].end)], x: withGross.channels.find((c) => c.id === 'Vtrue,_ktas') ?? null, y: withGross.channels.find((c) => c.id === 'fx:w_over') ?? null, fit: 'drag-model' })
    expect(one.set.find((c) => c.id === 'weight-column')?.status).toBe('fail')
  })
})

/** The dataset without the rows `drop` picks. */
function dropRows(ds: Dataset, drop: (time: number, i: number) => boolean): Dataset {
  const keep: number[] = []
  for (let i = 0; i < ds.rowCount; i += 1) if (!drop(ds.elapsed[i], i)) keep.push(i)
  const cols: Columns = {}
  for (const ch of ds.channels) if (!ch.derived && ch.token !== '_totl,_time') cols[ch.token] = Float64Array.from(keep, (i) => ch.values[i])
  const formulas: Record<string, [string, Float64Array]> = {}
  for (const ch of ds.channels) if (ch.derived) formulas[ch.id] = [ch.derived.expression, Float64Array.from(keep, (i) => ch.values[i])]
  return makeLog(Float64Array.from(keep, (i) => ds.elapsed[i]), cols, { formulas })
}
