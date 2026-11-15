import { describe, expect, it } from 'vitest'
import type { Dataset, TestPoint, XYConfig } from '../types'
import { makeLog, pointAt, ramp, type Columns } from './fixtures'
import { fitThrough, PERF_OPEN, PERFORMANCE_DEFS, runPerfChecks, type PerfCheckSettings } from './performance'
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

// ISA: the troposphere, and the isothermal layer (216.65 K) above 36,089 ft.
function isa(hp: number) {
  const tropo = hp <= 36089
  const theta = tropo ? 1 - 6.8755856e-6 * hp : 216.65 / 288.15
  const delta = tropo ? theta ** 5.2558797 : 0.22336 * Math.exp(-(hp - 36089) / 20806)
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

  it('9: configuration: flaps at one point fail configuration-match (plot separately, not retest); flaps everywhere warn (not clean); no gear warns; moving flaps fail', () => {
    const one = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[3], '_flap,postn', () => 0.25) }))
    expect(pointCheck(one, '230 KTAS', 'configuration-match').status).toBe('fail')
    expect(status(one, '230 KTAS')).toBe('plot-only')
    expect(one.points.find((p) => p.name === '230 KTAS')?.label).toBe('Plot separately')
    expect(one.verdict.text).toMatch(/1 left out \(another configuration: 230 KTAS\)/)
    const all = run(perfFixture({ hook: (cols) => cols['_flap,postn'].fill(0.25) }))
    expect(pointCheck(all, '230 KTAS', 'configuration-match').status).toBe('warn')
    expect(pointCheck(run(perfFixture({ drop: ['_gear,__0/1'] })), '230 KTAS', 'configuration-constant').status).toBe('warn')
    const moving = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[3], '_flap,postn', (tt) => 0.1 * ramp(tt, recs[3].start + 20, 2)) }))
    expect(pointCheck(moving, '230 KTAS', 'configuration-constant').status).toBe('fail')
  })

  it('10: weight: a formula with gross_lb fails (fix the analysis); a 2 % burn warns with U4; 100,000 → 80,000 lb warns (split by weight); a constant weight warns', () => {
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
    // Beyond NATO's 10 % linearised range the reduction is still advice (the brief sets no weight requirement).
    const heavy = run(perfFixture({ weight: (k) => 100000 - (20000 * k) / 8 }))
    expect(setCheck(heavy, 'weight-spread').status).toBe('warn')
    expect(setCheck(heavy, 'weight-spread').hint).toMatch(/split the set by weight/)
    expect(heavy.verdict.kind).toBe('acceptable')
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

  it('15: near the stall: a 5 % lift deficit and 8 % polar excess at 170 KTAS warn, and the point stays in the fit; 2.5 % is info', () => {
    const stall = (deficit: number, excess: number) =>
      perfFixture({
        hook: (cols, t, recs) => {
          inRecord(cols, t, recs[0], '___cl,total', (_, v) => v * (1 - deficit))
          for (const token of ['thrst,_1,lb', 'thrst,_2,lb', '_drag,___lb', '___cd,total']) inRecord(cols, t, recs[0], token, (_, v) => v * (1 + excess))
        },
      })
    const r = run(stall(0.05, 0.08))
    expect(pointCheck(r, '170 KTAS', 'near-stall').status).toBe('warn')
    expect(pointCheck(r, '170 KTAS', 'near-stall').hint).toMatch(/stays in the fit/)
    expect(status(r, '170 KTAS')).toBe('used')
    expect(r.used).toContain(r.points.find((p) => p.name === '170 KTAS')?.pointId)
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

  it('17: weather: a steady 20 kt wind is info (ground-speed axis fails); a 10 kt ramp or 100 fpm vertical wind fails; no row 152 or drag warns', () => {
    const windy = perfFixture({ hook: (cols) => cols['Vtrue,_ktgs'].forEach((v, i, a) => (a[i] = v + 20)) })
    const r = run(windy)
    expect(pointCheck(r, '250 KTAS', 'weather').status).toBe('info')
    expect(pointCheck(r, '250 KTAS', 'weather').hint).toMatch(/TAS-based results are unaffected/)
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
    expect(pointCheck(unchecked, '250 KTAS', 'weather').hint).toMatch(/see the thrust–drag check for the missing rows/)
  })

  it('18: ISA + 10 K warns isa-day; without row 151 the TAS/Mach estimate agrees to 0.1 K', () => {
    const hot = perfFixture({ dIsa: 10 })
    const r = run(hot)
    expect(pointCheck(r, '250 KTAS', 'isa-day').status).toBe('warn')
    const est = run(perfFixture({ dIsa: 10, drop: ['AMtmp,_degC', '_dens,ratio'] }))
    expect(Math.abs(est.metrics[4].dIsa - 10)).toBeLessThan(0.1)
  })

  it('19: construction: a jet power curve fails; thrust with the drag model passes with U3; η_p 0.6 with thrust fails; fuel flow warns; unknown warns and points to the setting', () => {
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
    // An unknown engine type is a settings choice: a warning that points to it, not a "Cannot confirm" verdict.
    const unknown = run(perfFixture({ drop: ['__L/D,*etaP'] }))
    expect(setCheck(unknown, 'construction').status).toBe('warn')
    expect(setCheck(unknown, 'construction').hint).toMatch(/checklist settings/)
    expect(unknown.verdict.kind).toBe('acceptable')
  })

  it('20: fuel: rising TSFC warns; SFC stands in for fuel flow; neither warns (fuel flow must be recorded); bookkeeping passes, a 10 % larger drop warns', () => {
    expect(setCheck(run(perfFixture({ tsfc: (k) => 0.1 * (1 + 0.0125 * k) })), 'fuel-flow').status).toBe('warn')
    const sfc = perfFixture({ drop: ['FF__1,_lb/h', 'FF__2,_lb/h'], hook: (cols, t) => { cols['SFC_1,lblbh'] = Float64Array.from(t, () => 0.1); cols['SFC_2,lblbh'] = Float64Array.from(t, () => 0.1) } })
    const rs = run(sfc)
    expect(rs.metrics[4].ff).toBeCloseTo(0.1 * rs.metrics[4].thrust, 6)
    const none = run(perfFixture({ drop: ['FF__1,_lb/h', 'FF__2,_lb/h'] }))
    expect(setCheck(none, 'fuel-flow').status).toBe('warn')
    expect(setCheck(none, 'fuel-flow').hint).toMatch(/Log row 45/)
    expect(none.verdict.kind).toBe('acceptable')
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

  it('22–23: α 12° level flight passes wings-level; 8° bank warns, 15° fails; β 3° warns; 150 ft AGL warns envelope, 300 ft passes', () => {
    const alpha12 = perfFixture({ hook: (cols, t, recs) => { inRecord(cols, t, recs[4], 'pitch,__deg', () => 12); inRecord(cols, t, recs[4], 'Gload,norml', () => Math.cos((12 * Math.PI) / 180)) } })
    expect(pointCheck(run(alpha12), '250 KTAS', 'wings-level').status).toBe('pass')
    const bank = (deg: number) => perfFixture({ hook: (cols, t, recs) => { inRecord(cols, t, recs[4], '_roll,__deg', () => deg); inRecord(cols, t, recs[4], 'Gload,norml', (_, v) => v * Math.cos((deg * Math.PI) / 180)) } })
    expect(pointCheck(run(bank(8)), '250 KTAS', 'wings-level').status).toBe('warn')
    expect(pointCheck(run(bank(15)), '250 KTAS', 'wings-level').status).toBe('fail')
    expect(status(run(bank(15)), '250 KTAS')).toBe('excluded')
    expect(pointCheck(run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_beta,__deg', () => 3) })), '250 KTAS', 'wings-level').status).toBe('warn')
    // Ground effect ends about one wingspan up (NATO 13-4); the app's stand-in is 200 ft, not 500 ft.
    const low = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_gear,ftagl', () => 150) }))
    expect(pointCheck(low, '250 KTAS', 'envelope').status).toBe('warn')
    expect(low.verdict.kind).toBe('acceptable')
    expect(pointCheck(run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_gear,ftagl', () => 300) })), '250 KTAS', 'envelope').status).toBe('pass')
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

// The source audit's fixes: each bug with the synthetic case that showed it, and each relaxation (a fail or a warning
// stricter than the sources) with a case it now lets through.
describe('performance checklist: source-audit fixes', () => {
  const FF = ['FF__1,_lb/h', 'FF__2,_lb/h']
  const THRUST_COLS = ['thrst,_1,lb', 'thrst,_2,lb']
  const id250 = (r: Report) => r.points.find((p) => p.name === '250 KTAS')?.pointId ?? ''

  it('record length counts the rows of R: without KTAS a 60 s point is not "too short"', () => {
    const r = run(perfFixture({ drop: ['Vtrue,_ktas'] }))
    expect(pointCheck(r, '250 KTAS', 'record-length').status).toBe('pass')
    expect(pointCheck(r, '250 KTAS', 'record-length').measured).toMatch(/601 rows/)
    expect(r.points.some((p) => p.reasons.includes('record too short'))).toBe(false)
  })

  it('level with VVI only: a ±150 ft porpoise fails on the altitude VVI integrates to; a steady VVI passes', () => {
    const vviOnly = (amplitudeFt: number) =>
      perfFixture({
        drop: ['___CG,ftMSL', 'p-alt,ftMSL'],
        hook: (cols, t, recs) => inRecord(cols, t, recs[4], '__VVI,__fpm', (tt) => amplitudeFt * 0.1 * 60 * Math.cos(0.1 * (tt - recs[4].start))),
      })
    const r = run(vviOnly(150))
    expect(pointCheck(r, '250 KTAS', 'level').status).toBe('fail')
    expect(pointCheck(r, '250 KTAS', 'level').measured).toMatch(/VVI integrated over R/)
    expect(status(r, '250 KTAS')).toBe('excluded')
    expect(pointCheck(run(vviOnly(0)), '250 KTAS', 'level').status).toBe('pass')
  })

  it('energy correction without thrust: a share of X-Plane’s drag, else of the thrust power η_p·P (row 69, else 68), else of the shaft power, labelled', () => {
    const ETA = 0.8
    const prop = (eta: 'row 69' | 'row 68' | 'none', keepDrag = false) =>
      perfFixture({
        etaP: 0.6,
        drop: [...THRUST_COLS, ...(keepDrag ? [] : ['_drag,___lb'])],
        hook: (cols, t, recs) => {
          inRecord(cols, t, recs[1], '___CG,ftMSL', (tt, v) => v + 0.5 * (tt - recs[1].start))
          for (const k of [1, 2]) cols[`engn${k},___hp`] = Float64Array.from(t, (_, i) => (cols[`thrst,_${k},lb`][i] * cols['Vtrue,_ktas'][i] * KT) / 550 / ETA)
          if (eta === 'row 69') for (const k of [1, 2]) cols[`Peff${k},cruis`] = Float64Array.from(t, () => ETA)
          if (eta === 'row 68') {
            cols['__L/D,_aero'] = Float64Array.from(t, (_, i) => cols['___cl,total'][i] / cols['___cd,total'][i])
            cols['__L/D,*etaP'] = Float64Array.from(cols['__L/D,_aero'], (ld) => ETA * ld)
          }
        },
      })
    // The thrust the fixture balances against (the same at 190 KTAS whatever is dropped), so η_p·P = T·V.
    const thrust = run(DEFAULT).metrics[1].thrust
    for (const eta of ['row 69', 'row 68'] as const) {
      const m = run(prop(eta)).metrics[1]
      expect(m.shareOf).toBe('thrust power')
      expect(Math.abs(m.share - Math.abs(m.total) / thrust) / m.share).toBeLessThan(1e-6)
    }
    const shaft = run(prop('none'))
    const m = shaft.metrics[1]
    expect(m.shareOf).toBe('shaft power')
    expect(Math.abs(m.share - (ETA * Math.abs(m.total)) / thrust) / m.share).toBeLessThan(1e-6)
    expect(pointCheck(shaft, '190 KTAS', 'energy-correction').measured).toMatch(/of the shaft power \(η_p unknown\)/)
    expect(pointCheck(shaft, '190 KTAS', 'energy-correction').hint).toMatch(/larger by 1\/η_p/)
    expect(run(prop('none', true)).metrics[1].shareOf).toBe('X-Plane drag')
  })

  it('thrust–drag “not checkable” names every missing row', () => {
    const c = pointCheck(run(perfFixture({ drop: ['_drag,___lb', 'total,___lb'] })), '250 KTAS', 'thrust-drag')
    expect(c.status).toBe('not-checkable')
    expect(c.criterion).toMatch(/row 64\*? \(/)
    expect(c.criterion).toMatch(/row 63 \(Weight and balance\)/)
  })

  it('configuration match: two configurations tied leave neither out, warn “split the set” and make the verdict ask for the split; gear held down throughout is taken as fixed (a note)', () => {
    const tie = perfFixture({ hook: (cols, t, recs) => [4, 5, 6, 7].forEach((k) => inRecord(cols, t, recs[k], '_flap,postn', () => 0.25)) })
    const r = run(tie, { points: tie.points.slice(0, 8) })
    for (const p of r.points) {
      const c = p.checks.find((k) => k.id === 'configuration-match')
      expect(c?.status).toBe('warn')
      expect(c?.hint).toMatch(/split the set/)
      expect(['used', 'correct']).toContain(p.status)
    }
    // A fit through two configurations is not one curve (NATO 13-9): not "Acceptable for analysis".
    expect(r.verdict.kind).toBe('fix-analysis')
    expect(r.verdict.text).toMatch(/^Fix the analysis — 2 configurations tie for the most points: split the set, one group per configuration/)
    const fixedGear = run(perfFixture({ hook: (cols) => cols['_gear,__0/1'].fill(1) }))
    const gear = pointCheck(fixedGear, '250 KTAS', 'configuration-match')
    expect(gear.status).toBe('info')
    expect(gear.measured).toMatch(/fixed gear/)
    expect(gear.hint).toMatch(/if the gear retracts, these points are not clean/)
    expect(fixedGear.verdict.kind).toBe('acceptable')
  })

  it('configuration match: in a tie, a point in a third, less common configuration is still left out', () => {
    const r = run(perfFixture({ hook: (cols, t, recs) => { [4, 5, 6, 7].forEach((k) => inRecord(cols, t, recs[k], '_flap,postn', () => 0.25)); inRecord(cols, t, recs[8], '_flap,postn', () => 0.5) } }))
    expect(pointCheck(r, '330 KTAS', 'configuration-match').status).toBe('fail')
    expect(pointCheck(r, '330 KTAS', 'configuration-match').measured).toMatch(/in neither tied configuration/)
    expect(status(r, '330 KTAS')).toBe('plot-only')
    for (const name of ['170 KTAS', '250 KTAS']) {
      expect(pointCheck(r, name, 'configuration-match').status).toBe('warn')
      expect(pointCheck(r, name, 'configuration-match').hint).toMatch(/^2 configurations tie for the most points: split the set, one group per configuration/)
    }
    expect(r.used).toHaveLength(8)
    expect(r.verdict.kind).toBe('fix-analysis')
    // Flaps 0.004 and 0.006 round to different keys but are the same within 0.01: one configuration, no tie.
    const rounding = perfFixture({ hook: (cols, t, recs) => recs.forEach((rec, k) => inRecord(cols, t, rec, '_flap,postn', () => (k < 4 ? 0.004 : 0.006))) })
    const one = run(rounding, { points: rounding.points.slice(0, 8) })
    for (const p of one.points) expect(p.checks.find((k) => k.id === 'configuration-match')?.status).toBe('pass')
    expect(one.verdict.kind).toBe('acceptable')
  })

  it('trim fixed: a slow drift is info and not flagged for a re-cut; a step warns and is flagged with the 0.02 trim band', () => {
    const trim = (f: (tt: number, start: number) => number) => perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_trim,_elev', (tt) => f(tt, recs[4].start)) })
    const drift = run(trim((tt, s) => 0.2 + (0.05 * (tt - s)) / 60))
    expect(pointCheck(drift, '250 KTAS', 'trim-fixed').status).toBe('info')
    expect(recutFailing(drift.points, 'performance').get(id250(drift))?.trim).toBe(false)
    const stepFx = trim((tt, s) => (tt >= s + 30 ? 0.25 : 0.2))
    const step = run(stepFx)
    expect(pointCheck(step, '250 KTAS', 'trim-fixed').status).toBe('warn')
    const failing = recutFailing(step.points, 'performance')
    expect(failing.get(id250(step))).toEqual({ throttle: false, trim: true, trimBand: 0.02 })
    const plan = recutPlan(stepFx.ds, stepFx.points, failing)
    expect(plan.map((x) => x.point.name)).toEqual(['250 KTAS'])
    expect(plan[0].recut.seconds).toBeGreaterThan(25)
  })

  it('weather without row 152 uses each point’s own thrust–drag, so only the mismatched point warns; a wind range over 2 kt warns', () => {
    const r = run(perfFixture({ drop: ['_wind,v_fpm'], hook: (cols, t, recs) => THRUST_COLS.forEach((token) => inRecord(cols, t, recs[4], token, (_, v) => v * 1.05)) }))
    expect(pointCheck(r, '250 KTAS', 'weather').status).toBe('warn')
    expect(pointCheck(r, '250 KTAS', 'weather').hint).toMatch(/vertical air motion unchecked/)
    expect(pointCheck(r, '230 KTAS', 'weather').status).toBe('pass')
    const gusty = run(perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], '_wind,knots', (tt) => 3 * ramp(tt, recs[4].start + 10, 20)) }))
    expect(pointCheck(gusty, '250 KTAS', 'weather').status).toBe('warn')
    expect(pointCheck(gusty, '250 KTAS', 'weather').criterion).toMatch(/wind range ≤ 2 kt/)
  })

  it('ISA above 36,089 ft is isothermal: an ISA day at 39,000 ft passes, from the temperature and from TAS and Mach', () => {
    const speeds = [400, 420, 440, 460, 480]
    const strat = run(perfFixture({ altitude: () => 39000, speeds }))
    expect(pointCheck(strat, '440 KTAS', 'isa-day').status).toBe('pass')
    expect(Math.abs(strat.metrics[2].dIsa)).toBeLessThan(0.1)
    const est = run(perfFixture({ altitude: () => 39000, speeds, drop: ['AMtmp,_degC', '_dens,ratio'] }))
    expect(Math.abs(est.metrics[2].dIsa)).toBeLessThan(0.1)
    // σ from the model when the density ratio is not logged: 216.65 K and δ = 0.22336·exp(−(h − 36,089)/20,806).
    expect(est.metrics[2].sigma).toBeCloseTo(isa(39000).sigma, 9)
    expect(isa(39000).tK).toBeCloseTo(216.65, 9)
  })

  it('near the stall: below 1.3 V_S is info and the points stay in the fit; the back side is judged in the plotted units', () => {
    const r = run(DEFAULT, { settings: { limits: { vsKeas: 150 } } })
    const c = pointCheck(r, '170 KTAS', 'near-stall')
    expect(c.status).toBe('info')
    expect(c.hint).toMatch(/1\.3 V_S, NATO’s usual landing approach speed/)
    expect(status(r, '170 KTAS')).toBe('used')
    expect(r.used).toHaveLength(9)
    // On a KEAS axis V_E is in KEAS: 210 KTAS (186 KEAS) lies below it, on the back side.
    const keas = run(DEFAULT, { x: '_Vind,_keas' })
    expect(pointCheck(keas, '210 KTAS', 'near-stall').measured).toMatch(/^back side/)
    expect(pointCheck(keas, '230 KTAS', 'near-stall').measured).toMatch(/^front side/)
  })

  it('near the stall: the 3 % line widens with the reference polar’s own scatter', () => {
    const tokens = [...THRUST_COLS, '_drag,___lb', '___cd,total']
    const fx = (excess: number, noisy: boolean) =>
      perfFixture({
        hook: (cols, t, recs) => {
          // ±3 % scatter on the reference (middle) points, and the excess at the slowest.
          if (noisy) [2, 3, 4, 5, 6].forEach((k, j) => tokens.forEach((token) => inRecord(cols, t, recs[k], token, (_, v) => v * (j % 2 ? 0.97 : 1.03))))
          tokens.forEach((token) => inRecord(cols, t, recs[0], token, (_, v) => v * (1 + excess)))
        },
      })
    expect(pointCheck(run(fx(0.04, false)), '170 KTAS', 'near-stall').status).toBe('warn')
    const noisy = pointCheck(run(fx(0.04, true)), '170 KTAS', 'near-stall')
    expect(noisy.status).toBe('info')
    // ± 3 % scatter would widen the line to about 15 %: it stops at 10 %, so the note still sees a large departure.
    expect(noisy.measured).toMatch(/warn line 10\.0 % \(reference scatter\)/)
    expect(pointCheck(run(fx(0.15, true)), '170 KTAS', 'near-stall').status).toBe('warn')
    expect(pointCheck(run(fx(0.12, true)), '170 KTAS', 'near-stall').status).toBe('warn')
  })

  it('near the stall: the judged point is left out of its own reference, so a 20 % departure still warns in 4- and 6-point sets', () => {
    const tokens = [...THRUST_COLS, '_drag,___lb', '___cd,total']
    for (const speeds of [[170, 190, 210, 230, 250, 270], [190, 210, 230, 250]]) {
      const r = run(perfFixture({ speeds, hook: (cols, t, recs) => tokens.forEach((token) => inRecord(cols, t, recs[0], token, (_, v) => v * 1.2)) }))
      const c = pointCheck(r, `${speeds[0]} KTAS`, 'near-stall')
      expect(c.status).toBe('warn')
      expect(Number(c.measured.match(/drag ([−+\d.]+) % from the polar/)?.[1].replace('−', '-'))).toBeGreaterThan(15)
      expect(c.criterion).toMatch(/the info line sits 1 point below it/)
    }
  })

  it('compressibility: the M 0.6 line applies to the fastest third only', () => {
    const r = run(perfFixture({ altitude: () => 30000, speeds: [360, 380, 400, 420, 440, 460] }))
    expect(r.metrics[0].mach).toBeGreaterThan(0.6)
    expect(pointCheck(r, '360 KTAS', 'compressibility').status).toBe('pass')
    expect(pointCheck(r, '420 KTAS', 'compressibility').status).toBe('pass')
    expect(pointCheck(r, '460 KTAS', 'compressibility').status).toBe('warn')
  })

  it('weight column: a frozen weight warns without fuel-flow rows; curnt,___lb is the current weight; a gross formula fails without total,___lb', () => {
    const frozen = run(perfFixture({ drop: FF, hook: (cols) => cols['total,___lb'].fill(100000) }))
    expect(setCheck(frozen, 'weight-column').status).toBe('warn')
    expect(setCheck(frozen, 'weight-column').measured).toMatch(/does not fall/)
    expect(setCheck(frozen, 'weight-column').criterion).toMatch(/warn: /)
    const legacy = run(perfFixture({ drop: ['total,___lb'], hook: (cols) => { cols['curnt,___lb'] = Float64Array.from(cols['total,___lb']) } }))
    expect(setCheck(legacy, 'weight-column').status).toBe('pass')
    expect(setCheck(legacy, 'weight-column').measured).toMatch(/^curnt,___lb falls/)
    expect(pointCheck(legacy, '250 KTAS', 'energy-correction').status).toBe('pass')
    expect(legacy.verdict.kind).toBe('acceptable')
    const noTotal = perfFixture({ drop: ['total,___lb'] })
    const total = noTotal.ds.channels.find((c) => c.id === 'fx:total_thrust')!
    const grossDs: Dataset = { ...noTotal.ds, channels: [...noTotal.ds.channels, { ...total, id: 'fx:thrust_w', derived: { expression: 'total_thrust * gross_lb / 150000' } }] }
    expect(setCheck(run(noTotal, { ds: grossDs, y: 'fx:thrust_w' }), 'weight-column').status).toBe('fail')
  })

  it('weight spread judges the weight only: an ISA + 10 K day passes; a far reference weight warns “check the reference weight”', () => {
    expect(setCheck(run(perfFixture({ dIsa: 10 })), 'weight-spread').status).toBe('pass')
    const far = setCheck(run(DEFAULT, { settings: { referenceWeightLb: 150000 } }), 'weight-spread')
    expect(far.status).toBe('warn')
    expect(far.hint).toMatch(/check the reference weight/)
  })

  it('altitude band: without pressure altitude the density ratio judges it; a jet’s wide band offers the W/δ reduction', () => {
    const r = run(perfFixture({ drop: ['p-alt,ftMSL'] }))
    expect(setCheck(r, 'altitude-band').status).toBe('pass')
    expect(r.verdict.kind).toBe('acceptable')
    expect(setCheck(run(perfFixture({ altitude: (k) => (k % 2 ? 12000 : 8000) })), 'altitude-band').hint).toMatch(/W\/δ/)
  })

  it('construction: a propeller plotting drag fails (the lecture’s construction is drawn on power)', () => {
    const c = setCheck(run(perfFixture({ etaP: 0.6 }), { y: '_drag,___lb' }), 'construction')
    expect(c.status).toBe('fail')
    expect(c.hint).toMatch(/not thrust or drag/)
  })

  it('speed axis: ground speed fails with a changing wind even where the weather check failed', () => {
    const ramping = perfFixture({ hook: (cols, t, recs) => inRecord(cols, t, recs[4], 'Vtrue,_ktgs', (tt, v) => v + 10 * ramp(tt, recs[4].start + 10, 40)) })
    const r = run(ramping, { x: 'Vtrue,_ktgs' })
    expect(pointCheck(r, '250 KTAS', 'weather').status).toBe('fail')
    expect(setCheck(r, 'speed-axis').status).toBe('fail')
    expect(setCheck(run(DEFAULT, { x: 'Vtrue,_ktgs' }), 'speed-axis').status).toBe('warn')
  })

  it('fuel bookkeeping is not checkable when the fuel quantity does not fall', () => {
    const c = setCheck(run(perfFixture({ hook: (cols) => cols['_fuel,___lb'].fill(20000) })), 'fuel-bookkeeping')
    expect(c.status).toBe('not-checkable')
    expect(c.criterion).toMatch(/fuel quantity to fall/)
  })

  it('fit quality warns when leaving one point out loses an optimum', () => {
    const r = run(DEFAULT, { points: DEFAULT.points.filter((p) => [210, 250, 270, 290, 310].includes(parseInt(p.name))), fit: 'poly2' })
    const c = setCheck(r, 'fit-quality')
    expect(c.status).toBe('warn')
    expect(c.measured).toMatch(/leaving one point out loses V_E in 1 of 5 fits/)
  })

  it('autopilot record: a changed selected value is info, a changed mode warns', () => {
    const modes = (change: '__set,speed' | '_mode,__alt') =>
      perfFixture({
        hook: (cols, t, recs) => {
          cols['_mode,__alt'] = Float64Array.from(t, () => 6)
          cols['__set,speed'] = Float64Array.from(t, () => 250)
          inRecord(cols, t, recs[4], change, (tt, v) => (tt >= recs[4].start + 30 ? v + 1 : v))
        },
      })
    const selected = setCheck(run(modes('__set,speed')), 'autopilot-record')
    expect(selected.status).toBe('info')
    expect(selected.measured).toMatch(/a selected value changed inside 250 KTAS/)
    expect(setCheck(run(modes('_mode,__alt')), 'autopilot-record').status).toBe('warn')
  })

  it('autopilot record: selected values alone (row 118) do not show the modes; a declaration or the inference judges them', () => {
    const values = (servo: boolean) =>
      perfFixture({
        hook: (cols, t, recs) => {
          cols['__set,speed'] = Float64Array.from(t, () => 250)
          inRecord(cols, t, recs[4], '__set,speed', (tt, v) => (tt >= recs[4].start + 30 ? v + 5 : v))
          if (servo) {
            cols['_elev,servo'] = Float64Array.from(t, (x) => 0.02 * Math.sin(0.5 * x))
            cols['_elev,_surf'] = Float64Array.from(cols['_elev,servo'], (v) => 0.6 * v)
            cols['_elev,stick'] = new Float64Array(t.length)
          }
        },
      })
    expect(setCheck(run(values(false)), 'autopilot-record').status).toBe('not-checkable')
    const declared = setCheck(run(values(false), { settings: { declared: { autopilot: 'on', modes: 'ALT HOLD, A/T off' } } }), 'autopilot-record')
    expect(declared.status).toBe('info')
    expect(declared.measured).toMatch(/^declared: autopilot on .*; a selected value changed inside 250 KTAS/)
    const inferred = setCheck(run(values(true)), 'autopilot-record')
    expect(inferred.status).toBe('warn')
    expect(inferred.measured).toMatch(/inferred.*autopilot 9.*; a selected value changed inside 250 KTAS/)
  })

  it('brackets: a polynomial’s optimum is searched two point spacings out, so V_E 1.4 spacings below three points warns, not “no minimum”', () => {
    const c = setCheck(run(perfFixture({ speeds: [240, 260, 280], drop: FF }), { fit: 'poly2' }), 'bracket-endurance')
    expect(c.status).toBe('warn')
    expect(c.measured).toMatch(/1\.4\d spacings outside the data/)
    expect(c.criterion).toMatch(/max\(½ span, 2 point spacings\)/)
    // The X–Y table under the plot still searches only ± ½ span: the measured text says why it may show no minimum.
    expect(c.measured).toMatch(/beyond the data ± ½ span the X–Y table searches/)
    expect(setCheck(run(DEFAULT, { fit: 'poly2' }), 'bracket-endurance').measured).not.toMatch(/X–Y table/)
    // A vertex 1.5 spacings below three points: the fitted range ± half its span (180–260) alone would miss it.
    const xs = [200, 220, 240]
    expect(fitThrough(xs, xs.map((x) => (x - 170) ** 2 + 1000), 'poly2')?.vE).toBeCloseTo(170, 6)
  })

  it('bracket range: with V_MO set (the app’s stand-in for NATO’s maximum speed at normal rated power), a fastest point more than 10 % below it drops a pass to warn', () => {
    const slow = setCheck(run(DEFAULT, { settings: { limits: { vmoKias: 400 } } }), 'bracket-range')
    expect(slow.status).toBe('warn')
    expect(slow.hint).toMatch(/the app’s stand-in for NATO’s maximum speed at normal rated power: if the aircraft can fly faster at normal rated power, add faster points/)
    expect(setCheck(run(DEFAULT, { settings: { limits: { vmoKias: 320 } } }), 'bracket-range').status).toBe('pass')
    for (const id of ['bracket-range', 'bracket-endurance']) expect(PERFORMANCE_DEFS.find((x) => x.id === id)?.why).toMatch(/near maximum speed for normal rated power/)
  })

  it('stabilised reads the legacy engine power (power,_k,hp) when no lever or thrust is logged', () => {
    const legacy = perfFixture({
      drop: ['thro1,handl', 'thro2,handl', ...THRUST_COLS],
      hook: (cols, t) => {
        for (const k of [1, 2]) cols[`power,_${k},hp`] = Float64Array.from(t, (_, i) => (cols[`thrst,_${k},lb`][i] * cols['Vtrue,_ktas'][i] * KT) / 550)
      },
    })
    expect(pointCheck(run(legacy), '250 KTAS', 'stabilised').status).toBe('pass')
  })

  it('flags and sources: judgement wherever the app chose a number; each source number named with its source and test', () => {
    const def = (id: string) => PERFORMANCE_DEFS.find((x) => x.id === id)
    for (const id of ['time-base', 'speed-axis', 'repeats', 'construction']) expect(def(id)?.judgement).toBe(true)
    expect(def('record-length')?.sourced).toBe('pass ≥ 60 s: NATO 13-10 (the last minute of a cruise test)')
    const keys = [['sample-rate', 'NATO 13-6'], ['stabilised', '13-7 (engine, before level accelerations)'], ['speed-steady', 'NATO 13-10'], ['energy-correction', 'NATO 13-8'], ['weight-spread', 'NATO 13-8'], ['point-count', 'NATO 13-8'], ['near-stall', 'NATO 13-5'], ['compressibility', 'Cook p.360'], ['envelope', 'NATO 13-4'], ['wings-level', 'NATO 13-7']] as const
    for (const [id, key] of keys) expect(def(id)?.sourced).toContain(key)
    // A number stated for another test says so.
    for (const id of ['sample-rate', 'stabilised', 'speed-steady', 'energy-correction', 'weight-spread', 'point-count', 'near-stall', 'compressibility', 'wings-level', 'envelope']) expect(def(id)?.sourced).toMatch(/borrowed/)
    // NATO's 10 % only switches the weight-spread hint (the warn line is 1 %); the point-count pass line is max(5, p + 2).
    expect(def('weight-spread')?.sourced).toMatch(/^hint above 10 %/)
    expect(def('point-count')?.sourced).toMatch(/^about 5 points:/)
    expect(def('wings-level')?.sourced).toMatch(/small discrepancies corrected in analysis/)
    // The wording stays with the pages: NATO's configurations are external ones (tanks, stores); it corrects small n_z
    // discrepancies; duplicating an early test is "highly desirable".
    expect(def('configuration-match')?.why).toMatch(/various combinations of weight and external configuration/)
    expect(def('configuration-constant')?.why).toMatch(/each external configuration \(tanks or stores\)/)
    expect(def('wings-level')?.why).toMatch(/corrects small discrepancies in the analysis/)
    expect(def('repeats')?.why).toMatch(/highly desirable to duplicate an early test/)
    for (const id of ['altitude-band', 'level', 'fuel-flow']) expect(def(id)?.sourced).toBeUndefined()
    // settling() reads the lever, else thrust, engine power or N1.
    expect(def('stabilised')?.needs).toBe('row {25} or {26}, else {35}, {34} or {41}')
    // result() carries them into each check.
    expect(pointCheck(run(DEFAULT), '250 KTAS', 'record-length').sourced).toBe(def('record-length')?.sourced)
    expect(def('autothrottle-off')?.interval).toBe('R')
    const code = run(perfFixture({ hook: (cols, t) => { cols['_auto,throt'] = Float64Array.from(t, () => 0) } }))
    expect(pointCheck(code, '250 KTAS', 'autothrottle-off').criterion).toBe('pass: _auto,throt 0 throughout R; warn: not 0 (never fails)')
    expect(def('fuel-flow')?.title).toBe('Fuel flow logged, TSFC steady (jets)')
    expect(PERF_OPEN.U1.citations).not.toContain('NATO AG-300 v14 p.21-6')
    expect(PERF_OPEN.U3.citations).not.toContain('Cook p.510')
    expect(PERF_OPEN.U5.citations).toContain('FD12b p.23')
    expect(PERF_OPEN.U6.citations).not.toContain('NATO AG-300 v14 p.9-4')
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
