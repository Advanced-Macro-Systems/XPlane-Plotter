// International Standard Atmosphere (troposphere) and airspeed conversions for the synthetic demo flight.
// Imperial units, like the X-Plane log: feet, ft/s, slug/ft³, lbf/ft².

/** Standard gravity, ft/s² */
export const G0 = 32.174
/** ft/s per knot */
export const FPS_PER_KT = 1.6878098571011957
/** metres per foot */
export const M_PER_FT = 0.3048

const T0_K = 288.15
const P0 = 2116.2166 // sea-level pressure, lbf/ft²
const RHO0 = 0.0023769 // sea-level density, slug/ft³
const A0 = 1116.4505 // sea-level speed of sound, ft/s (661.48 kt)
const LAPSE_K_PER_FT = 0.0019812 // 6.5 K/km
const TROPOPAUSE_FT = 36089

export interface AirState {
  /** Temperature ratio T/T0 */
  theta: number
  /** Pressure ratio p/p0 */
  delta: number
  /** Density ratio ρ/ρ0 */
  sigma: number
  /** Density, slug/ft³ */
  rho: number
  /** Static pressure, lbf/ft² */
  p: number
  /** Speed of sound, ft/s */
  a: number
}

export function newAirState(): AirState {
  return { theta: 1, delta: 1, sigma: 1, rho: RHO0, p: P0, a: A0 }
}

/** ISA at pressure altitude `hFt`, written into `out` (the simulation calls this every step, so no allocation). */
export function isaInto(hFt: number, out: AirState): AirState {
  const h = Math.min(hFt, TROPOPAUSE_FT)
  const theta = 1 - (LAPSE_K_PER_FT * h) / T0_K
  const delta = Math.pow(theta, 5.25588)
  out.theta = theta
  out.delta = delta
  out.sigma = delta / theta
  out.rho = RHO0 * out.sigma
  out.p = P0 * delta
  out.a = A0 * Math.sqrt(theta)
  return out
}

/** Equivalent airspeed (any speed unit) for a true airspeed: EAS = TAS·√σ. */
export function easFromTas(tas: number, air: AirState): number {
  return tas * Math.sqrt(air.sigma)
}

/**
 * Calibrated airspeed (ft/s) for a true airspeed (ft/s), from the subsonic compressible pitot equation: the impact
 * pressure qc = p·[(1 + 0.2M²)^3.5 − 1] is converted back to a speed with sea-level p0 and a0.
 */
export function casFromTas(tas: number, air: AirState): number {
  const m = tas / air.a
  const qc = air.p * (Math.pow(1 + 0.2 * m * m, 3.5) - 1)
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1))
}

/** True airspeed (ft/s) for a calibrated airspeed (ft/s): the inverse of casFromTas. */
export function tasFromCas(cas: number, air: AirState): number {
  const mc = cas / A0
  const qc = P0 * (Math.pow(1 + 0.2 * mc * mc, 3.5) - 1)
  const m = Math.sqrt(5 * (Math.pow(qc / air.p + 1, 2 / 7) - 1))
  return m * air.a
}
