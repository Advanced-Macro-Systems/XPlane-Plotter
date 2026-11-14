// The synthetic aircraft behind the demo flight: a generic twin-engine narrow-body with 737-class numbers (not any real
// type's data), and the dynamic-mode parameters injected into the flight. Imperial units, like the X-Plane log.

export const DEMO_AIRCRAFT = {
  /** Reference wing area S (ft²), also logged as "S-ref,ft*ft" */
  wingAreaFt2: 1341,
  emptyWeightLb: 91_300,
  payloadLb: 33_200,
  initialFuelLb: 22_450,
  /** CG position (ft from the reference datum) at the start; it creeps aft as fuel burns */
  cgStartFt: 0.84,
  cgShiftFtPerLbBurnt: 1.2e-5,
  /** Clean parabolic drag polar: CD = cd0 + k·CL² */
  cd0: 0.0215,
  k: 0.0445,
  /** Lift curve CL = cl0 + clAlpha·α (α in rad) with Prandtl–Glauert compressibility: clAlpha = clAlpha0 / √(1 − M²) */
  cl0: 0.25,
  clAlpha0PerRad: 4.4,
  /** Drag coefficient added by the speedbrake, per unit of deployment (0..1) */
  cdSpeedbrake: 0.026,
  /** Flaps, per unit of flap ratio (flaps 1 = 0.125): lift at zero α and extra drag */
  clFlap: 0.9,
  cdFlap: 0.045,
  /**
   * Elevator angle to trim (deg, trailing edge down positive) = elevatorTrim0Deg + elevatorTrimSlopeDegPerCl · CL.
   * The negative slope is static stability: more trailing-edge-up elevator the slower (higher CL) the aircraft flies.
   */
  elevatorTrim0Deg: 1.4,
  elevatorTrimSlopeDegPerCl: -4.2,
  /** Side-force coefficient per rad of sideslip (standard sign) and per unit of rudder (ratio, + = yaw right) */
  cyBeta: -0.85,
  cyRudder: -0.12,
  /** Surface travel used to convert ratios to degrees */
  elevatorDegPerRatio: 21,
  aileronDegPerRatio: 18,
  rudderDegPerRatio: 29,
  /** Elevator angle that one unit of elevator trim holds (deg, trailing edge up) */
  trimDegPerRatio: 8,
  /** Engines (each): sea-level static thrust, spool-up time constant, thrust-specific fuel consumption */
  engineStaticThrustLb: 27_300,
  engineIdleThrustSlsLb: 1_350,
  engineTimeConstantS: 1.4,
  /** TSFC (lb/h per lbf) = tsfc0 + tsfcPerMach · M */
  tsfc0: 0.5,
  tsfcPerMach: 0.2,
  /** N1 at flight idle (sea level) and at maximum thrust, % */
  n1IdlePct: 29,
  n1MaxPct: 97.5,
} as const

/** Injected dynamic-mode parameters. Periods are damped periods (2π/ωd); ζ is the damping ratio. */
export const DEMO_MODES = {
  shortPeriod: { periodS: 3.4, zeta: 0.5 },
  phugoid: { periodS: 58, zeta: 0.06 },
  dutchRoll: { periodS: 5.6, zeta: 0.15 },
  rollSubsidence: { tauS: 0.7 },
} as const

/** Undamped natural frequency ωn (rad/s) of a mode with damped period `periodS` and damping ratio `zeta`. */
export function naturalFrequency(mode: { periodS: number; zeta: number }): number {
  return (2 * Math.PI) / mode.periodS / Math.sqrt(1 - mode.zeta * mode.zeta)
}

/** Per-engine thrust limits (lbf) at pressure ratio δ and Mach M: a simple turbofan lapse. */
export function maxThrustLb(delta: number, mach: number): number {
  return DEMO_AIRCRAFT.engineStaticThrustLb * Math.pow(delta, 0.85) * (1 - 0.32 * mach)
}

export function idleThrustLb(delta: number, mach: number): number {
  return DEMO_AIRCRAFT.engineIdleThrustSlsLb * delta * (1 - 0.5 * mach)
}

/** N1 (%) for a per-engine thrust: grows with the square-root-like fraction of the available thrust range. */
export function n1ForThrust(thrustLb: number, delta: number, mach: number): number {
  const idle = idleThrustLb(delta, mach)
  const span = maxThrustLb(delta, mach) - idle
  const fraction = Math.min(1, Math.max(0, (thrustLb - idle) / span))
  const n1Idle = n1IdleAt(delta)
  return n1Idle + (DEMO_AIRCRAFT.n1MaxPct - n1Idle) * Math.pow(fraction, 0.6)
}

/** Throttle handle ratio (0 idle .. 1 full) that commands a given N1. */
export function throttleForN1(n1Pct: number, delta: number): number {
  const n1Idle = n1IdleAt(delta)
  const fraction = Math.min(1, Math.max(0, (n1Pct - n1Idle) / (DEMO_AIRCRAFT.n1MaxPct - n1Idle)))
  return Math.pow(fraction, 1.15)
}

function n1IdleAt(delta: number): number {
  // flight idle runs a little faster at altitude
  return DEMO_AIRCRAFT.n1IdlePct + 6 * (1 - delta)
}
