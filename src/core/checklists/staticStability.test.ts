import { describe, expect, it } from 'vitest'
import type { Dataset, PointGroup, TestPoint } from '../types'
import { setReportRows, checklistCsv } from './export'
import { makeLog, pointAt, ramp, times, type Columns } from './fixtures'
import { pitchControlSource } from './helpers'
import { recutFailing, recutPlan } from './recut'
import { runStaticChecks, type StaticInput, type TrimCheckSettings } from './staticStability'

// A synthetic twin-jet trim sweep (invented values): 8 points at 10 Hz, 60 s each, 150–280 KEAS at one altitude,
// 8,000 ft AGL, S-ref 500 ft², 60,000 lb falling 0.1 % per point, CG constant, a trimmable stabiliser with G = 8 deg per
// trim unit and a true gradient of −6 deg/C_L in δ_eq, wings level, autopilot rows logged with constant modes, each point
// set 90 s after its last lever change.
const RATE = 10
const BLOCK = 200
const RHO0 = 0.0023769
const KT = 1.68781
const SIGMA = 0.786
const S_REF = 500
const G = 8

interface Block {
  k: number
  start: number
  change: number
  recStart: number
  recEnd: number
  end: number
}

interface TrimSpec {
  n?: number
  keas?: (k: number) => number
  weight?: (k: number) => number
  lever?: (k: number) => number
  trim?: (k: number, cl: number) => number
  deq?: (k: number, cl: number) => number
  elevNoise?: (k: number) => number
  clScale?: (k: number) => number
  vvi?: (k: number) => number
  bank?: (k: number) => number
  beta?: (k: number) => number
  mach?: (k: number) => number
  agl?: (k: number) => number
  cg?: (k: number) => number
  flaps?: (k: number) => number
  alpha?: (k: number, cl: number) => number
  elevator?: 'deg' | 'surf'
  deltaEq?: boolean
  modesLogged?: boolean
  drop?: string[]
  change?: (k: number) => number
  hook?: (cols: Record<string, Float64Array>, t: Float64Array, blocks: Block[]) => void
  group?: (k: number) => string
}

function cl(spec: TrimSpec, k: number): number {
  const keas = spec.keas?.(k) ?? 150 + (k * 130) / ((spec.n ?? 8) - 1)
  const w = spec.weight?.(k) ?? 60000 * (1 - 0.001 * k)
  return w / (0.5 * RHO0 * (KT * keas) ** 2 * S_REF)
}

function trimSweep(spec: TrimSpec = {}): { ds: Dataset; points: TestPoint[]; blocks: Block[] } {
  const n = spec.n ?? 8
  const t = times(n * BLOCK - 0.1, RATE)
  const blocks: Block[] = Array.from({ length: n }, (_, k) => ({
    k,
    start: k * BLOCK,
    change: k * BLOCK + (spec.change?.(k) ?? 20),
    recStart: k * BLOCK + 110,
    recEnd: k * BLOCK + 170,
    end: (k + 1) * BLOCK,
  }))
  const cols: Record<string, Float64Array> = {}
  const col = (token: string) => (cols[token] ??= new Float64Array(t.length))
  for (let i = 0; i < t.length; i += 1) {
    const k = Math.min(n - 1, Math.floor(t[i] / BLOCK))
    const b = blocks[k]
    const keas = spec.keas?.(k) ?? 150 + (k * 130) / (n - 1)
    const w = spec.weight?.(k) ?? 60000 * (1 - 0.001 * k)
    const c = cl(spec, k)
    const alpha = spec.alpha?.(k, c) ?? c / 0.12 - 2
    const vvi = spec.vvi?.(k) ?? 0
    const ktas = keas / Math.sqrt(SIGMA)
    const gamma = (Math.asin(vvi / 60 / (ktas * KT)) * 180) / Math.PI
    const theta = alpha + gamma
    const bank = spec.bank?.(k) ?? 0
    const trim = spec.trim?.(k, c) ?? 0.4 * c - 0.1 + 0.03 * Math.sin(1.7 * k)
    const deq = spec.deq?.(k, c) ?? 2 - 6 * c
    const elev = deq + G * trim + (spec.elevNoise?.(k) ?? 0)
    const leverNow = spec.lever?.(k) ?? 0.35 + 0.02 * k
    const leverBefore = k === 0 ? 0.3 : (spec.lever?.(k - 1) ?? 0.35 + 0.02 * (k - 1))
    const lever = t[i] < b.change ? leverBefore : leverNow
    col('_Vind,_kias')[i] = keas
    col('_Vind,_keas')[i] = keas
    col('Vtrue,_ktas')[i] = ktas
    col('__VVI,__fpm')[i] = vvi
    col('p-alt,ftMSL')[i] = 8000 + (vvi / 60) * (t[i] - b.start)
    col('vpath,__deg')[i] = gamma
    col('____Q,deg/s')[i] = 0
    col('Gload,norml')[i] = Math.cos((theta * Math.PI) / 180) * Math.cos((bank * Math.PI) / 180)
    col('pitch,__deg')[i] = theta
    col('alpha,__deg')[i] = alpha
    col('_roll,__deg')[i] = bank
    col('_beta,__deg')[i] = spec.beta?.(k) ?? 0
    col('_Mach,ratio')[i] = spec.mach?.(k) ?? ktas / 652
    col('_gear,ftagl')[i] = spec.agl?.(k) ?? 8000
    col('total,___lb')[i] = w
    col('___cg,ftref')[i] = spec.cg?.(k) ?? 1
    col('S-ref,ft*ft')[i] = S_REF
    col('___cl,total')[i] = c * (spec.clScale?.(k) ?? 1)
    if ((spec.elevator ?? 'deg') === 'deg') col('elev1,__deg')[i] = elev
    else col('_elev,_surf')[i] = -elev / 20
    col('_trim,_elev')[i] = trim
    col('_elev,stick')[i] = 0
    col('_elev,astab')[i] = 0
    col('thro1,handl')[i] = lever
    col('thro2,handl')[i] = lever
    col('N1__1,_pcnt')[i] = 60 + 40 * lever
    col('N1__2,_pcnt')[i] = 60 + 40 * lever
    col('thrst,_1,lb')[i] = 2000 + 8000 * lever
    col('thrst,_2,lb')[i] = 2000 + 8000 * lever
    col('_flap,postn')[i] = spec.flaps?.(k) ?? 0
    col('_slat,ratio')[i] = 0
    col('sbrak,postn')[i] = 0
    col('_gear,__0/1')[i] = 0
    if (spec.modesLogged !== false) {
      col('_mode,__alt')[i] = 1
      col('_mode,hding')[i] = 1
    }
    col('_turb,_locl')[i] = 0
    col('_wind,knots')[i] = 0
    col('_wind,v_fpm')[i] = 0
  }
  spec.hook?.(cols, t, blocks)
  const kept: Columns = {}
  for (const [token, values] of Object.entries(cols)) if (!spec.drop?.includes(token)) kept[token] = values
  const formulas: Record<string, [string, Float64Array]> = {}
  if (spec.deltaEq) {
    const surf = (spec.elevator ?? 'deg') === 'surf'
    const e = surf ? cols['_elev,_surf'] : cols['elev1,__deg']
    const tr = cols['_trim,_elev']
    formulas['fx:delta_eq'] = surf
      ? ['elev_surf + 0.4 * trim_elev', Float64Array.from(e, (v, i) => v + 0.4 * tr[i])]
      : ['elev1_deg - 8 * trim_elev', Float64Array.from(e, (v, i) => v - G * tr[i])]
  }
  const ds = makeLog(t, kept, { formulas })
  const points = blocks.map((b) => pointAt(ds, `P${b.k}`, b.recStart, b.recEnd, { groupId: spec.group?.(b.k) ?? 'g1' }))
  return { ds, points, blocks }
}

const GROUPS: PointGroup[] = [
  { id: 'g1', name: 'CG fwd', slot: 0 },
  { id: 'g2', name: 'CG mid', slot: 1 },
  { id: 'g3', name: 'CG aft', slot: 2 },
]

function run(fx: { ds: Dataset; points: TestPoint[] }, extra: Partial<StaticInput> & { settings?: TrimCheckSettings } = {}) {
  const yId = extra.yId ?? (fx.ds.channels.some((c) => c.id === 'fx:delta_eq') ? 'fx:delta_eq' : 'elev1,__deg')
  return runStaticChecks({ ds: fx.ds, points: fx.points, groups: GROUPS, xId: '___cl,total', yId, ...extra })
}

type Report = ReturnType<typeof run>
const setCheck = (r: Report, id: string) => {
  const c = r.set.find((k) => k.id === id)
  if (!c) throw new Error(`no set check ${id}`)
  return c
}
const pointCheck = (r: Report, point: string, id: string) => {
  const p = r.points.find((q) => q.name === point)
  const c = p?.checks.find((k) => k.id === id)
  if (!c) throw new Error(`no check ${id} at ${point}`)
  return c
}
const pointOf = (r: Report, name: string) => {
  const p = r.points.find((q) => q.name === name)
  if (!p) throw new Error(name)
  return p
}

/** Overwrites a column inside one point's record. */
function inRecord(cols: Record<string, Float64Array>, t: Float64Array, b: Block, token: string, f: (time: number, v: number) => number) {
  const v = cols[token]
  for (let i = 0; i < t.length; i += 1) if (t[i] >= b.recStart - 1 && t[i] <= b.recEnd + 1) v[i] = f(t[i], v[i])
}

describe('static stability checklist (synthetic trim sweep)', () => {
  it('1: δ_eq against ___cl,total with constant throttle per point is acceptable; stable gradient; G recovered within 5 %', () => {
    const r = run(trimSweep({ deltaEq: true }))
    expect(r.verdict.kind).toBe('acceptable')
    expect(r.verdict.text).toMatch(/^Acceptable for analysis — 8 points used, \d+ notes?$/)
    expect(r.gradient?.label).toBe('stable')
    expect(r.gradient?.slope).toBeCloseTo(-6, 6)
    expect(r.deltaEq?.G).toBeGreaterThan(G * 0.95)
    expect(r.deltaEq?.G).toBeLessThan(G * 1.05)
    expect(setCheck(r, 'trim-variable').status).toBe('pass')
    expect(setCheck(r, 'cl-definition').status).toBe('pass')
    expect(setCheck(r, 'cl-range').status).toBe('pass')
    expect(r.open.map((o) => o.id)).toContain('N2')
  })

  it('2: auto-trim with a noisy elevator warns trim-variable and reads neutral; δ_eq plotted passes', () => {
    const spec: TrimSpec = { trim: (_, c) => 0.75 * c - 0.5, elevNoise: (k) => (k % 2 ? 0.4 : -0.4) }
    const elevator = run(trimSweep(spec))
    expect(setCheck(elevator, 'trim-variable').status).toBe('warn')
    expect(setCheck(elevator, 'trim-variable').hint).toMatch(/elevator alone looks neutral while the trim moved/i)
    expect(elevator.gradient?.label).toBe('cannot be told apart from neutral')
    expect(setCheck(run(trimSweep({ ...spec, deltaEq: true })), 'trim-variable').status).toBe('pass')
  })

  it('3: trim frozen at the fast end: the trim alone warns, the elevator warns naming the trim type, trimType elevator passes', () => {
    const frozen = (k: number, c: number) => (k >= 5 ? 0.75 * cl({}, 4) - 0.5 : 0.75 * c - 0.5)
    const fx = trimSweep({ trim: frozen })
    expect(setCheck(run(fx, { yId: '_trim,_elev' }), 'trim-variable').hint).toMatch(/trim alone leaves out the elevator/)
    const elev = run(fx, { yId: 'elev1,__deg' })
    expect(setCheck(elev, 'trim-variable').status).toBe('warn')
    expect(setCheck(elev, 'trim-variable').hint).toMatch(/trim type/)
    expect(setCheck(elev, 'trim-variable').hint).toMatch(/N4/)
    expect(setCheck(run(fx, { yId: 'elev1,__deg', settings: { trimType: 'elevator' } }), 'trim-variable').status).toBe('pass')
  })

  it('4: _elev,_surf instead of elev1,__deg: sign −1, the same G in ratio units, elev_surf + G·trim, stable with a positive slope', () => {
    const r = run(trimSweep({ elevator: 'surf', deltaEq: true }), { yId: 'fx:delta_eq' })
    expect(r.deltaEq?.expression).toMatch(/^elev_surf \+ 0\.4 \* trim_elev$/)
    expect(r.deltaEq?.G).toBeCloseTo(G / 20, 6)
    expect(r.gradient?.slope).toBeGreaterThan(0)
    expect(r.gradient?.label).toBe('stable')
  })

  it('5: C_L from gross_lb fails (fix the analysis); a KIAS formula 8 % off fails; ___cl,total passes; x = KIAS warns', () => {
    const base = trimSweep()
    const clCh = base.ds.channels.find((c) => c.id === '___cl,total')!.values
    const kias = base.ds.channels.find((c) => c.id === '_Vind,_kias')!.values
    const gross = makeLogWithFormula(base, 'fx:cl_gross', 'Gload_norml * gross_lb * lb2n / 1000', Float64Array.from(clCh, (v) => v * 1.04))
    const r = run(gross, { xId: 'fx:cl_gross' })
    expect(setCheck(r, 'cl-definition').status).toBe('fail')
    expect(r.verdict.kind).toBe('fix-analysis')
    expect(r.verdict.text).toMatch(/^Fix the analysis — Use total,___lb/)
    // KEAS − KIAS = +4 % at the slow end: C_L from KIAS is about 8 % high there.
    const kiasFormula = makeLogWithFormula(base, 'fx:cl_kias', 'total_lb / (0.5 * 0.0023769 * (Vind_kias * 1.68781)^2 * S_ref_ft_ft)', Float64Array.from(clCh, (v, i) => v * (1 + 0.08 * Math.max(0, (200 - kias[i]) / 50))))
    expect(setCheck(run(kiasFormula, { xId: 'fx:cl_kias' }), 'cl-definition').status).toBe('fail')
    expect(setCheck(run(base), 'cl-definition').status).toBe('pass')
    expect(setCheck(run(base, { xId: '_Vind,_kias' }), 'cl-definition').status).toBe('warn')
  })

  it('6: speed drift 3 kt/min fails (point excluded), 1.5 kt/min warns, 0.5 kt/min passes', () => {
    const drift = (rate: number) =>
      trimSweep({ deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[3], '_Vind,_kias', (tt, v) => v + (rate * (tt - 140 - 3 * BLOCK)) / 60) })
    const r3 = run(drift(3))
    expect(pointCheck(r3, 'P3', 'speed-steady').status).toBe('fail')
    expect(pointOf(r3, 'P3').status).toBe('excluded')
    expect(pointCheck(run(drift(1.5)), 'P3', 'speed-steady').status).toBe('warn')
    expect(pointCheck(run(drift(0.5)), 'P3', 'speed-steady').status).toBe('pass')
  })

  it('7: flight path: +250 fpm in a level set warns (still used); an idle descent passes; no power rows warns; σ 300 fpm fails', () => {
    const level = run(trimSweep({ deltaEq: true, vvi: (k) => (k === 2 ? 250 : 0) }))
    expect(pointCheck(level, 'P2', 'flight-path').status).toBe('warn')
    expect(pointOf(level, 'P2').status).toBe('used')
    const idle = run(trimSweep({ deltaEq: true, lever: () => 0, vvi: () => -1500 }))
    expect(pointCheck(idle, 'P2', 'flight-path').status).toBe('pass')
    expect(setCheck(idle, 'thrust-method').measured).toMatch(/zero thrust/)
    const noPower = run(trimSweep({ deltaEq: true, vvi: () => -800, drop: ['thro1,handl', 'thro2,handl', 'N1__1,_pcnt', 'N1__2,_pcnt', 'thrst,_1,lb', 'thrst,_2,lb'] }))
    expect(pointCheck(noPower, 'P2', 'flight-path').status).toBe('warn')
    expect(pointCheck(noPower, 'P2', 'flight-path').hint).toMatch(/log row 25/)
    const scattered = trimSweep({ deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[4], '__VVI,__fpm', (tt) => 424 * Math.sin(2 * tt)) })
    expect(pointCheck(run(scattered), 'P4', 'flight-path').status).toBe('fail')
  })

  it('8: level flight at α 12° (n_z = cos 12°, θ = 12°) passes the load-factor test', () => {
    const r = run(trimSweep({ deltaEq: true, alpha: () => 12 }))
    expect(pointCheck(r, 'P0', 'flight-path').status).toBe('pass')
    expect(pointCheck(r, 'P0', 'flight-path').measured).toMatch(/n_z − cosθcosφ 0\.0000/)
  })

  it('9: bank 12° fails, 8° warns; sideslip 3° warns, 1.5° passes, 6° fails', () => {
    const at = (bank: number, beta: number) => pointCheck(run(trimSweep({ bank: (k) => (k === 1 ? bank : 0), beta: (k) => (k === 1 ? beta : 0) })), 'P1', 'wings-level').status
    expect(at(12, 0)).toBe('fail')
    expect(at(8, 0)).toBe('warn')
    expect(at(0, 3)).toBe('warn')
    expect(at(0, 1.5)).toBe('pass')
    expect(at(0, 6)).toBe('fail')
  })

  it('10: a thrust step of 8 % inside a point fails throttle-fixed; its second half alone passes; a change 0.5 s after it ends passes', () => {
    const step = trimSweep({
      deltaEq: true,
      hook: (cols, t, b) => {
        for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) inRecord(cols, t, b[5], token, (tt, v) => (tt >= b[5].recStart + 30 ? v * 1.08 : v))
      },
    })
    const r = run(step)
    expect(pointCheck(r, 'P5', 'throttle-fixed').status).toBe('fail')
    expect(pointCheck(r, 'P5', 'throttle-fixed').hint).toMatch(/re-cut/)
    const cut = { ds: step.ds, points: step.points.map((p, k) => (k === 5 ? pointAt(step.ds, 'P5', step.blocks[5].recStart + 31, step.blocks[5].recEnd) : p)) }
    expect(pointCheck(run(cut), 'P5', 'throttle-fixed').status).toBe('pass')
    const after = trimSweep({
      deltaEq: true,
      hook: (cols, t, b) => {
        for (const token of ['thrst,_1,lb', 'thrst,_2,lb', 'thro1,handl', 'thro2,handl']) {
          const v = cols[token]
          for (let i = 0; i < t.length; i += 1) if (t[i] >= b[5].recEnd + 0.5 && t[i] < b[5].end) v[i] *= 1.2
        }
      },
    })
    expect(pointCheck(run(after), 'P5', 'throttle-fixed').status).toBe('pass')
  })

  it('11: a 0.08 stick pulse fails controls-fixed; a one-frame trim step of 0.1 fails ("trim step"); a 0.01 trim drift warns', () => {
    const stick = trimSweep({ hook: (cols, t, b) => inRecord(cols, t, b[2], '_elev,stick', (tt) => (tt > b[2].recStart + 20 && tt < b[2].recStart + 21 ? 0.08 : 0)) })
    expect(pointCheck(run(stick), 'P2', 'controls-fixed').status).toBe('fail')
    const stepFx = trimSweep({ hook: (cols, t, b) => inRecord(cols, t, b[2], '_trim,_elev', (tt, v) => (Math.abs(tt - (b[2].recStart + 30)) < 0.05 ? v + 0.1 : v)) })
    const trimStep = pointCheck(run(stepFx), 'P2', 'trim-fixed')
    expect(trimStep.status).toBe('fail')
    expect(trimStep.hint).toMatch(/Trim step/)
    const driftFx = trimSweep({ hook: (cols, t, b) => inRecord(cols, t, b[2], '_trim,_elev', (tt, v) => v + (0.01 * (tt - b[2].recStart)) / 60) })
    expect(pointCheck(run(driftFx), 'P2', 'trim-fixed').status).toBe('warn')
  })

  it('12: flaps 0.25 in one point fail configuration-match; a flap change inside a point fails; no gear row warns', () => {
    const one = run(trimSweep({ deltaEq: true, flaps: (k) => (k === 3 ? 0.25 : 0) }))
    expect(pointCheck(one, 'P3', 'configuration-match').status).toBe('fail')
    expect(pointOf(one, 'P3').status).toBe('excluded')
    const moving = trimSweep({ hook: (cols, t, b) => inRecord(cols, t, b[1], '_flap,postn', (tt) => 0.25 * ramp(tt, b[1].recStart + 20, 2)) })
    expect(pointCheck(run(moving), 'P1', 'configuration-constant').status).toBe('fail')
    expect(pointCheck(run(trimSweep({ drop: ['_gear,__0/1'] })), 'P1', 'configuration-constant').status).toBe('warn')
  })

  it('13: a 6 % lift deficit at the highest α makes the point "plot only" (still acceptable); 2.5 % is info and used', () => {
    const r = run(trimSweep({ deltaEq: true, clScale: (k) => (k === 0 ? 0.94 : 1) }))
    expect(pointCheck(r, 'P0', 'near-stall').status).toBe('warn')
    expect(pointOf(r, 'P0').status).toBe('plot-only')
    expect(r.verdict.kind).toBe('acceptable')
    expect(r.verdict.text).toMatch(/1 left out \(plot only \(near the stall\): P0\)/)
    const mild = run(trimSweep({ deltaEq: true, clScale: (k) => (k === 0 ? 0.975 : 1) }))
    expect(pointCheck(mild, 'P0', 'near-stall').status).toBe('info')
    expect(pointOf(mild, 'P0').status).toBe('used')
  })

  it('14–15: M 0.72 at the fast end warns compressibility; 0.55 passes; 300 ft AGL warns envelope without changing the verdict', () => {
    expect(setCheck(run(trimSweep({ mach: (k) => (k === 7 ? 0.72 : 0.5) })), 'compressibility').status).toBe('warn')
    expect(setCheck(run(trimSweep({ mach: () => 0.55 })), 'compressibility').status).toBe('pass')
    const low = run(trimSweep({ deltaEq: true, agl: (k) => (k === 4 ? 300 : 8000) }))
    expect(pointCheck(low, 'P4', 'envelope').status).toBe('warn')
    expect(low.verdict.kind).toBe('acceptable')
  })

  it('16: thrust method: varying levers warn "power-on"; all levers 0 pass "zero thrust"; one lever with climbs and descents passes', () => {
    const varying = setCheck(run(trimSweep({ deltaEq: true })), 'thrust-method')
    expect(varying.status).toBe('warn')
    expect(varying.hint).toMatch(/power-on/)
    expect(setCheck(run(trimSweep({ deltaEq: true, lever: () => 0 })), 'thrust-method').measured).toMatch(/^zero thrust/)
    const constant = setCheck(run(trimSweep({ deltaEq: true, lever: () => 0.5, vvi: (k) => (k % 2 ? 400 : -400) })), 'thrust-method')
    expect(constant.status).toBe('pass')
    expect(constant.measured).toMatch(/^constant power/)
  })

  it('17: one CG line is info with N3; three groups 1.5 ft apart give the neutral point; two groups warn', () => {
    const one = run(trimSweep({ deltaEq: true, cg: (k) => 1 + 0.05 * (k / 7) }))
    expect(setCheck(one, 'cg-lines').status).toBe('info')
    expect(one.open.map((o) => o.id)).toContain('N3')
    // Three CG lines: gradient −2·(4.5 − cg) per C_L, so h_n = 4.5 ft. Trim still; the elevator carries the change.
    const three = (groups: number) =>
      trimSweep({
        n: 12,
        keas: (k) => 150 + ((k % 4) * 130) / 3,
        cg: (k) => -1.5 + 1.5 * Math.floor((k * groups) / 12),
        group: (k) => `g${1 + Math.floor((k * groups) / 12)}`,
        trim: () => 0.1,
        deq: (k, c) => 2 - 2 * (4.5 - (-1.5 + 1.5 * Math.floor((k * groups) / 12))) * c,
      })
    const r3 = run(three(3), { yId: 'elev1,__deg' })
    expect(setCheck(r3, 'cg-lines').status).toBe('pass')
    expect(Math.abs(r3.neutralPoint.hn - 4.5)).toBeLessThanOrEqual(Math.max(1e-6, r3.neutralPoint.se))
    expect(setCheck(run(three(2), { yId: 'elev1,__deg' }), 'cg-lines').status).toBe('warn')
  })

  it('18: who flew pitch (rows 108/117 absent): servo-following surfaces are "autopilot" at any gain; a frozen servo is "pilot"', () => {
    const t = times(200, RATE)
    const servo = Float64Array.from(t, (tt) => 0.02 * Math.sin(0.5 * tt))
    const zero = new Float64Array(t.length)
    const make = (surf: Float64Array, stick: Float64Array, sv: Float64Array) => makeLog(t, { '_elev,_surf': surf, '_elev,stick': stick, '_elev,servo': sv })
    const at = (ds: Dataset) => pitchControlSource(ds, 700, 1300)?.source
    expect(at(make(servo, zero, servo))).toBe('autopilot')
    expect(at(make(Float64Array.from(servo, (v) => 0.6 * v), zero, servo))).toBe('autopilot')
    const stick = Float64Array.from(t, (tt) => 0.1 * Math.sin(0.3 * tt))
    expect(at(make(stick, stick, Float64Array.from(t, () => 0.3)))).toBe('pilot')
    expect(at(make(zero, zero, zero))).toBe('hands-off')
    // In a sweep without mode rows: inferred, so autopilot-record warns and N1 is shown; notes on every point pass.
    const ap = trimSweep({
      deltaEq: true,
      modesLogged: false,
      hook: (cols, tt) => {
        cols['_elev,servo'] = Float64Array.from(tt, (x) => 0.02 * Math.sin(0.5 * x))
        cols['_elev,_surf'] = Float64Array.from(cols['_elev,servo'])
      },
    })
    const r = run(ap)
    expect(setCheck(r, 'autopilot-record').status).toBe('warn')
    expect(setCheck(r, 'autopilot-record').hint).toMatch(/autopilot held pitch in 8 points \(inferred\)/)
    expect(r.open.map((o) => o.id)).toContain('N1')
    const noted = run({ ds: ap.ds, points: ap.points.map((p) => ({ ...p, note: 'ALT HOLD + HDG, A/T off' })) })
    expect(setCheck(noted, 'autopilot-record').status).toBe('pass')
  })

  it('19: without row 13 trim-variable is not checkable and the verdict cannot confirm', () => {
    const r = run(trimSweep({ drop: ['_trim,_elev', '_flap,postn', '_slat,ratio', 'sbrak,postn'] }), { yId: 'elev1,__deg' })
    expect(setCheck(r, 'trim-variable').criterion).toBe('Not checkable — log row 13 (Trim, flaps, slats & speedbrakes)')
    expect(r.verdict.kind).toBe('cannot-confirm')
    expect(r.verdict.text).toMatch(/^Cannot confirm — tick rows 13 \(Trim, flaps, slats & speedbrakes\)/)
  })

  it('20: a reset inside a point fails time-base; 4 s fails and 8 s warns record-length; 0.1 Hz fails and a 2 s gap warns sample-rate', () => {
    const fx = trimSweep({ deltaEq: true })
    const mid = fx.points[2].start + 300
    const reset = { ds: { ...fx.ds, segments: [{ start: 0, end: mid, reason: 'start' as const }, { start: mid, end: fx.ds.rowCount, reason: 'reset' as const }] }, points: fx.points }
    expect(pointCheck(run(reset), 'P2', 'time-base').status).toBe('fail')
    const short = (seconds: number) => ({ ds: fx.ds, points: fx.points.map((p, k) => (k === 1 ? pointAt(fx.ds, 'P1', fx.blocks[1].recStart, fx.blocks[1].recStart + seconds) : p)) })
    expect(pointCheck(run(short(4)), 'P1', 'record-length').status).toBe('fail')
    expect(pointCheck(run(short(8)), 'P1', 'record-length').status).toBe('warn')
    const sparse = subsample(fx.ds, 100)
    const sparsePoints = fx.blocks.map((b) => pointAt(sparse, `P${b.k}`, b.recStart, b.recEnd))
    expect(pointCheck(run({ ds: sparse, points: sparsePoints }), 'P3', 'sample-rate').status).toBe('fail')
    const gap = dropRows(fx.ds, (time) => time > fx.blocks[3].recStart + 20 && time < fx.blocks[3].recStart + 22)
    const gapPoints = fx.blocks.map((b) => pointAt(gap, `P${b.k}`, b.recStart, b.recEnd))
    expect(pointCheck(run({ ds: gap, points: gapPoints }), 'P3', 'sample-rate').status).toBe('warn')
  })

  it('21: a lever change 30 s before a steady point is info; with a 2 kt/min drift it warns; 90 s before passes', () => {
    const late = (drift: number) =>
      trimSweep({
        deltaEq: true,
        change: (k) => (k === 4 ? 80 : 20),
        hook: drift ? (cols, t, b) => inRecord(cols, t, b[4], '_Vind,_kias', (tt, v) => v + (drift * (tt - 140 - 4 * BLOCK)) / 60) : undefined,
      })
    expect(pointCheck(run(late(0)), 'P4', 'stabilised').status).toBe('info')
    expect(pointCheck(run(late(2)), 'P4', 'stabilised').status).toBe('warn')
    expect(pointCheck(run(trimSweep({ deltaEq: true })), 'P4', 'stabilised').status).toBe('pass')
  })

  it('22–23: two points left after exclusions is "Retest required"; without row 152 the verdict does not change', () => {
    const three = trimSweep({ n: 3, deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[1], '_elev,stick', (tt) => (tt > b[1].recStart + 5 && tt < b[1].recStart + 6 ? 0.2 : 0)) })
    const r = run(three)
    expect(r.verdict.kind).toBe('retest')
    expect(r.verdict.text).toMatch(/^Retest required/)
    const noWeather = run(trimSweep({ deltaEq: true, drop: ['_turb,_locl', '_wind,knots', '_wind,v_fpm'] }))
    expect(pointCheck(noWeather, 'P1', 'weather').status).toBe('not-checkable')
    expect(noWeather.verdict.kind).toBe('acceptable')
  })

  it('a thrust step early in every point: the verdict says re-cut (fix the analysis), not fly more points; re-cut, the set is acceptable', () => {
    const hunting = trimSweep({
      deltaEq: true,
      hook: (cols, t, blocks) => {
        for (const b of blocks) for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) inRecord(cols, t, b, token, (tt, v) => (tt < b.recStart + 12 ? v * 1.06 : v))
      },
    })
    const r = run(hunting)
    expect(r.points.every((p) => p.status === 'excluded')).toBe(true)
    expect(r.verdict.kind).toBe('fix-analysis')
    expect(r.verdict.text).toMatch(/^Fix the analysis — re-cut the 8 flagged points \(the power or trim moved inside them\)/)
    expect(r.verdict.text).not.toMatch(/fly more/)
    const plan = recutPlan(hunting.ds, hunting.points, recutFailing(r.points, 'static'))
    expect(plan).toHaveLength(8)
    const cut = hunting.points.map((p) => {
      const x = plan.find((q) => q.point.id === p.id)
      return x ? { ...p, start: x.recut.start, end: x.recut.end } : p
    })
    expect(run({ ds: hunting.ds, points: cut }).verdict.kind).toBe('acceptable')
    // A stick input is not removed by a re-cut: two usable points stay "Retest required".
    const three = trimSweep({ n: 3, deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[1], '_elev,stick', (tt) => (tt > b[1].recStart + 5 && tt < b[1].recStart + 6 ? 0.2 : 0)) })
    expect(run(three).verdict.text).toMatch(/^Retest required — only 2 points usable: fly more trim points$/)
  })

  it('set checks over the used points never pass on too few: trim variable and thrust method need two, C_L definition and Mach one', () => {
    const fx = trimSweep({ deltaEq: true })
    const one = run({ ds: fx.ds, points: [fx.points[3]] })
    expect(setCheck(one, 'trim-variable').status).toBe('not-checkable')
    expect(setCheck(one, 'trim-variable').criterion).toMatch(/Needs two or more used points/)
    expect(setCheck(one, 'thrust-method').status).toBe('not-checkable')
    expect(setCheck(one, 'cl-definition').status).toBe('pass')
    const p = fx.points[3]
    const none = run({ ds: fx.ds, points: [{ ...p, end: p.start + 30 }] }) // 3 s: record-length fails
    expect(none.used).toHaveLength(0)
    for (const id of ['trim-variable', 'thrust-method', 'cl-definition', 'compressibility']) expect(setCheck(none, id).status).toBe('not-checkable')
  })

  it('names the configuration tolerances as engineering judgement and gives N1 its sources', () => {
    const r = run(
      trimSweep({
        deltaEq: true,
        modesLogged: false,
        hook: (cols, t) => {
          cols['_elev,servo'] = Float64Array.from(t, (x) => 0.02 * Math.sin(0.5 * x))
          cols['_elev,_surf'] = Float64Array.from(cols['_elev,servo'], (v) => 0.6 * v)
        },
      }),
    )
    expect(pointCheck(r, 'P0', 'configuration-constant').judgement).toBe(true)
    expect(pointCheck(r, 'P0', 'configuration-match').judgement).toBe(true)
    const n1 = r.open.find((o) => o.id === 'N1')
    expect(n1?.citations).toEqual(expect.arrayContaining(['Brief pp.1-9', 'FD13 p.13', 'NATO AG-300 v14 p.15-4']))
    // Only published sources are cited: never unpublished reports.
    expect(n1?.citations.some((c) => /^Ref\b/.test(c))).toBe(false)
    expect(n1?.question).not.toMatch(/report/i)
  })

  it('25: the CSV rows guard formula-like text and carry the point verdicts', () => {
    const fx = trimSweep({ deltaEq: true })
    const r = run({ ds: fx.ds, points: fx.points.map((p, k) => (k === 0 ? { ...p, name: '=HYPERLINK("x")' } : p)) })
    const csv = checklistCsv(setReportRows(r))
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toMatch(/,point-verdict,Point verdict,use,/)
    expect(csv).toMatch(/,N2,Lateral-directional static stability,not settled,open,/)
  })
})

/** The sweep with an extra formula channel (x axis). */
function makeLogWithFormula(fx: { ds: Dataset; points: TestPoint[] }, id: string, expression: string, values: Float64Array) {
  const cols: Columns = {}
  for (const ch of fx.ds.channels) if (!ch.derived && ch.token !== '_totl,_time') cols[ch.token] = ch.values
  const ds = makeLog(fx.ds.elapsed, cols, { formulas: { [id]: [expression, values] } })
  return { ds, points: fx.points }
}

/** Every k-th row only. */
function subsample(ds: Dataset, k: number): Dataset {
  return dropRows(ds, (_, i) => i % k !== 0)
}

/** The dataset without the rows `drop` picks (time, index). */
function dropRows(ds: Dataset, drop: (time: number, i: number) => boolean): Dataset {
  const keep: number[] = []
  for (let i = 0; i < ds.rowCount; i += 1) if (!drop(ds.elapsed[i], i)) keep.push(i)
  const cols: Columns = {}
  for (const ch of ds.channels) if (!ch.derived && ch.token !== '_totl,_time') cols[ch.token] = Float64Array.from(keep, (i) => ch.values[i])
  const formulas: Record<string, [string, Float64Array]> = {}
  for (const ch of ds.channels) if (ch.derived) formulas[ch.id] = [ch.derived.expression, Float64Array.from(keep, (i) => ch.values[i])]
  return makeLog(Float64Array.from(keep, (i) => ds.elapsed[i]), cols, { formulas })
}
