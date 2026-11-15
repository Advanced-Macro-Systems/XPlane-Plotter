import { describe, expect, it } from 'vitest'
import type { Dataset, PointGroup, TestPoint } from '../types'
import { setReportRows, checklistCsv } from './export'
import { makeLog, pointAt, ramp, times, type Columns } from './fixtures'
import { pitchControlSource } from './helpers'
import { recutFailing, recutPlan } from './recut'
import { runStaticChecks, STATIC_DEFS, STATIC_OPEN, TRIM_CHECK_THRESHOLDS, type StaticInput, type TrimCheckSettings } from './staticStability'

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

  it('7: flight path: +250 fpm in a level set warns (still used); an idle descent passes; no power rows is only noted; σ 300 fpm fails', () => {
    const level = run(trimSweep({ deltaEq: true, vvi: (k) => (k === 2 ? 250 : 0) }))
    expect(pointCheck(level, 'P2', 'flight-path').status).toBe('warn')
    expect(pointOf(level, 'P2').status).toBe('used')
    const idle = run(trimSweep({ deltaEq: true, lever: () => 0, vvi: () => -1500 }))
    expect(pointCheck(idle, 'P2', 'flight-path').status).toBe('pass')
    expect(setCheck(idle, 'thrust-method').measured).toMatch(/zero-thrust procedure/)
    // Without a power row the method is unknown: a descent (the lecture's zero-thrust trims are glides) is not warned.
    const noPower = run(trimSweep({ deltaEq: true, vvi: () => -800, drop: ['thro1,handl', 'thro2,handl', 'N1__1,_pcnt', 'N1__2,_pcnt', 'thrst,_1,lb', 'thrst,_2,lb'] }))
    expect(pointCheck(noPower, 'P2', 'flight-path').status).toBe('info')
    expect(pointCheck(noPower, 'P2', 'flight-path').hint).toMatch(/log row 25/)
    expect(pointCheck(noPower, 'P2', 'flight-path').criterion).toMatch(/thrust method unknown: a point not level gets an info note/)
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

  it('10: without a lever or N1, a thrust step of 8 % inside a level point fails throttle-fixed; its second half alone passes; a change 0.5 s after it ends passes', () => {
    // N1 stands in before the force when it is logged, so the force path needs both dropped.
    const noLever = ['thro1,handl', 'thro2,handl', 'N1__1,_pcnt', 'N1__2,_pcnt']
    const thrustStep = (drop: string[]) =>
      trimSweep({
        deltaEq: true,
        drop,
        hook: (cols, t, b) => {
          for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) inRecord(cols, t, b[5], token, (tt, v) => (tt >= b[5].recStart + 30 ? v * 1.08 : v))
        },
      })
    const step = thrustStep(noLever)
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
    // The same thrust step at a still lever (and still N1) passes: the sources fix the setting (MIL p.40 (a)), and it decides.
    const atStillLever = pointCheck(run(thrustStep([])), 'P5', 'throttle-fixed')
    expect(atStillLever.status).toBe('pass')
    expect(atStillLever.measured).toMatch(/^lever range 0; thrust range [\d.]+ % of its level; N1 range 0\.00 %pt \(not judged: the setting decides\)$/)
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

  it('12: flaps 0.25 in one point fail configuration-match (plotted but left out of the fit: plot it separately, not "Retest"); a flap change inside a point fails; no gear row warns', () => {
    const one = run(trimSweep({ deltaEq: true, flaps: (k) => (k === 3 ? 0.25 : 0) }))
    expect(pointCheck(one, 'P3', 'configuration-match').status).toBe('fail')
    // 'plot-only' (plotted, left out of the fit), not 'excluded' (retest or re-cut): the X–Y summary then says "plot only".
    expect(pointOf(one, 'P3').status).toBe('plot-only')
    expect(one.used).not.toContain('P3')
    expect(pointOf(one, 'P3').label).toBe('Plot separately')
    expect(pointOf(one, 'P3').reasons).toEqual(['another configuration (plot it separately)'])
    expect(one.verdict.text).toMatch(/7 points used, 1 left out \(another configuration \(plot it separately\): P3\)/)
    const moving = trimSweep({ hook: (cols, t, b) => inRecord(cols, t, b[1], '_flap,postn', (tt) => 0.25 * ramp(tt, b[1].recStart + 20, 2)) })
    expect(pointCheck(run(moving), 'P1', 'configuration-constant').status).toBe('fail')
    expect(pointCheck(run(trimSweep({ drop: ['_gear,__0/1'] })), 'P1', 'configuration-constant').status).toBe('warn')
  })

  it('13: a 6 % lift deficit at the highest α warns near-stall but the point stays in the fit with a note (advisory); Left out takes it out; 2.5 % is info', () => {
    const fx = trimSweep({ deltaEq: true, clScale: (k) => (k === 0 ? 0.94 : 1) })
    const r = run(fx)
    const nearStall = pointCheck(r, 'P0', 'near-stall')
    expect(nearStall.status).toBe('warn')
    expect(nearStall.hint).toBe('Near the stall: check the gradient with and without this point; leave it out (Left out) if the trim curve bends.')
    expect(pointOf(r, 'P0').status).toBe('used')
    expect(pointOf(r, 'P0').label).toBe('Use')
    expect(r.used).toContain('P0')
    expect(r.verdict.kind).toBe('acceptable')
    expect(r.verdict.text).toMatch(/^Acceptable for analysis — 8 points used, \d+ notes$/)
    expect(r.notes).toContain('Not near the stall: warn at P0')
    // The user's own choice: Left out.
    const leftOut = run(fx, { settings: { fitExcluded: ['P0'] } })
    expect(pointOf(leftOut, 'P0').status).toBe('left-out')
    expect(leftOut.verdict.text).toMatch(/7 points used, 1 left out \(left out by you: P0\)/)
    const mild = run(trimSweep({ deltaEq: true, clScale: (k) => (k === 0 ? 0.975 : 1) }))
    expect(pointCheck(mild, 'P0', 'near-stall').status).toBe('info')
    expect(pointOf(mild, 'P0').status).toBe('used')
  })

  it('14–15: M 0.72 at the fast end warns compressibility; 0.55 passes; 150 ft AGL warns envelope without changing the verdict, 300 ft passes', () => {
    expect(setCheck(run(trimSweep({ mach: (k) => (k === 7 ? 0.72 : 0.5) })), 'compressibility').status).toBe('warn')
    expect(setCheck(run(trimSweep({ mach: () => 0.55 })), 'compressibility').status).toBe('pass')
    const low = run(trimSweep({ deltaEq: true, agl: (k) => (k === 4 ? 150 : 8000) }))
    expect(pointCheck(low, 'P4', 'envelope').status).toBe('warn')
    expect(low.verdict.kind).toBe('acceptable')
    // 200 ft, the same one-wingspan stand-in as the performance checklist.
    expect(pointCheck(run(trimSweep({ deltaEq: true, agl: (k) => (k === 4 ? 300 : 8000) })), 'P4', 'envelope').status).toBe('pass')
  })

  it('16: thrust method: varying levers warn "power-on"; all levers 0 pass "idle (zero-thrust procedure)"; one lever with climbs and descents passes', () => {
    const varying = setCheck(run(trimSweep({ deltaEq: true })), 'thrust-method')
    expect(varying.status).toBe('warn')
    expect(varying.hint).toMatch(/power-on/)
    expect(setCheck(run(trimSweep({ deltaEq: true, lever: () => 0 })), 'thrust-method').measured).toMatch(/^idle \(zero-thrust procedure\) \(every lever ≤ 0\.05\)/)
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

  it('20: a reset inside a point fails time-base; 4 s fails and 8 s warns record-length; 0.1 Hz only warns (record-length’s sample floor fails it) and a 2 s gap is only noted by sample-rate', () => {
    const fx = trimSweep({ deltaEq: true })
    const mid = fx.points[2].start + 300
    const reset = { ds: { ...fx.ds, segments: [{ start: 0, end: mid, reason: 'start' as const }, { start: mid, end: fx.ds.rowCount, reason: 'reset' as const }] }, points: fx.points }
    expect(pointCheck(run(reset), 'P2', 'time-base').status).toBe('fail')
    const short = (seconds: number) => ({ ds: fx.ds, points: fx.points.map((p, k) => (k === 1 ? pointAt(fx.ds, 'P1', fx.blocks[1].recStart, fx.blocks[1].recStart + seconds) : p)) })
    expect(pointCheck(run(short(4)), 'P1', 'record-length').status).toBe('fail')
    expect(pointCheck(run(short(8)), 'P1', 'record-length').status).toBe('warn')
    const sparse = subsample(fx.ds, 100)
    const sparsePoints = fx.blocks.map((b) => pointAt(sparse, `P${b.k}`, b.recStart, b.recEnd))
    // NATO sets no minimum rate for trim data (15-5): 0.1 Hz only warns, as sparse; the 7 samples fail record-length.
    const sparseRun = run({ ds: sparse, points: sparsePoints })
    expect(pointCheck(sparseRun, 'P3', 'sample-rate').status).toBe('warn')
    expect(pointCheck(sparseRun, 'P3', 'sample-rate').hint).toMatch(/^Sparse: fewer than one sample per 5 s/)
    expect(pointCheck(sparseRun, 'P3', 'record-length').status).toBe('fail')
    expect(pointOf(sparseRun, 'P3').reasons).toEqual(['too short'])
    const gap = dropRows(fx.ds, (time) => time > fx.blocks[3].recStart + 20 && time < fx.blocks[3].recStart + 22)
    const gapPoints = fx.blocks.map((b) => pointAt(gap, `P${b.k}`, b.recStart, b.recEnd))
    // An isolated dropout does not spoil a quasi-steady mean: info, not warn (only a low rate warns).
    const dropout = pointCheck(run({ ds: gap, points: gapPoints }), 'P3', 'sample-rate')
    expect(dropout.status).toBe('info')
    expect(dropout.measured).toMatch(/, 1 dropout$/)
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

  it('a throttle step early in every point: the verdict says re-cut (fix the analysis), not fly more points; re-cut, the set is acceptable', () => {
    // The lever moves (the thrust follows) in the first 12 s of every point.
    const hunting = trimSweep({
      deltaEq: true,
      hook: (cols, t, blocks) => {
        for (const b of blocks) {
          for (const token of ['thro1,handl', 'thro2,handl']) inRecord(cols, t, b, token, (tt, v) => (tt < b.recStart + 12 ? v + 0.05 : v))
          for (const token of ['thrst,_1,lb', 'thrst,_2,lb']) inRecord(cols, t, b, token, (tt, v) => (tt < b.recStart + 12 ? v * 1.06 : v))
        }
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

describe('static checklist: what the sources say, the app’s own lines and the fixes (synthetic trim sweep)', () => {
  it('cl-range: a C_L ratio under 1.3 only warns (no source sets a minimum span) and the verdict stays acceptable; used points without a C_L cannot confirm (check the C_L), not Retest', () => {
    // 200–220 KEAS: a C_L ratio of about 1.2.
    const narrow = run(trimSweep({ deltaEq: true, keas: (k) => 200 + (k * 20) / 7 }))
    const range = setCheck(narrow, 'cl-range')
    expect(range.status).toBe('warn')
    expect(range.measured).toMatch(/\(ratio 1\.2\d\)/)
    expect(range.hint).toMatch(/^A narrow C_L range/)
    expect(narrow.verdict.kind).toBe('acceptable')
    // A C_L at only two of the eight used points: a data gap, so not checkable (Cannot confirm), and flying more points
    // is the wrong advice.
    const twoCl = trimSweep({ deltaEq: true, hook: (cols, t, b) => [0, 1, 2, 3, 4, 5].forEach((k) => inRecord(cols, t, b[k], '___cl,total', () => NaN)) })
    const few = run(twoCl)
    expect(few.used).toHaveLength(8)
    expect(setCheck(few, 'cl-range').status).toBe('not-checkable')
    expect(setCheck(few, 'cl-range').criterion).toBe('Needs a C_L at three or more used points: 2 of the 8 have one (check the C_L channel or its inputs at the others)')
    expect(few.verdict.kind).toBe('cannot-confirm')
    expect(few.verdict.text).toBe('Cannot confirm — fewer than 3 used points have a C_L: check the C_L channel or its inputs at the others')
    // Fewer than three used points is the critical floor: cl-range fails (fly more points).
    const fx = trimSweep({ deltaEq: true })
    const two = run({ ds: fx.ds, points: fx.points.slice(0, 2) })
    expect(setCheck(two, 'cl-range').status).toBe('fail')
    expect(setCheck(two, 'cl-range').hint).toMatch(/^Fly more trim points/)
    expect(two.verdict.text).toMatch(/^Retest required — only 2 points usable: fly more trim points/)
  })

  it('near-stall applies the V_S lines it states, and its criterion lists every condition (the point stays in the fit)', () => {
    // V_S 130 KIAS: P0 at 150 KIAS is 1.15 V_S (warn), P1 at about 169 KIAS is 1.30 V_S (info), P2 at about 187 passes.
    const r = run(trimSweep({ deltaEq: true }), { settings: { limits: { vsKias: 130 } } })
    expect(pointCheck(r, 'P0', 'near-stall').status).toBe('warn')
    expect(pointCheck(r, 'P1', 'near-stall').status).toBe('info')
    expect(pointCheck(r, 'P2', 'near-stall').status).toBe('pass')
    expect(pointOf(r, 'P0').status).toBe('used')
    const criterion = pointCheck(r, 'P0', 'near-stall').criterion
    for (const part of ['> 3 %', '< 0.7', '1.2 V_S', 'within 2° of α_stall', '> 2 %', '< 0.85', '1.3 V_S', 'within 4°', '2 kt/min', 'lowest-α 60 %', 'stays in the fit']) expect(criterion).toContain(part)
  })

  it('throttle-fixed: a lever step fails; without a lever a point near idle is judged against a quarter of the log’s largest thrust, so a zero-thrust point cannot fail on a ratio', () => {
    // The lever steps and N1 follows (2 %pt): the setting moved, so N1 is not judged on top of it.
    const leverStep = trimSweep({
      deltaEq: true,
      hook: (cols, t, b) => {
        for (const token of ['thro1,handl', 'thro2,handl']) inRecord(cols, t, b[5], token, (tt, v) => (tt >= b[5].recStart + 30 ? v + 0.05 : v))
        for (const token of ['N1__1,_pcnt', 'N1__2,_pcnt']) inRecord(cols, t, b[5], token, (tt, v) => (tt >= b[5].recStart + 30 ? v + 2 : v))
      },
    })
    const stepped = pointCheck(run(leverStep), 'P5', 'throttle-fixed')
    expect(stepped.status).toBe('fail')
    expect(stepped.measured).toMatch(/^lever range 0\.05; .*\(not judged: the setting decides\)$/)
    // Thrust about 0 ± 20 lb in P2 (no lever or N1 logged): its mean is near zero, so a ratio to it would blow up.
    const idle = trimSweep({
      deltaEq: true,
      drop: ['thro1,handl', 'thro2,handl', 'N1__1,_pcnt', 'N1__2,_pcnt'],
      hook: (cols, t, b) => ['thrst,_1,lb', 'thrst,_2,lb'].forEach((token) => inRecord(cols, t, b[2], token, (tt) => 10 * Math.sin(0.2 * (tt - b[2].recStart)))),
    })
    const atIdle = pointCheck(run(idle), 'P2', 'throttle-fixed')
    expect(atIdle.status).toBe('pass')
    expect(atIdle.measured).toMatch(/^thrust range [\d.]+ % of its level \(judged against a quarter of the log’s largest force\)$/)
    expect(atIdle.criterion).toMatch(/^the setting decides when logged/)
    expect(atIdle.criterion).toContain('or of the point’s own largest')
  })

  it('controls-fixed: a still stick held off-centre is only noted (Cook’s controls-fixed procedure holds the column)', () => {
    const held = run(trimSweep({ deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[2], '_elev,stick', () => 0.1) }))
    const check = pointCheck(held, 'P2', 'controls-fixed')
    expect(check.status).toBe('info')
    expect(check.hint).toMatch(/plot the elevator rather than the trim/)
    expect(pointOf(held, 'P2').status).toBe('used')
    expect(held.notes.some((n) => /Controls fixed/.test(n))).toBe(false)
  })

  it('sample-rate warns only on a systematically low rate (0.5 Hz)', () => {
    const fx = trimSweep({ deltaEq: true })
    const slow = subsample(fx.ds, 20)
    const check = pointCheck(run({ ds: slow, points: fx.blocks.map((b) => pointAt(slow, `P${b.k}`, b.recStart, b.recEnd)) }), 'P3', 'sample-rate')
    expect(check.status).toBe('warn')
    expect(check.hint).toBe('Log at 10 writes per second.')
    // 0.2 Hz is NATO 13-6's recording rate for climbs, not a minimum it sets: borrowed for the sparse-rate warning only.
    expect(check.sourced).toMatch(/^0\.2 Hz \(one sample per 5 s\): NATO 13-6’s recording rate for classical climbs, borrowed for the app’s sparse-rate warning \(NATO sets no minimum for trim data, 15-5\)/)
  })

  it('stabilised: a lever change 30 s before a point with no thrust, power or N1 row warns: an unmeasured force trend is not a flat one', () => {
    const r = run(trimSweep({ deltaEq: true, change: (k) => (k === 4 ? 80 : 20), drop: ['thrst,_1,lb', 'thrst,_2,lb', 'N1__1,_pcnt', 'N1__2,_pcnt'] }))
    const check = pointCheck(r, 'P4', 'stabilised')
    expect(check.status).toBe('warn')
    expect(check.measured).toMatch(/force trend not measured/)
    expect(check.hint).toMatch(/log row 34, 35 or 41/)
  })

  it('speed-steady uses one measure, the change over the point: a 150 s point drifting 0.9 kt/min fails, 0.6 kt/min warns, 0.3 kt/min passes', () => {
    const long = (rate: number) => {
      const fx = trimSweep({
        deltaEq: true,
        hook: (cols, t, b) => {
          const v = cols['_Vind,_kias']
          for (let i = 0; i < t.length; i += 1) if (t[i] >= b[3].start + 39 && t[i] <= b[3].start + 191) v[i] += (rate * (t[i] - b[3].start - 115)) / 60
        },
      })
      return { ds: fx.ds, points: fx.points.map((p, k) => (k === 3 ? pointAt(fx.ds, 'P3', fx.blocks[3].start + 40, fx.blocks[3].start + 190) : p)) }
    }
    // 2.25 kt over the point: it passed on the rate (≤ 1 kt/min) before, though Find steady points would reject it.
    expect(pointCheck(run(long(0.9)), 'P3', 'speed-steady').status).toBe('fail')
    expect(pointCheck(run(long(0.6)), 'P3', 'speed-steady').status).toBe('warn')
    expect(pointCheck(run(long(0.3)), 'P3', 'speed-steady').status).toBe('pass')
  })

  it('configuration-match: two equally common configurations cannot be told apart (the verdict asks for a split); a minority configuration is to plot separately', () => {
    const tie = run(trimSweep({ deltaEq: true, flaps: (k) => (k % 2 ? 0.25 : 0) }))
    expect(pointCheck(tie, 'P0', 'configuration-match').status).toBe('not-checkable')
    expect(pointCheck(tie, 'P0', 'configuration-match').criterion).toMatch(/two configurations are equally common/)
    expect(tie.verdict.kind).toBe('cannot-confirm')
    expect(tie.verdict.text).toBe('Cannot confirm — two configurations are equally common: put each in its own group and plot them separately')
    const most = run(trimSweep({ deltaEq: true, flaps: (k) => (k % 3 === 1 ? 0.25 : 0) }))
    expect(['P1', 'P4', 'P7'].map((name) => pointOf(most, name).label)).toEqual(['Plot separately', 'Plot separately', 'Plot separately'])
    expect(['P1', 'P4', 'P7'].map((name) => pointOf(most, name).status)).toEqual(['plot-only', 'plot-only', 'plot-only'])
    expect(most.verdict.kind).toBe('acceptable')
    expect(most.verdict.text).toMatch(/5 points used, 3 left out \(another configuration \(plot it separately\): P1, P4, P7\)/)
  })

  it('autopilot-record counts only mode codes: a dialled altitude changing inside a point is noted, a mode code changing warns', () => {
    const dial = run(trimSweep({ deltaEq: true, hook: (cols, t, b) => void (cols['_dial,__alt'] = Float64Array.from(t, (tt) => (tt > b[3].recStart + 20 ? 9000 : 8000))) }))
    expect(setCheck(dial, 'autopilot-record').status).toBe('pass')
    expect(setCheck(dial, 'autopilot-record').measured).toMatch(/a selected altitude, speed or vertical speed changed inside P3 \(not a mode change\)$/)
    const mode = run(trimSweep({ deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[3], '_mode,__alt', (tt) => (tt > b[3].recStart + 20 ? 2 : 1)) }))
    expect(setCheck(mode, 'autopilot-record').status).toBe('warn')
    expect(setCheck(mode, 'autopilot-record').measured).toMatch(/a mode changed inside P3/)
  })

  it('cl-definition warns on a C_L formula built on KIAS even where it agrees within 3 %', () => {
    const base = trimSweep()
    const clCh = base.ds.channels.find((c) => c.id === '___cl,total')!.values
    const kiasFormula = makeLogWithFormula(base, 'fx:cl_kias', 'total_lb / (0.5 * 0.0023769 * (Vind_kias * 1.68781)^2 * S_ref_ft_ft)', Float64Array.from(clCh, (v) => v * 1.01))
    const check = setCheck(run(kiasFormula, { xId: 'fx:cl_kias' }), 'cl-definition')
    expect(check.status).toBe('warn')
    expect(check.measured).toMatch(/\(uses KIAS\)$/)
    expect(check.hint).toBe('Use KEAS for the dynamic pressure, not KIAS.')
  })

  it('trim-variable fits against C_L, not a plotted speed: with KEAS on x the trim slope keeps its stable sign', () => {
    const tv = setCheck(run(trimSweep(), { xId: '_Vind,_keas', yId: 'elev1,__deg' }), 'trim-variable')
    expect(tv.measured).toMatch(/trim-only slope 0\.\d+/)
    expect(tv.measured).toMatch(/stable sign holds without G/)
    expect(tv.measured).toMatch(/slopes against n·W\/\(q̄S\) \(the x axis is not a C_L\)$/)
  })

  it('gradient reports the static margin K_n = h_n − h for each CG line once two or more lines give a neutral point', () => {
    const three = trimSweep({
      n: 12,
      keas: (k) => 150 + ((k % 4) * 130) / 3,
      cg: (k) => -1.5 + 1.5 * Math.floor((k * 3) / 12),
      group: (k) => `g${1 + Math.floor((k * 3) / 12)}`,
      trim: () => 0.1,
      deq: (k, c) => 2 - 2 * (4.5 - (-1.5 + 1.5 * Math.floor((k * 3) / 12))) * c,
    })
    expect(setCheck(run(three, { yId: 'elev1,__deg' }), 'gradient').measured).toMatch(/static margin K_n = h_n − h by CG line, fore to aft: 6 ft, 4\.5 ft, 3 ft;/)
    expect(setCheck(run(three, { yId: 'elev1,__deg', settings: { macFt: 10 } }), 'gradient').measured).toMatch(/fore to aft: 60\.0 %MAC, 45\.0 %MAC, 30\.0 %MAC;/)
    // One CG line: no neutral point, so no margin. The result says which C_L the slope was fitted against.
    expect(setCheck(run(trimSweep({ deltaEq: true })), 'gradient').measured).not.toMatch(/K_n/)
    expect(setCheck(run(trimSweep({ deltaEq: true })), 'gradient').measured).toMatch(/ per C_L against the plotted C_L \(t /)
    expect(setCheck(run(trimSweep({ deltaEq: true }), { xId: '_Vind,_keas' }), 'gradient').measured).toMatch(/against n·W\/\(q̄S\) \(the x axis is not a C_L\)/)
  })

  it('trim-fixed rests on the range alone: a small trim step warns, and the 0.5 s change only tells a step from a drift', () => {
    const step = trimSweep({ hook: (cols, t, b) => inRecord(cols, t, b[2], '_trim,_elev', (tt, v) => (tt > b[2].recStart + 30 ? v + 0.015 : v)) })
    const check = pointCheck(run(step), 'P2', 'trim-fixed')
    expect(check.status).toBe('warn')
    expect(check.measured).toMatch(/largest change in 0\.5 s 0\.015/)
    expect(check.criterion).toBe('pass: range ≤ 0.002; warn: ≤ 0.02 (an auto-trim drift or a small step); fail > 0.02 (the largest change within 0.5 s tells a step from a drift)')
  })

  it('thrust-method: fixed levers are constant power whatever N1 does; without a lever, N1 varying by more than 2 %pt cannot tell idle from re-set power (not checkable)', () => {
    const n1Moves = setCheck(
      run(trimSweep({ deltaEq: true, lever: () => 0.5, hook: (cols, t) => ['N1__1,_pcnt', 'N1__2,_pcnt'].forEach((token) => cols[token].forEach((_, i) => (cols[token][i] = 70 + 1.5 * Math.min(7, Math.floor(t[i] / BLOCK))))) })),
      'thrust-method',
    )
    expect(n1Moves.status).toBe('pass')
    expect(n1Moves.measured).toMatch(/^constant power \(lever range 0\)$/)
    // Idle N1 changes with speed too, so without a lever a varying N1 cannot tell idle from re-set power.
    const n1Only = run(trimSweep({ deltaEq: true, drop: ['thro1,handl', 'thro2,handl', 'thrst,_1,lb', 'thrst,_2,lb'] }))
    expect(setCheck(n1Only, 'thrust-method').status).toBe('not-checkable')
    expect(setCheck(n1Only, 'thrust-method').criterion).toMatch(/^Not checkable — log row 25\* \(Throttle \(commanded\)\): without the lever, N1 or the force changes with speed at a fixed setting too, so idle and re-set power look alike/)
    // A steady N1 without a lever is still constant power.
    const n1Steady = setCheck(run(trimSweep({ deltaEq: true, lever: () => 0.5, drop: ['thro1,handl', 'thro2,handl', 'thrst,_1,lb', 'thrst,_2,lb'] })), 'thrust-method')
    expect(n1Steady.status).toBe('pass')
    expect(n1Steady.measured).toMatch(/^constant power \(N1 range 0\.00 %pt \(no lever row\)\)$/)
  })

  it('throttle-fixed reads the throttle reaching the engines (row 26): an autothrottle hunting with the handle fixed fails, and thrust-method calls such a sweep power for level flight', () => {
    // Handles fixed at 0.8 (a detent); the throttle reaching the engines re-set at each speed and hunting ±0.05 in P2.
    const engin = (tt: number) => {
      const k = Math.min(7, Math.floor(tt / BLOCK))
      return 0.4 + 0.03 * k + (k === 2 ? 0.05 * Math.sin(0.3 * tt) : 0)
    }
    const r = run(trimSweep({ deltaEq: true, lever: () => 0.8, hook: (cols, t) => ['thro1,engin', 'thro2,engin'].forEach((token) => (cols[token] = Float64Array.from(t, engin))) }))
    const p2 = pointCheck(r, 'P2', 'throttle-fixed')
    expect(p2.status).toBe('fail')
    expect(p2.measured).toMatch(/^lever range 0, throttle reaching the engines range 0\.1/)
    expect(pointOf(r, 'P2').status).toBe('excluded')
    expect(pointCheck(r, 'P3', 'throttle-fixed').status).toBe('pass')
    const method = setCheck(r, 'thrust-method')
    expect(method.status).toBe('warn')
    expect(method.measured).toMatch(/^power for level flight \(throttle reaching the engines 0\.4–0\.61\)$/)
  })

  it('throttle-fixed: N1 moving beside a still lever warns (an autothrottle or FADEC may have moved the power), and under an engaged autothrottle (row 117) beyond its pass band', () => {
    const hunting = (amplitude: number, atCode: boolean) =>
      run(trimSweep({
        deltaEq: true,
        lever: () => 0.8,
        hook: (cols, t, b) => {
          for (const token of ['N1__1,_pcnt', 'N1__2,_pcnt']) inRecord(cols, t, b[2], token, (tt, v) => v + amplitude * Math.sin(0.3 * (tt - b[2].recStart)))
          if (atCode) cols['_auto,throt'] = new Float64Array(t.length).fill(1)
        },
      }))
    // N1 range about 4 %pt at a still handle: warn, never fail (the setting decides the fail).
    const big = pointCheck(hunting(2, false), 'P2', 'throttle-fixed')
    expect(big.status).toBe('warn')
    expect(big.hint).toMatch(/^N1 moved with the lever still/)
    expect(big.measured).toMatch(/\(moved with the setting still\)$/)
    // About 1 %pt: inside N1's warn band, so it passes, unless the autothrottle is engaged.
    expect(pointCheck(hunting(0.5, false), 'P2', 'throttle-fixed').status).toBe('pass')
    const engaged = pointCheck(hunting(0.5, true), 'P2', 'throttle-fixed')
    expect(engaged.status).toBe('warn')
    expect(engaged.measured).toMatch(/^lever range 0; autothrottle engaged; /)
    expect(engaged.hint).toMatch(/^The autothrottle was engaged and the power moved/)
    expect(pointCheck(hunting(0.5, true), 'P3', 'throttle-fixed').status).toBe('pass')
  })

  it('throttle-fixed: an idle-only descent logged without a lever or N1 never fails on the force (it changes with height and crosses zero near idle); the thrust method is then unknown and the descents only noted', () => {
    // Thrust per engine at idle: +300 lb at 150 KEAS down to −25 lb at 280 KEAS, rising 0.3 lb/s in a 1500 fpm descent.
    const idleThrust = (blocks: Block[]) => (tt: number) => {
      const b = blocks[Math.min(7, Math.floor(tt / BLOCK))]
      return 300 - (2.5 * 130 * b.k) / 7 + 0.3 * (tt - b.recStart)
    }
    const r = run(trimSweep({
      deltaEq: true,
      vvi: () => -1500,
      drop: ['thro1,handl', 'thro2,handl', 'N1__1,_pcnt', 'N1__2,_pcnt'],
      hook: (cols, t, blocks) => ['thrst,_1,lb', 'thrst,_2,lb'].forEach((token) => (cols[token] = Float64Array.from(t, idleThrust(blocks)))),
    }))
    for (const name of ['P0', 'P7']) {
      const check = pointCheck(r, name, 'throttle-fixed')
      expect(check.status).toBe('warn')
      expect(check.measured).toMatch(/\(not level: it changes with height\)$/)
      expect(check.hint).toMatch(/log row 25 \(throttle\)/)
    }
    expect(pointCheck(r, 'P7', 'throttle-fixed').measured).toMatch(/judged against a quarter of the log’s largest force/)
    expect(r.points.every((p) => p.status === 'used')).toBe(true)
    expect(setCheck(r, 'thrust-method').status).toBe('not-checkable')
    // The descent is only noted (the thrust method is unknown), never warned as "not level in a level set".
    expect(pointCheck(r, 'P3', 'flight-path').status).toBe('info')
    expect(r.verdict.kind).toBe('acceptable')
  })

  it('thrust-method and flight-path: an idle descent sweep with N1 only (no lever or thrust) is not "power for level flight", so its descents are only noted (log row 25)', () => {
    const r = run(trimSweep({
      deltaEq: true,
      vvi: () => -1500,
      drop: ['thro1,handl', 'thro2,handl', 'thrst,_1,lb', 'thrst,_2,lb'],
      hook: (cols, t) => ['N1__1,_pcnt', 'N1__2,_pcnt'].forEach((token) => (cols[token] = Float64Array.from(t, (tt) => 25 + (0.05 * 130 * Math.min(7, Math.floor(tt / BLOCK))) / 7))),
    }))
    expect(setCheck(r, 'thrust-method').status).toBe('not-checkable')
    expect(setCheck(r, 'thrust-method').criterion).toMatch(/idle and re-set power look alike/)
    const path = pointCheck(r, 'P3', 'flight-path')
    expect(path.status).toBe('info')
    expect(path.hint).toMatch(/log row 25/)
    expect(r.notes.some((note) => /Steady flight path/.test(note))).toBe(false)
    expect(pointCheck(r, 'P3', 'throttle-fixed').status).toBe('pass')
    expect(pointCheck(r, 'P3', 'throttle-fixed').measured).toBe('N1 range 0.00 %pt')
  })

  it('configuration-match: configurations within the 0.01 tolerance are one, so a rounding edge (flaps 0.004 and 0.006) cannot make a tie', () => {
    const r = run(trimSweep({ deltaEq: true, flaps: (k) => (k < 4 ? 0.004 : 0.006) }))
    for (const p of r.points) expect(pointCheck(r, p.name, 'configuration-match').status).toBe('pass')
    expect(pointCheck(r, 'P0', 'configuration-match').measured).toBe('same as the set (clean: 0.00,0.00,0.00,0.00)')
    expect(r.verdict.kind).toBe('acceptable')
  })

  it('trim-fixed: a trim row empty inside a point is not checkable (Cannot confirm), not a moved trim', () => {
    const r = run(trimSweep({ deltaEq: true, hook: (cols, t, b) => inRecord(cols, t, b[2], '_trim,_elev', () => NaN) }))
    const check = pointCheck(r, 'P2', 'trim-fixed')
    expect(check.status).toBe('not-checkable')
    expect(check.criterion).toBe('Not checkable — the trim channel has no samples inside the point')
    expect(pointOf(r, 'P2').status).toBe('cannot-confirm')
    expect(r.verdict.text).not.toMatch(/re-cut/)
  })

  it('throttle-fixed and thrust-method read the legacy engine power (power,_k,hp) when nothing else is logged', () => {
    const r = run(trimSweep({
      deltaEq: true,
      drop: ['thro1,handl', 'thro2,handl', 'N1__1,_pcnt', 'N1__2,_pcnt', 'thrst,_1,lb', 'thrst,_2,lb'],
      hook: (cols, t) => ['power,_1,hp', 'power,_2,hp'].forEach((token) => (cols[token] = new Float64Array(t.length).fill(1500))),
    }))
    const check = pointCheck(r, 'P2', 'throttle-fixed')
    expect(check.status).toBe('pass')
    expect(check.measured).toMatch(/^power range 0\.0 % of its level$/)
    expect(setCheck(r, 'thrust-method').measured).toBe('constant power (engine power range 0.0 % (no lever row))')
  })

  it('tags each number by its source: sourced lines, judgement on every check, corrected citations and the thresholds table', () => {
    const def = (id: string) => {
      const found = STATIC_DEFS.find((x) => x.id === id)
      if (!found) throw new Error(id)
      return found
    }
    // judgement: at least one number in the check is engineering judgement or the app's own default
    for (const x of STATIC_DEFS) expect(x.judgement).toBe(true)
    expect(def('time-base').cite).toEqual(['App src/core/time.ts', 'App dictionary.ts line 26', 'FD12b p.19'])
    expect(def('time-base').why).toMatch(/max\(1 s, 20 × the median step\)\) and the preference for sim time are the app’s own choices/)
    expect(def('compressibility').sourced).toBe('warn at M 0.6: Cook p.360 (changes in stability and control may not become significant until M 0.6 or higher), p.363 (the compressibility change in pitching moment becomes significant at about M ≥ 0.6)')
    expect(def('compressibility').why).toMatch(/Only the optional M_MO − 0\.02 margin is engineering judgement/)
    expect(def('cl-range').sourced).toMatch(/^pass C_L ratio ≥ 1\.8: derived from MIL p\.40 \(speed-stability test: ±15 % or ±50 kt EAS about one trim speed, whichever is less/)
    expect(def('cg-lines').sourced).toMatch(/^pass ≥ 3 CG lines: Cook p\.48/)
    expect(def('cg-lines').why).not.toMatch(/only for slight/)
    expect(def('stabilised').sourced).toMatch(/^pass ≥ 60 s after the last power change: NATO 13-6, 13-7 \(climbs and level accelerations, borrowed\)$/)
    expect(def('sample-rate').cite).toEqual(expect.arrayContaining(['NATO 15-3', 'NATO 15-5', 'NATO 13-6']))
    expect(def('throttle-fixed').cite).toContain('MIL p.40')
    expect(def('throttle-fixed').cite).not.toContain('NATO 13-5')
    expect(def('trim-fixed').cite).toEqual(expect.arrayContaining(['Cook p.47', 'MIL p.40', 'FD10 slide 25']))
    expect(def('controls-fixed').cite).toContain('Cook p.46')
    expect(def('flight-path').cite).toEqual(expect.arrayContaining(['Cook p.63', 'Cook p.46', 'FD08 p.10', 'NATO 15-6']))
    expect(def('wings-level').why).not.toMatch(/propeller|only slightly|bands are wider/)
    expect(def('wings-level').cite).toContain('App src/core/analysis/steady.ts line 359')
    expect(def('envelope').cite).toEqual(expect.arrayContaining(['NATO 9-20', 'NATO 12-4']))
    expect(def('envelope').why).toMatch(/V_MO − 10 kt and M_MO − 0\.02 margins/)
    expect(def('weather').cite).toContain('NATO 13-9')
    expect(def('weather').why).not.toMatch(/turbulence adds scatter/)
    expect(def('near-stall').why).not.toMatch(/plot only|judged apart|level point drifts/i)
    expect(def('near-stall').cite).toEqual(expect.arrayContaining(['NATO 15-4', 'NATO 13-5', 'NATO 15-12']))
    // The V_S lines are NATO's numbers for other tests (borrowed); the rest is judgement.
    expect(def('near-stall').sourced).toMatch(/^warn < 1\.2 V_S: NATO 13-5 \(take-off safety speed V2\) and 15-12 \(one-g stalls started from trimmed level flight at 1\.2 to 1\.4 V_S\); info < 1\.3 V_S: NATO 13-5 \(usual approach speed\); both borrowed from other tests$/)
    expect(def('near-stall').why).toMatch(/Every other limit here is engineering judgement/)
    expect(def('near-stall').why).toMatch(/NATO tests the approach and landing configurations for the back side of the power curve/)
    // Wording the source review asked for: each claim as strong as its page.
    expect(def('flight-path').why).toMatch(/the lecture notes that its level-flight analysis extends easily to steady climbing flight/)
    expect(def('flight-path').why).toMatch(/The level band and the 200 fpm σ\(VVI\) line are the app’s steady-point defaults/)
    expect(def('speed-steady').why).toMatch(/the 2 kt change and 2σ warn lines are the app’s steady-point defaults/)
    expect(def('trim-fixed').why).toMatch(/the two are, to an extent, interchangeable means of trimming/)
    expect(def('weather').why).toMatch(/vertical air movement, horizontal wind or pressure gradients can bias the measured rate of climb/)
    expect(def('cl-range').why).toMatch(/barely adequate \(Cook, of the neutral-point plot\)/)
    expect(def('record-length').cite).toContain('NATO 13-10')
    expect(def('throttle-fixed').cite).toContain('App dictionary.ts line 266')
    expect(STATIC_OPEN.N3.question).toMatch(/the lectures note that CG can be changed in X-Plane 12/)
    expect(def('autopilot-record').cite).toContain('NATO 21-6')
    expect(def('pitch-augmentation').title).toBe('Pitch augmentation noted')
    expect(def('pitch-augmentation').cite).toContain('NATO 29-1')
    expect(def('trim-variable').cite).toEqual(expect.arrayContaining(['MIL p.40', 'MIL p.41']))
    expect(def('trim-variable').why).toMatch(/the verdict is Cannot confirm/)
    expect(def('cl-definition').why).toMatch(/3 % pass and 6 % fail bands \(engineering judgement\)/)
    expect(def('gradient').why).toMatch(/K_n = h_n − h/)
    expect(def('record-length').follows).toMatch(/performance example \(FD12c p\.16, not trim points\)/)
    // The open items' framing
    expect(STATIC_OPEN.N1.citations).toEqual(expect.arrayContaining(['FD05 p.15', 'NATO AG-300 v14 p.12A-8']))
    expect(STATIC_OPEN.N2.question).toMatch(/“Pay attention to longitudinal\/lateral requirements in the questions/)
    expect(STATIC_OPEN.N2.citations).toEqual(expect.arrayContaining(['Brief p.4', 'FD12b pp.25-28', 'FD12b p.35']))
    expect(STATIC_OPEN.N3.citations).toEqual(expect.arrayContaining(['FD12b p.28', 'FD10 s.32']))
    // The thresholds table's tags
    expect(TRIM_CHECK_THRESHOLDS.mach).toEqual({ value: 0.6, unit: '', source: 'Cook p.360, p.363', judgement: false })
    expect(TRIM_CHECK_THRESHOLDS.clRatio.judgement).toBe(false)
    expect(TRIM_CHECK_THRESHOLDS.clRatio.source).toMatch(/^derived from MIL p\.40/)
    for (const key of ['minRecordS', 'speedChangeKt', 'levelFpm', 'heightAglFt'] as const) expect(TRIM_CHECK_THRESHOLDS[key].judgement).toBe(true)
    expect(TRIM_CHECK_THRESHOLDS.sparseRateHz).toMatchObject({ value: 0.2, judgement: false })
    expect(TRIM_CHECK_THRESHOLDS.clRatio.source).toMatch(/±15 % or ±50 kt EAS about one trim speed, whichever is less/)
    expect(TRIM_CHECK_THRESHOLDS.vsWarn).toMatchObject({ value: 1.2, judgement: false })
    expect(TRIM_CHECK_THRESHOLDS.vsInfo).toMatchObject({ value: 1.3, judgement: false })
    expect(TRIM_CHECK_THRESHOLDS.cgLines).toMatchObject({ value: 3, judgement: false })
    // A check carries its sourced line into the CSV.
    const csv = checklistCsv(setReportRows(run(trimSweep({ deltaEq: true }))))
    expect(csv).toContain('NATO 13-6’s recording rate for classical climbs')
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
