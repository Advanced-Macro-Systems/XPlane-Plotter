import { describe, expect, it } from 'vitest'
import { evalPoly, polyFit, type PolyFit } from './fit'
import {
  MODEL_POWERS,
  PHYSICAL_RATIO,
  RE_MARGIN,
  RE_SIGNIFICANCE,
  physicalFit,
  physicalProblem,
  physicalRangeEndurance,
  physicalValue,
  polyRangeEndurance,
  searchWindow,
  type PhysicalModel,
} from './rangeEndurance'

// Synthetic curves only (no flight data): a power-required curve P = A·V³ + B/V and a drag curve D = A·V² + B/V².
const SPEEDS = [60, 70, 80, 90, 100, 110, 120]
const A_POWER = 5e-5
const B_POWER = 3000
const A_DRAG = 0.04
const B_DRAG = 1.6e6

function curve(model: PhysicalModel, a: number, b: number, speeds = SPEEDS): number[] {
  return speeds.map((v) => physicalValue({ model, a, b }, v))
}

/** A fixed, zero-mean "noise" pattern scaled to `size`. */
function noise(n: number, size: number): number[] {
  return Array.from({ length: n }, (_, i) => size * Math.sin(1.7 * i + 0.3) * (i % 2 ? 1 : -1))
}

/** Least squares for y ≈ A·V^p + B·V^q by the 2×2 normal equations (an independent check of the QR solution). */
function normalEquations(v: number[], y: number[], model: PhysicalModel, w = v.map(() => 1)) {
  const [p, q] = MODEL_POWERS[model]
  let s11 = 0
  let s12 = 0
  let s22 = 0
  let t1 = 0
  let t2 = 0
  v.forEach((vi, i) => {
    const x1 = vi ** p
    const x2 = vi ** q
    s11 += w[i] * x1 * x1
    s12 += w[i] * x1 * x2
    s22 += w[i] * x2 * x2
    t1 += w[i] * x1 * y[i]
    t2 += w[i] * x2 * y[i]
  })
  const det = s11 * s22 - s12 * s12
  const a = (s22 * t1 - s12 * t2) / det
  const b = (s11 * t2 - s12 * t1) / det
  let ssr = 0
  v.forEach((vi, i) => {
    const r = y[i] - (a * vi ** p + b * vi ** q)
    ssr += w[i] * r * r
  })
  const s2 = ssr / (v.length - 2)
  return { a, b, aSe: Math.sqrt((s2 * s22) / det), bSe: Math.sqrt((s2 * s11) / det), ssr }
}

const rel = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected)

describe('physicalFit', () => {
  it('recovers A and B of an exact power curve, with R² = 1 and tiny errors', () => {
    const fit = physicalFit(SPEEDS, curve('power', A_POWER, B_POWER), 'power')
    expect(fit).not.toBeNull()
    expect(rel(fit!.a, A_POWER)).toBeLessThan(1e-12)
    expect(rel(fit!.b, B_POWER)).toBeLessThan(1e-12)
    expect(fit!.r2).toBeCloseTo(1, 12)
    expect(fit!.rmse).toBeLessThan(1e-10)
    expect(fit!.aSe).toBeLessThan(1e-12 * A_POWER)
    expect(fit).toMatchObject({ model: 'power', n: 7, xMin: 60, xMax: 120 })
  })

  it('recovers A and B of an exact drag curve', () => {
    const fit = physicalFit(SPEEDS, curve('drag', A_DRAG, B_DRAG), 'drag')
    expect(rel(fit!.a, A_DRAG)).toBeLessThan(1e-12)
    expect(rel(fit!.b, B_DRAG)).toBeLessThan(1e-12)
  })

  it('matches the normal-equation solution and its standard errors with noisy points', () => {
    for (const model of ['power', 'drag'] as const) {
      const [a, b] = model === 'power' ? [A_POWER, B_POWER] : [A_DRAG, B_DRAG]
      const clean = curve(model, a, b)
      const y = clean.map((v, i) => v + noise(SPEEDS.length, 0.02 * v)[i])
      const fit = physicalFit(SPEEDS, y, model)!
      const ref = normalEquations(SPEEDS, y, model)
      expect(rel(fit.a, ref.a)).toBeLessThan(1e-9)
      expect(rel(fit.b, ref.b)).toBeLessThan(1e-9)
      expect(rel(fit.aSe, ref.aSe)).toBeLessThan(1e-7)
      expect(rel(fit.bSe, ref.bSe)).toBeLessThan(1e-7)
      const mean = y.reduce((s, v) => s + v, 0) / y.length
      const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0)
      expect(fit.r2).toBeCloseTo(1 - ref.ssr / sst, 10)
      expect(fit.rmse).toBeCloseTo(Math.sqrt(ref.ssr / y.length), 10)
      expect(fit.r2).toBeGreaterThan(0.9)
      expect(fit.r2).toBeLessThan(1)
    }
  })

  it('skips missing values and speeds that are not positive, and needs two distinct speeds', () => {
    const y = curve('power', A_POWER, B_POWER)
    const fit = physicalFit([...SPEEDS, 0, -10, NaN, 80], [...y, 5, 5, 5, NaN], 'power')!
    expect(fit.n).toBe(7)
    expect(rel(fit.a, A_POWER)).toBeLessThan(1e-12)
    expect(physicalFit([80, 80, 80], [1, 2, 3], 'power')).toBeNull()
    expect(physicalFit([80], [1], 'drag')).toBeNull()
    expect(physicalFit([], [], 'drag')).toBeNull()
    expect(physicalFit([-1, -2, 0], [1, 2, 3], 'power')).toBeNull()
  })

  it('has no standard errors from two points (an exact solve) and no R² for a constant y', () => {
    const two = physicalFit([70, 110], curve('power', A_POWER, B_POWER, [70, 110]), 'power')!
    expect(two.n).toBe(2)
    expect(rel(two.a, A_POWER)).toBeLessThan(1e-12)
    expect(two.aSe).toBeNaN()
    expect(two.bSe).toBeNaN()
    expect(physicalFit(SPEEDS, SPEEDS.map(() => 4), 'drag')!.r2).toBeNaN()
  })

  it('weights points: a weight of 2 counts like the point twice', () => {
    const y = curve('drag', A_DRAG, B_DRAG).map((v, i) => v * (1 + 0.03 * Math.cos(i)))
    const weighted = physicalFit(SPEEDS, y, 'drag', [2, 1, 1, 1, 1, 1, 1])!
    const doubled = physicalFit([60, ...SPEEDS], [y[0], ...y], 'drag')!
    expect(rel(weighted.a, doubled.a)).toBeLessThan(1e-10)
    expect(rel(weighted.b, doubled.b)).toBeLessThan(1e-10)
    expect(weighted.rmse).toBeCloseTo(doubled.rmse, 10)
    // Scaling every weight changes nothing.
    const scaled = physicalFit(SPEEDS, y, 'drag', [20, 10, 10, 10, 10, 10, 10])!
    expect(rel(scaled.a, weighted.a)).toBeLessThan(1e-12)
    expect(rel(scaled.aSe, weighted.aSe)).toBeLessThan(1e-9)
    // Points with a weight of 0 (or a missing weight) are left out.
    expect(physicalFit(SPEEDS, y, 'drag', [0, 1, 1, 1, 1, 1, NaN])!.n).toBe(5)
  })

  it('stays accurate in any speed unit (the columns are scaled)', () => {
    // The same curve with V in units k times larger: A' = A/k³, B' = B·k.
    for (const k of [0.01, 1, 1000]) {
      const speeds = SPEEDS.map((v) => v * k)
      const fit = physicalFit(speeds, curve('power', A_POWER, B_POWER), 'power')!
      expect(rel(fit.a, A_POWER / k ** 3)).toBeLessThan(1e-12)
      expect(rel(fit.b, B_POWER * k)).toBeLessThan(1e-12)
    }
  })
})

describe('physicalRangeEndurance', () => {
  it('power model: V_E = (B/3A)^¼ (least power), V_R = (B/A)^¼ (least power per speed)', () => {
    const fit = physicalFit(SPEEDS, curve('power', A_POWER, B_POWER), 'power')!
    const re = physicalRangeEndurance(fit)
    const vE = (B_POWER / (3 * A_POWER)) ** 0.25
    const vR = (B_POWER / A_POWER) ** 0.25
    expect(rel(re.endurance!.v, vE)).toBeLessThan(1e-12)
    expect(rel(re.range!.v, vR)).toBeLessThan(1e-12)
    expect(re.endurance!.y).toBeCloseTo(physicalValue(fit, vE), 9)
    expect(re.range!.y).toBeCloseTo(physicalValue(fit, vR), 9)
    expect(re.slope).toBeCloseTo(re.range!.y / re.range!.v, 12)
    expect(re.ratio).toBeCloseTo(PHYSICAL_RATIO, 12)
    expect(PHYSICAL_RATIO).toBeCloseTo(1.316074, 6)
    expect(re.enduranceNote).toBe('')
    expect(re.rangeNote).toBe('')
    expect(re.endurance!.extrapolated).toBe(false)
    expect(re.range!.extrapolated).toBe(false)
  })

  it('drag model: V_E = (B/A)^¼ (least drag), V_R = (3B/A)^¼ (least drag per speed)', () => {
    const fit = physicalFit(SPEEDS, curve('drag', A_DRAG, B_DRAG), 'drag')!
    const re = physicalRangeEndurance(fit)
    expect(rel(re.endurance!.v, (B_DRAG / A_DRAG) ** 0.25)).toBeLessThan(1e-12)
    expect(rel(re.range!.v, ((3 * B_DRAG) / A_DRAG) ** 0.25)).toBeLessThan(1e-12)
    expect(re.ratio).toBeCloseTo(PHYSICAL_RATIO, 12)
  })

  it('finds the true minimum and the true tangent from the origin (checked on a dense grid)', () => {
    for (const model of ['power', 'drag'] as const) {
      const [a, b] = model === 'power' ? [A_POWER, B_POWER] : [A_DRAG, B_DRAG]
      const fit = physicalFit(SPEEDS, curve(model, a, b), model)!
      const re = physicalRangeEndurance(fit)
      for (let v = 30; v <= 200; v += 0.01) {
        const y = physicalValue(fit, v)
        expect(y).toBeGreaterThanOrEqual(re.endurance!.y - 1e-9 * Math.abs(re.endurance!.y))
        // The tangent line y = slope·V never lies above the curve: it only touches it at V_R.
        expect(y).toBeGreaterThanOrEqual(re.slope * v - 1e-9 * Math.abs(y))
      }
    }
  })

  it('flags points outside the fitted speeds as extrapolated', () => {
    // The slowest point (72) is faster than the minimum-power speed (66.9); the tangent point (88) is inside.
    const speeds = [72, 85, 100, 120]
    const re = physicalRangeEndurance(physicalFit(speeds, curve('power', A_POWER, B_POWER, speeds), 'power')!)
    expect(re.endurance!.v).toBeCloseTo(66.874, 3)
    expect(re.endurance!.extrapolated).toBe(true)
    expect(re.range!.extrapolated).toBe(false)
  })

  it('reports no minimum when A or B is not positive', () => {
    // B < 0: the curve keeps rising.
    const re = physicalRangeEndurance(physicalFit(SPEEDS, curve('power', 1e-4, -1000), 'power')!)
    expect(re.endurance).toBeNull()
    expect(re.range).toBeNull()
    expect(re.enduranceNote).toMatch(/^No minimum: A·V³ \+ B\/V has one only when A and B are both positive/)
    expect(re.rangeNote).toBe(re.enduranceNote)
    expect(re.slope).toBeNaN()
    expect(re.ratio).toBeNaN()
    // A < 0: the curve keeps falling.
    const falling = physicalRangeEndurance(physicalFit(SPEEDS, curve('drag', -0.01, 1e6), 'drag')!)
    expect(falling.endurance).toBeNull()
    expect(falling.enduranceNote).toContain('A·V² + B/V²')
  })

  it('gives no speeds from a fit that does not explain the points or whose A or B could be zero', () => {
    // A fit through a whole log: idle thrust while taxiing near V = 0, take-off thrust on the runway, then cruise. The
    // drag model cannot follow that: R² ends up below zero, and its "minimum" would be at a fraction of a knot.
    const speeds = [0.02, 5, 20, 40, 60, 80, 100, 250, 260, 270, 280]
    const y = [500, 30000, 30000, 30000, 30000, 30000, 30000, 8000, 8500, 9000, 9600]
    const whole = physicalFit(speeds, y, 'drag')!
    expect(whole.a).toBeGreaterThan(0)
    expect(whole.b).toBeGreaterThan(0)
    expect(whole.r2).toBeLessThan(0)
    const bad = physicalRangeEndurance(whole)
    expect(bad.endurance).toBeNull()
    expect(bad.range).toBeNull()
    expect(bad.enduranceNote).toMatch(/^No minimum: the model does not fit these points \(R² = −\d\.\d{3}\)/)
    expect(bad.rangeNote).toBe(bad.enduranceNote)
    expect(physicalProblem(whole)).toBe(bad.enduranceNote)
    // B within two standard errors of zero: noisy points far above the minimum-power speed.
    const fast = [150, 160, 170, 180, 190, 200]
    const noisy = curve('power', A_POWER, 200, fast).map((v, i) => v + noise(fast.length, 0.03 * v)[i])
    const weak = physicalFit(fast, noisy, 'power')!
    expect(weak.b).toBeLessThan(2 * weak.bSe)
    const weakRe = physicalRangeEndurance(weak)
    expect(weakRe.endurance).toBeNull()
    expect(weakRe.enduranceNote).toMatch(/^No minimum: B is within two standard errors of zero \(A = .+ ± .+, B = .+ ± .+\)/)
    // y that does not vary: no curve at all.
    const flat = physicalFit(SPEEDS, SPEEDS.map(() => 40), 'power')!
    expect(physicalRangeEndurance(flat).enduranceNote).toMatch(/^No minimum: y does not vary/)
    // A good fit passes, and two points (no standard errors) count by their signs alone.
    expect(physicalProblem(physicalFit(SPEEDS, curve('power', A_POWER, B_POWER), 'power')!)).toBe('')
    expect(physicalProblem(physicalFit([70, 110], curve('power', A_POWER, B_POWER, [70, 110]), 'power')!)).toBe('')
    expect(RE_SIGNIFICANCE).toBe(2)
  })

  it('does not report a point far outside the test points, but says where it would be', () => {
    // Points from 100 to 110: the window is 95 to 115, and the minimum is near 67.
    const speeds = [100, 105, 110]
    const re = physicalRangeEndurance(physicalFit(speeds, curve('power', A_POWER, B_POWER, speeds), 'power')!)
    expect(re.endurance).toBeNull()
    expect(re.enduranceNote).toMatch(/^The minimum would be at V = 66\.87, far outside the test points \(100 to 110\)/)
    expect(re.range).toBeNull()
    expect(re.rangeNote).toMatch(/^The tangent point would be at V = 88\.01/)
    expect(re.window).toEqual([95, 115])
  })
})

describe('searchWindow', () => {
  it('widens the fitted range by half its span on each side, never down to zero', () => {
    expect(RE_MARGIN).toBe(0.5)
    expect(searchWindow(60, 120)).toEqual([30, 150])
    expect(searchWindow(10, 110)).toEqual([1, 160])
    expect(searchWindow(-5, 100)).toEqual([0.1, 152.5])
    expect(searchWindow(-5, 0)).toBeNull()
    expect(searchWindow(NaN, 10)).toBeNull()
    expect(searchWindow(5, 5)).toEqual([5, 5])
  })
})

function poly(coeffs: number[], xMin = 60, xMax = 120): PolyFit {
  return { degree: coeffs.length - 1, coeffs, stderr: coeffs.map(() => NaN), r2: 1, rmse: 0, n: 6, xMin, xMax }
}

describe('polyRangeEndurance', () => {
  it('quadratic: the vertex −c1/2c2 and the tangent point √(c0/c2), to full precision', () => {
    const c = [400, -6, 0.04]
    const re = polyRangeEndurance(poly(c))
    expect(rel(re.endurance!.v, 75)).toBeLessThan(1e-14)
    expect(re.endurance!.y).toBeCloseTo(evalPoly(c, 75), 10)
    expect(rel(re.range!.v, 100)).toBeLessThan(1e-14)
    expect(re.range!.y).toBeCloseTo(evalPoly(c, 100), 10)
    expect(re.slope).toBeCloseTo(evalPoly(c, 100) / 100, 12)
    expect(re.ratio).toBeCloseTo(100 / 75, 12)
    expect(re.endurance!.extrapolated).toBe(false)
  })

  it('cubic: f′(V_E) = 0 and V·f′ − f = 0 at V_R, and they are the minimum and the tangent', () => {
    const c = [300, -5, 0.03, 2e-5]
    const re = polyRangeEndurance(poly(c))
    const fPrime = (v: number) => c[1] + 2 * c[2] * v + 3 * c[3] * v * v
    // Closed form of the cubic's minimum: the larger root of f′ = 0.
    const vE = (-2 * c[2] + Math.sqrt(4 * c[2] ** 2 - 12 * c[3] * c[1])) / (6 * c[3])
    expect(rel(re.endurance!.v, vE)).toBeLessThan(1e-13)
    expect(Math.abs(fPrime(re.endurance!.v))).toBeLessThan(1e-12)
    const vR = re.range!.v
    expect(Math.abs(vR * fPrime(vR) - evalPoly(c, vR))).toBeLessThan(1e-9)
    for (let v = 30; v <= 150; v += 0.01) {
      expect(evalPoly(c, v) / v).toBeGreaterThanOrEqual(re.slope - 1e-12)
    }
  })

  it('agrees with the closed forms when the polynomial is fitted to a physical curve', () => {
    const speeds = Array.from({ length: 13 }, (_, i) => 60 + 5 * i)
    const fit = polyFit(speeds, curve('power', A_POWER, B_POWER, speeds), 3)!
    const re = polyRangeEndurance(fit)
    // A cubic cannot be the A·V³ + B/V curve exactly, but over 60–120 it is close.
    expect(rel(re.endurance!.v, (B_POWER / (3 * A_POWER)) ** 0.25)).toBeLessThan(0.01)
    expect(rel(re.range!.v, (B_POWER / A_POWER) ** 0.25)).toBeLessThan(0.01)
  })

  it('finds none for a straight line, a curve that keeps falling, or a maximum', () => {
    const line = polyRangeEndurance(poly([10, 2]))
    expect(line.endurance).toBeNull()
    expect(line.range).toBeNull()
    expect(line.enduranceNote).toMatch(/^A straight line has neither a minimum nor a tangent/)
    expect(polyRangeEndurance(poly([1, 2, 0, 0])).enduranceNote).toMatch(/straight line/)
    // Falling all the way across the window (vertex at 200, beyond 150).
    const falling = polyRangeEndurance(poly([500, -4, 0.01]))
    expect(falling.endurance).toBeNull()
    expect(falling.enduranceNote).toBe('No minimum between 30 and 150: the fitted curve keeps falling or rising there.')
    // Opening downwards: a maximum, no minimum, and f/V keeps falling.
    const cap = polyRangeEndurance(poly([10, 4, -0.02]))
    expect(cap.endurance).toBeNull()
    expect(cap.range).toBeNull()
    expect(cap.rangeNote).toBe('No tangent from the origin touches the fitted curve between 30 and 150.')
  })

  it('needs the curve to be positive where the tangent touches', () => {
    // f = −400 + 0.04 V²: f/V = −400/V + 0.04V rises everywhere, so no interior minimum of f/V either.
    expect(polyRangeEndurance(poly([-400, 0, 0.04])).range).toBeNull()
    // f = 400 − 30 V + 0.04 V² … negative between its roots; its tangent point √(c0/c2) = 100 has f < 0.
    const dip = polyRangeEndurance(poly([400, -30, 0.04]))
    expect(dip.range).toBeNull()
    expect(dip.rangeNote).toBe('The tangent from the origin would touch the curve where it is not positive.')
  })

  it('flags an extrapolated minimum and keeps to the window', () => {
    // Vertex at 50: below the slowest fitted speed 60, inside the window from 30.
    const re = polyRangeEndurance(poly([400, -4, 0.04]))
    expect(re.endurance!.v).toBeCloseTo(50, 12)
    expect(re.endurance!.extrapolated).toBe(true)
    // Vertex at 25: outside the window (30 to 150).
    expect(polyRangeEndurance(poly([400, -2, 0.04])).endurance).toBeNull()
  })

  it('moves with a constant scale on V: KIAS or KEAS at one altitude give the same flight conditions', () => {
    const k = 0.92
    const speeds = [60, 72, 84, 96, 108, 120, 132]
    const y = speeds.map((v, i) => A_POWER * v ** 3 + B_POWER / v + noise(speeds.length, 0.5)[i])
    const scaled = speeds.map((v) => v * k)
    for (const model of ['power', 'drag'] as const) {
      const re = physicalRangeEndurance(physicalFit(speeds, y, model)!)
      const reScaled = physicalRangeEndurance(physicalFit(scaled, y, model)!)
      expect(rel(reScaled.endurance!.v, k * re.endurance!.v)).toBeLessThan(1e-10)
      expect(rel(reScaled.range!.v, k * re.range!.v)).toBeLessThan(1e-10)
      expect(rel(reScaled.endurance!.y, re.endurance!.y)).toBeLessThan(1e-10)
    }
    const re = polyRangeEndurance(polyFit(speeds, y, 2)!)
    const reScaled = polyRangeEndurance(polyFit(scaled, y, 2)!)
    expect(rel(reScaled.endurance!.v, k * re.endurance!.v)).toBeLessThan(1e-10)
    expect(rel(reScaled.range!.v, k * re.range!.v)).toBeLessThan(1e-10)
  })

  it('needs positive speeds', () => {
    const re = polyRangeEndurance(poly([1, 2, 3], -20, -10))
    expect(re.endurance).toBeNull()
    expect(re.window).toBeNull()
    expect(re.enduranceNote).toBe('Needs test points at positive speeds.')
  })
})
