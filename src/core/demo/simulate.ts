// The demo flight's physics.
//
// A point-mass "base" trajectory is flown by a simple pilot model (speed held with thrust, idle + speedbrake to slow
// down, the planned descent and turn). On top of it ride linear modal perturbation models whose eigenvalues are the
// injected DEMO_MODES, so the published periods and damping ratios can be recovered from the log:
//   - short period: α perturbation, driven by the elevator and vertical gusts (2nd order),
//   - phugoid: speed and flight-path perturbations (2nd order), driven by the short period's lift and by thrust,
//   - dutch roll: sideslip (2nd order), driven by rudder, differential thrust, adverse yaw and lateral gusts,
//   - roll subsidence: roll rate (1st order), driven by the ailerons and the dihedral effect.
// The states are integrated with RK4 on a grid of at most 50 ms, and every X-Plane channel is then derived from them
// with consistent kinematics and aerodynamics: ISA air data (KIAS from the compressible pitot equation), CL = n·W/(q·S),
// α from the lift curve, a parabolic drag polar, Euler angles from the wind angles, body rates from Euler rates,
// position integrated from track and ground speed (with a steady wind), fuel burnt at TSFC × thrust.

import {
  DEMO_AIRCRAFT as AC,
  DEMO_MODES,
  idleThrustLb,
  maxThrustLb,
  n1ForThrust,
  naturalFrequency,
  throttleForN1,
} from './aircraft'
import { FPS_PER_KT, G0, M_PER_FT, casFromTas, easFromTas, isaInto, newAirState, tasFromCas, type AirState } from './atmosphere'
import { createGaussian, createMarkov, createRng, streamSeed } from './random'
import * as card from './scenario'

/** The demo log as numbers: header tokens in file order and one column of `rowCount` values per token. */
export interface DemoTable {
  tokens: string[]
  columns: Float64Array[]
  rowCount: number
}

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

// ------------------------------------------------------------------ columns (real X-Plane 12 tokens, in X-Plane's order)

const COLUMNS = [
  ['realTime', '_real,_time'],
  ['totalTime', '_totl,_time'],
  ['missionTime', 'missn,_time'],
  ['zuluTime', '_zulu,_time'],
  ['localTime', 'local,_time'],
  ['hobbsTime', 'hobbs,_time'],
  ['kias', '_Vind,_kias'],
  ['keas', '_Vind,_keas'],
  ['ktas', 'Vtrue,_ktas'],
  ['ktgs', 'Vtrue,_ktgs'],
  ['mach', '_Mach,ratio'],
  ['vvi', '__VVI,__fpm'],
  ['totalEnergy', 'toten,vario'],
  ['nz', 'Gload,norml'],
  ['nx', 'Gload,axial'],
  ['ny', 'Gload,_side'],
  ['alpha', 'alpha,__deg'],
  ['beta', '_beta,__deg'],
  ['hpath', 'hpath,_true'],
  ['vpath', 'vpath,__deg'],
  ['slip', '_slip,__deg'],
  ['pitch', 'pitch,__deg'],
  ['roll', '_roll,__deg'],
  ['headingTrue', 'hding,_true'],
  ['headingMag', 'hding,__mag'],
  ['magVar', 'mavar,__deg'],
  ['lat', '__lat,__deg'],
  ['lon', '__lon,__deg'],
  ['altCg', '___CG,ftMSL'],
  ['altGear', '_gear,ftagl'],
  ['terrain', 'terrn,ftMSL'],
  ['altPressure', 'p-alt,ftMSL'],
  ['x', '____X,____m'],
  ['y', '____Y,____m'],
  ['z', '____Z,____m'],
  ['vx', '___vX,__m/s'],
  ['vy', '___vY,__m/s'],
  ['vz', '___vZ,__m/s'],
  ['distFt', '_dist,___ft'],
  ['distNm', '_dist,___nm'],
  ['pDot', '_Pdot,_d/ss'],
  ['qDot', '_Qdot,_d/ss'],
  ['rDot', '_Rdot,_d/ss'],
  ['p', '____P,deg/s'],
  ['q', '____Q,deg/s'],
  ['r', '____R,deg/s'],
  ['emptyWeight', 'empty,___lb'],
  ['payload', 'payld,___lb'],
  ['fuel', '_fuel,___lb'],
  ['totalWeight', 'total,___lb'],
  ['cg', '___cg,ftref'],
  ['elevStick', '_elev,stick'],
  ['ailStick', 'ailrn,stick'],
  ['rudStick', 'ruddr,stick'],
  ['elevSurf', '_elev,_surf'],
  ['ailSurf', 'ailrn,_surf'],
  ['rudSurf', 'ruddr,_surf'],
  ['elevTrim', '_trim,_elev'],
  ['flapHandle', '_flap,handl'],
  ['flapPos', '_flap,postn'],
  ['sbHandle', 'sbrak,handl'],
  ['sbPos', 'sbrak,postn'],
  ['throttle1', 'thro1,handl'],
  ['throttle2', 'thro2,handl'],
  ['n1Left', 'N1__1,_pcnt'],
  ['n1Right', 'N1__2,_pcnt'],
  ['ffLeft', 'FF__1,_lb/h'],
  ['ffRight', 'FF__2,_lb/h'],
  ['powerLeft', 'engn1,___hp'],
  ['powerRight', 'engn2,___hp'],
  ['thrustLeft', 'thrst,_1,lb'],
  ['thrustRight', 'thrst,_2,lb'],
  ['aileronLeft', 'Lailn,1,deg'],
  ['aileronRight', 'Railn,1,deg'],
  // X-Plane logs the left and right elevator under the same token
  ['elevatorLeft', 'elev1,__deg'],
  ['elevatorRight', 'elev1,__deg'],
  ['rudder', 'rudr1,__deg'],
  ['liftOverDrag', '__L/D,_aero'],
  ['cl', '___cl,total'],
  ['cd', '___cd,total'],
  ['sRef', 'S-ref,ft*ft'],
  ['lift', '_lift,___lb'],
  ['drag', '_drag,___lb'],
  ['side', '_side,___lb'],
] as const

type ColumnKey = (typeof COLUMNS)[number][0]

const COL = Object.fromEntries(COLUMNS.map(([key], index) => [key, index])) as Record<ColumnKey, number>

/** The header tokens of the demo log, in file order (one repeated token: "elev1,__deg"). */
export const DEMO_TOKENS: readonly string[] = COLUMNS.map(([, token]) => token)

// ------------------------------------------------------------------ model constants

/** Longest integration step (s); the output interval is split into equal sub-steps no longer than this. */
const MAX_STEP_S = 0.05

const START_LAT_DEG = 51.33
const START_LON_DEG = -3.62
/** Heading of the air-relative velocity at the start (deg true) */
const START_TRACK_DEG = 265
/** Origin of X-Plane's local x/y/z frame (x east, y up, z south) */
const ORIGIN_LAT_DEG = 51.5
const ORIGIN_LON_DEG = -4
const EARTH_RADIUS_M = 6_371_000
const EARTH_RADIUS_FT = EARTH_RADIUS_M / M_PER_FT
const WIND_FROM_DEG = 275
const WIND_KT = 22
const WIND_NORTH_FPS = -WIND_KT * FPS_PER_KT * Math.cos(WIND_FROM_DEG * DEG)
const WIND_EAST_FPS = -WIND_KT * FPS_PER_KT * Math.sin(WIND_FROM_DEG * DEG)
/** The route is over the sea: X-Plane reports the water surface */
const TERRAIN_FT = 0
const GEAR_BELOW_CG_FT = 8

const REAL_TIME_START_S = 600
const ZULU_START_H = 10.5
const LOCAL_OFFSET_H = 0
const HOBBS_START_H = 1.84422

const SP_ZETA = DEMO_MODES.shortPeriod.zeta
const SP_WN = naturalFrequency(DEMO_MODES.shortPeriod)
const PH_ZETA = DEMO_MODES.phugoid.zeta
const PH_WN = naturalFrequency(DEMO_MODES.phugoid)
const DR_ZETA = DEMO_MODES.dutchRoll.zeta
const DR_WN = naturalFrequency(DEMO_MODES.dutchRoll)
const ROLL_TAU_S = DEMO_MODES.rollSubsidence.tauS

/** Steady α change per degree of elevator (trailing edge up gives +α) */
const SP_ELEVATOR_GAIN = 0.85
/** Roll acceleration per unit aileron (rad/s²) and per rad of sideslip (dihedral effect), standard signs */
const L_AILERON = 0.55
const L_BETA = -2.65
/** Steady sideslip (rad, standard sign: + = wind from the right) per unit rudder and per lbf of left-minus-right
 * thrust. (No adverse yaw: its sideslip would feed back through the dihedral term and blur the roll-subsidence decay.) */
const K_RUDDER = -0.16
const K_DIFF_THRUST = -1.95e-6
/** Damping ratio the yaw damper adds to the dutch roll, and the rudder per rad/s of sideslip rate that does it */
const YAW_DAMPER_ZETA = 0.35
const YAW_DAMPER_GAIN = (-2 * YAW_DAMPER_ZETA) / (DR_WN * K_RUDDER)

/** Base speed loop: thrust per speed error as an acceleration (1/s); deceleration with idle and speedbrake */
const K_SPEED_HOLD = 0.3
const DECEL_ENTER_FPS = 6 * FPS_PER_KT
const DECEL_EXIT_FPS = 3 * FPS_PER_KT
const SPEEDBRAKE_DECEL = 0.7
const TAU_SPEEDBRAKE_S = 1
const TAU_FLAP_S = 2.5
/** The pilot retrims (zeroes the stick force) with this lag */
const TAU_RETRIM_S = 4

/** Pilot, longitudinal: α command per rad of flight-path error and per second of altitude error / speed (1/s);
 * thrust per speed error (1/s) */
const PILOT_K_GAMMA = 0.7
const PILOT_K_ALT = 0.11
const PILOT_K_SPEED = 0.15
const TAU_PILOT_ELEVATOR_S = 0.4
const TAU_PILOT_THROTTLE_S = 2
/** When the pilot lets go he first returns stick and throttles to the trimmed positions, this quickly (s) */
const TAU_PILOT_RELEASE_S = 0.3
/** Pilot, lateral: aileron per rad of bank error (critically damps the bank with the roll mode) */
const PILOT_K_BANK = 0.9
const TAU_PILOT_AILERON_S = 0.3

// ------------------------------------------------------------------ state vector

const VB = 0 // base airspeed relative to the air mass (ft/s)
const TB = 1 // base total thrust (lbf)
const SB = 2 // speedbrake deployment (0..1)
const HB = 3 // base (planned) altitude (ft)
const H = 4 // altitude (ft)
const U = 5 // phugoid speed perturbation (ft/s)
const DG = 6 // flight-path perturbation (rad)
const AL = 7 // short-period α perturbation (rad)
const ALD = 8 // its rate (rad/s)
const BE = 9 // sideslip, standard sign (rad)
const BED = 10 // its rate (rad/s)
const P = 11 // roll rate (rad/s)
const MU = 12 // bank angle about the velocity vector (rad)
const CHI = 13 // heading of the air-relative velocity (rad)
const FUEL = 14 // lb
const LAT = 15 // rad
const LON = 16 // rad
const XE = 17 // local x, east (m)
const ZS = 18 // local z, south (m)
const DIST = 19 // ground distance flown (ft)
const TRIM = 20 // elevator angle held by the trim (deg)
const TSYM = 21 // symmetric thrust perturbation, after the engines' spool lag (lbf)
const TDIFF = 22 // left-minus-right thrust (lbf)
const TPIL = 23 // pilot's throttle correction (lbf)
const EPIL = 24 // pilot's elevator correction (deg)
const APIL = 25 // pilot's aileron (ratio)
const FLAP = 26 // flap position (ratio)
const NX = 27

/** Values held over one integration step: controller modes, turbulence and pilot activity. */
interface Discrete {
  decelerating: boolean
  /** Altitude offset (ft) the pilot holds since last taking the controls */
  altitudeRef: number
  gustU: number
  gustW: number
  gustV: number
  gustP: number
  elevatorNoise: number
  aileronNoise: number
}

/** Quantities the derivative function works out on the way, kept for the output channels. */
interface Aux {
  airBase: AirState
  air: AirState
  weight: number
  dragBase: number
  speedbrakeHandle: number
  elevatorTrimRequired: number
  flapHandle: number
  vi: number
  vair: number
  q: number
  mach: number
  gamma: number
  hDot: number
  vDot: number
  n: number
  ny: number
  cy: number
  cl: number
  cd: number
  alpha: number
  elevator: number
  aileron: number
  rudder: number
  thrustLeft: number
  thrustRight: number
  thrustLeftCmd: number
  thrustRightCmd: number
  tsfc: number
  vNorth: number
  vEast: number
}

function newAux(): Aux {
  return {
    airBase: newAirState(),
    air: newAirState(),
    weight: 0,
    dragBase: 0,
    speedbrakeHandle: 0,
    elevatorTrimRequired: 0,
    flapHandle: 0,
    vi: 0,
    vair: 0,
    q: 0,
    mach: 0,
    gamma: 0,
    hDot: 0,
    vDot: 0,
    n: 1,
    ny: 0,
    cy: 0,
    cl: 0,
    cd: 0,
    alpha: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    thrustLeft: 0,
    thrustRight: 0,
    thrustLeftCmd: 0,
    thrustRightCmd: 0,
    tsfc: 0,
    vNorth: 0,
    vEast: 0,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function wrap360(deg: number): number {
  const w = deg % 360
  return w < 0 ? w + 360 : w
}

// ------------------------------------------------------------------ dynamics

function derivatives(t: number, x: Float64Array, d: Discrete, dx: Float64Array, aux: Aux): void {
  const S = AC.wingAreaFt2
  const weight = AC.emptyWeightLb + AC.payloadLb + x[FUEL]
  const mass = weight / G0
  aux.weight = weight

  // ---- base condition: the trajectory the pilot is flying, without perturbations
  const gb = card.baseGamma(t)
  const gbDot = card.baseGammaRate(t)
  const muCmd = card.bankCommand(t)
  const vb = x[VB]
  const airB = isaInto(x[HB], aux.airBase)
  const qb = 0.5 * airB.rho * vb * vb
  const machB = vb / airB.a
  const nb = ((vb * gbDot) / G0 + Math.cos(gb)) / Math.cos(muCmd)
  const clb = (nb * weight) / (qb * S)
  const dragB = (AC.cd0 + AC.k * clb * clb + AC.cdSpeedbrake * x[SB] + AC.cdFlap * x[FLAP]) * qb * S
  const idleTotal = 2 * idleThrustLb(airB.delta, machB)
  const maxTotal = 2 * maxThrustLb(airB.delta, machB)
  let thrustCmd: number
  if (d.decelerating) {
    thrustCmd = idleTotal
  } else {
    const vTarget = tasFromCas(card.targetKias(t) * FPS_PER_KT, airB)
    thrustCmd = clamp(dragB + weight * Math.sin(gb) + mass * K_SPEED_HOLD * (vTarget - vb), idleTotal, maxTotal)
  }
  const speedbrakeHandle = d.decelerating ? SPEEDBRAKE_DECEL : 0
  const flapHandle = card.flapHandle(t)
  const trimRequired = AC.elevatorTrim0Deg + AC.elevatorTrimSlopeDegPerCl * clb
  dx[VB] = (x[TB] - dragB - weight * Math.sin(gb)) / mass
  dx[TB] = (thrustCmd - x[TB]) / AC.engineTimeConstantS
  dx[SB] = (speedbrakeHandle - x[SB]) / TAU_SPEEDBRAKE_S
  dx[HB] = vb * Math.sin(gb)
  dx[FLAP] = (flapHandle - x[FLAP]) / TAU_FLAP_S
  dx[TRIM] = (trimRequired - x[TRIM]) / TAU_RETRIM_S
  aux.dragBase = dragB
  aux.speedbrakeHandle = speedbrakeHandle
  aux.flapHandle = flapHandle
  aux.elevatorTrimRequired = trimRequired

  // ---- actual state = base + perturbations
  const longOn = card.longitudinalHandsOn(t)
  const latOn = card.lateralHandsOn(t)
  const u = x[U]
  const dg = x[DG]
  const vi = vb + u
  const vair = vi + d.gustU
  const air = isaInto(x[H], aux.air)
  const q = 0.5 * air.rho * vair * vair
  const mach = vair / air.a
  const clAlpha = AC.clAlpha0PerRad / Math.sqrt(1 - mach * mach)
  // flight-path rate per rad of α (1/s): the lift slope seen by the trajectory
  const zAlpha = (clAlpha * q * S) / (mass * vi)
  const mu = x[MU]
  const cosMu = Math.cos(mu)

  // short period: α perturbation, forced by the elevator (test inputs, pilot, pilot jitter) and vertical gusts
  const elevatorDyn = card.elevatorInput(t) + x[EPIL] + longOn * d.elevatorNoise
  const alphaEq = -SP_ELEVATOR_GAIN * elevatorDyn * DEG + d.gustW / vi
  dx[AL] = x[ALD]
  dx[ALD] = -2 * SP_ZETA * SP_WN * x[ALD] - SP_WN * SP_WN * (x[AL] - alphaEq)

  // phugoid: speed and flight path exchange energy; the short period's extra lift bends the flight path
  const tsym = x[TSYM]
  dx[U] = -G0 * dg - 2 * PH_ZETA * PH_WN * (u + d.gustU) + tsym / mass
  const dgDot = (((PH_WN * PH_WN) / G0) * (u + d.gustU) + zAlpha * x[AL]) * cosMu
  dx[DG] = dgDot
  const gamma = gb + dg
  const hDot = vi * Math.sin(gamma)
  dx[H] = hDot

  // pilot, longitudinal: holds the altitude he had when taking the controls (elevator) and the speed (throttles);
  // when he lets go, stick and throttles go back to their trimmed positions
  const altitudeError = x[H] - x[HB] - d.altitudeRef
  const elevatorCmd = (RAD * (PILOT_K_GAMMA * dg + (PILOT_K_ALT * altitudeError) / vi)) / SP_ELEVATOR_GAIN
  dx[EPIL] = (longOn * (elevatorCmd - x[EPIL])) / TAU_PILOT_ELEVATOR_S - ((1 - longOn) * x[EPIL]) / TAU_PILOT_RELEASE_S
  dx[TPIL] =
    (longOn * (-mass * PILOT_K_SPEED * u - x[TPIL])) / TAU_PILOT_THROTTLE_S - ((1 - longOn) * x[TPIL]) / TAU_PILOT_RELEASE_S
  const tsymCmd = card.thrustStep(t) + x[TPIL]
  const tdiffCmd = card.thrustDifferential(t)
  dx[TSYM] = (tsymCmd - tsym) / AC.engineTimeConstantS
  dx[TDIFF] = (tdiffCmd - x[TDIFF]) / AC.engineTimeConstantS

  // lateral-directional: pilot wing leveller (or bank for the turn), yaw damper on the rudder
  const aileron = card.aileronInput(t) + x[APIL] + latOn * d.aileronNoise
  const aileronCmd = clamp(PILOT_K_BANK * (muCmd - mu), -0.4, 0.4)
  dx[APIL] = (latOn * (aileronCmd - x[APIL])) / TAU_PILOT_AILERON_S - ((1 - latOn) * x[APIL]) / TAU_PILOT_RELEASE_S
  const rudder = card.rudderInput(t) + card.yawDamperOn(t) * YAW_DAMPER_GAIN * x[BED]
  const betaEq = K_RUDDER * rudder + K_DIFF_THRUST * x[TDIFF] + d.gustV / vi
  dx[BE] = x[BED]
  dx[BED] = -2 * DR_ZETA * DR_WN * x[BED] - DR_WN * DR_WN * (x[BE] - betaEq)
  dx[P] = -x[P] / ROLL_TAU_S + L_AILERON * aileron + L_BETA * x[BE] + d.gustP
  dx[MU] = x[P]

  // load factors, aerodynamic coefficients and the turn
  const gammaDot = gbDot + dgDot
  const n = ((vi * gammaDot) / G0 + Math.cos(gamma)) / cosMu
  const cl = (n * weight) / (q * S)
  const cy = AC.cyBeta * x[BE] + AC.cyRudder * rudder
  const ny = (cy * q * S) / weight
  dx[CHI] = (G0 * (n * Math.sin(mu) + ny * cosMu)) / (vi * Math.cos(gamma))

  // engines and fuel
  const tdiff = x[TDIFF]
  const thrustLeft = 0.5 * (x[TB] + tsym + tdiff)
  const thrustRight = 0.5 * (x[TB] + tsym - tdiff)
  const tsfc = AC.tsfc0 + AC.tsfcPerMach * mach
  dx[FUEL] = (-tsfc * (Math.max(0, thrustLeft) + Math.max(0, thrustRight))) / 3600

  // navigation: air-relative velocity plus the steady wind
  const vh = vi * Math.cos(gamma)
  const vNorth = vh * Math.cos(x[CHI]) + WIND_NORTH_FPS
  const vEast = vh * Math.sin(x[CHI]) + WIND_EAST_FPS
  const radius = EARTH_RADIUS_FT + x[H]
  dx[LAT] = vNorth / radius
  dx[LON] = vEast / (radius * Math.cos(x[LAT]))
  dx[XE] = vEast * M_PER_FT
  dx[ZS] = -vNorth * M_PER_FT
  dx[DIST] = Math.hypot(vNorth, vEast)

  aux.vi = vi
  aux.vair = vair
  aux.q = q
  aux.mach = mach
  aux.gamma = gamma
  aux.hDot = hDot
  aux.vDot = dx[VB] + dx[U]
  aux.n = n
  aux.ny = ny
  aux.cy = cy
  aux.cl = cl
  aux.cd = AC.cd0 + AC.k * cl * cl + AC.cdSpeedbrake * x[SB] + AC.cdFlap * x[FLAP]
  aux.alpha = (cl - AC.cl0 - AC.clFlap * x[FLAP]) / clAlpha
  aux.elevator = trimRequired + elevatorDyn
  aux.aileron = aileron
  aux.rudder = rudder
  aux.thrustLeft = thrustLeft
  aux.thrustRight = thrustRight
  // the throttles lead the thrust by the spool lag: these are the thrusts they command
  aux.thrustLeftCmd = 0.5 * (thrustCmd + tsymCmd + tdiffCmd)
  aux.thrustRightCmd = 0.5 * (thrustCmd + tsymCmd - tdiffCmd)
  aux.tsfc = tsfc
  aux.vNorth = vNorth
  aux.vEast = vEast
}

/** Euler angles (rad) of the body for wind angles α, β (standard sign), flight path γ, track χ and bank μ. */
function eulerFromWind(alpha: number, beta: number, gamma: number, chi: number, mu: number, out: Float64Array): void {
  const cc = Math.cos(chi)
  const sc = Math.sin(chi)
  const cg = Math.cos(gamma)
  const sg = Math.sin(gamma)
  const cm = Math.cos(mu)
  const sm = Math.sin(mu)
  // C(wind <- NED) for the sequence χ, γ, μ
  const w00 = cg * cc
  const w01 = cg * sc
  const w02 = -sg
  const w10 = sm * sg * cc - cm * sc
  const w11 = sm * sg * sc + cm * cc
  const w12 = sm * cg
  const w20 = cm * sg * cc + sm * sc
  const w21 = cm * sg * sc - sm * cc
  const w22 = cm * cg
  // C(body <- wind) = R2(α)·R3(−β)
  const ca = Math.cos(alpha)
  const sa = Math.sin(alpha)
  const cb = Math.cos(beta)
  const sb = Math.sin(beta)
  const c00 = ca * cb * w00 - ca * sb * w10 - sa * w20
  const c01 = ca * cb * w01 - ca * sb * w11 - sa * w21
  const c02 = ca * cb * w02 - ca * sb * w12 - sa * w22
  const c12 = sb * w02 + cb * w12
  const c22 = sa * cb * w02 - sa * sb * w12 + ca * w22
  out[0] = -Math.asin(clamp(c02, -1, 1))
  out[1] = Math.atan2(c12, c22)
  out[2] = Math.atan2(c01, c00)
}

// ------------------------------------------------------------------ the flight

/** Diagnostics: scale the turbulence and the sensor noise (1 = as published, 0 = none). */
export interface SimulateOptions {
  turbulenceScale?: number
  noiseScale?: number
}

/** Simulates the demo flight and returns every logged channel. Deterministic for a given seed and rate. */
export function simulateDemo(seed: number, rateHz: number, options: SimulateOptions = {}): DemoTable {
  const turbulenceScale = options.turbulenceScale ?? 1
  const noiseScale = options.noiseScale ?? 1
  const outStep = 1 / rateHz
  const rowCount = Math.floor(card.DEMO_DURATION_S * rateHz + 1e-6) + 1
  const sub = Math.max(1, Math.ceil(outStep / MAX_STEP_S - 1e-9))

  // Noise sources, each with its own stream so they stay independent
  const turbulence = createGaussian(createRng(streamSeed(seed, 1)))
  const gustU = createMarkov(turbulence, 1.6, 3)
  const gustW = createMarkov(turbulence, 1.2, 1)
  const gustV = createMarkov(turbulence, 1.4, 2)
  const gustP = createMarkov(turbulence, 0.012, 0.6)
  const pilot = createGaussian(createRng(streamSeed(seed, 2)))
  const elevatorNoise = createMarkov(pilot, 0.03, 1.5)
  const aileronNoise = createMarkov(pilot, 0.004, 1)
  const sensor = createGaussian(createRng(streamSeed(seed, 3)))
  const noise = (sigma: number) => noiseScale * sigma * sensor()
  const timing = createGaussian(createRng(streamSeed(seed, 4)))
  const timingUniform = createRng(streamSeed(seed, 5))

  // Frame times: X-Plane writes a row on the sim frame nearest each output interval, so steps jitter by a millisecond
  // or so, with the occasional late frame. The jitter never accumulates and never reorders rows.
  const times = new Float64Array(rowCount)
  const maxJitter = 0.2 * outStep
  for (let k = 1; k < rowCount; k += 1) {
    let jitter = 0.0006 * timing()
    if (timingUniform() < 0.01) jitter += (timingUniform() - 0.5) * 0.012
    times[k] = k * outStep + clamp(jitter, -maxJitter, maxJitter)
  }
  const nInt = (rowCount - 1) * sub + 1
  const tInt = new Float64Array(nInt)
  for (let k = 0; k < rowCount - 1; k += 1) {
    for (let j = 0; j < sub; j += 1) tInt[k * sub + j] = times[k] + ((times[k + 1] - times[k]) * j) / sub
  }
  tInt[nInt - 1] = times[rowCount - 1]

  const columns = COLUMNS.map(() => new Float64Array(rowCount))
  const put = (key: ColumnKey, row: number, value: number) => {
    columns[COL[key]][row] = value
  }
  // Euler angles on the integration grid: body rates and angular accelerations are differentiated from them
  const theta = new Float64Array(nInt)
  const phi = new Float64Array(nInt)
  const psi = new Float64Array(nInt)

  // ---- initial trim at the first test point
  const x = new Float64Array(NX)
  const disc: Discrete = {
    decelerating: false,
    altitudeRef: 0,
    gustU: 0,
    gustW: 0,
    gustV: 0,
    gustP: 0,
    elevatorNoise: 0,
    aileronNoise: 0,
  }
  const aux = newAux()
  const stageAux = newAux()
  const airStart = isaInto(card.DEMO_TEST_ALTITUDE_FT, newAirState())
  x[VB] = tasFromCas(card.targetKias(0) * FPS_PER_KT, airStart)
  x[HB] = card.DEMO_TEST_ALTITUDE_FT
  x[H] = card.DEMO_TEST_ALTITUDE_FT
  x[FUEL] = AC.initialFuelLb
  x[CHI] = START_TRACK_DEG * DEG
  x[LAT] = START_LAT_DEG * DEG
  x[LON] = START_LON_DEG * DEG
  x[XE] = EARTH_RADIUS_M * Math.cos(ORIGIN_LAT_DEG * DEG) * (START_LON_DEG - ORIGIN_LON_DEG) * DEG
  x[ZS] = -EARTH_RADIUS_M * (START_LAT_DEG - ORIGIN_LAT_DEG) * DEG
  const k1 = new Float64Array(NX)
  const k2 = new Float64Array(NX)
  const k3 = new Float64Array(NX)
  const k4 = new Float64Array(NX)
  const stage = new Float64Array(NX)
  derivatives(0, x, disc, k1, aux)
  x[TB] = aux.dragBase
  x[TRIM] = aux.elevatorTrimRequired

  const euler = new Float64Array(3)
  const airTarget = newAirState()
  let previousLongOn = 0
  let previousPsi = 0

  /** Every channel except the body rates, for output row `row` (the state at times[row]). */
  function recordRow(row: number, s: Float64Array, a: Aux): void {
    const t = times[row]
    const air = a.air
    put('realTime', row, REAL_TIME_START_S + t + 0.0004 * timing())
    put('totalTime', row, t)
    put('missionTime', row, t)
    put('zuluTime', row, ZULU_START_H + t / 3600)
    put('localTime', row, ZULU_START_H + LOCAL_OFFSET_H + t / 3600)
    put('hobbsTime', row, HOBBS_START_H + t / 3600)

    // air data: the sensor noise is applied once to the airspeed, so KIAS, KEAS, KTAS and Mach stay consistent
    const vMeasured = a.vair + noise(0.06)
    put('kias', row, casFromTas(vMeasured, air) / FPS_PER_KT)
    put('keas', row, easFromTas(vMeasured, air) / FPS_PER_KT)
    put('ktas', row, vMeasured / FPS_PER_KT)
    put('ktgs', row, Math.hypot(a.vNorth, a.vEast) / FPS_PER_KT)
    put('mach', row, vMeasured / air.a)
    put('vvi', row, a.hDot * 60 + noise(2.5))
    put('totalEnergy', row, (a.hDot + (a.vi * a.vDot) / G0) * 60 + noise(4))

    const weight = a.weight
    const thrust = a.thrustLeft + a.thrustRight
    const drag = a.cd * a.q * AC.wingAreaFt2
    put('nz', row, a.n + noise(0.0015))
    // specific force along the body x axis: (T − D)/W along the flight path plus the lift's forward component
    put('nx', row, ((thrust - drag) / weight) * Math.cos(a.alpha) + a.n * Math.sin(a.alpha) + noise(0.0008))
    put('ny', row, a.ny + noise(0.0008))

    put('alpha', row, a.alpha * RAD + noise(0.015))
    // X-Plane's sideslip is positive with the nose right of the flight path: the opposite of the standard β
    put('beta', row, -s[BE] * RAD + noise(0.015))
    put('hpath', row, wrap360(Math.atan2(a.vEast, a.vNorth) * RAD + noise(0.01)))
    put('vpath', row, a.gamma * RAD + noise(0.01))
    put('slip', row, Math.atan2(a.ny, a.n) * RAD + noise(0.02))
    const i = row * sub
    put('pitch', row, theta[i] * RAD + noise(0.008))
    put('roll', row, phi[i] * RAD + noise(0.008))
    const headingTrue = wrap360(psi[i] * RAD + noise(0.01))
    const lonDeg = s[LON] * RAD
    const magVar = -1.1 + 0.42 * lonDeg
    put('headingTrue', row, headingTrue)
    put('headingMag', row, wrap360(headingTrue + magVar))
    put('magVar', row, magVar)

    put('lat', row, s[LAT] * RAD)
    put('lon', row, lonDeg)
    put('altCg', row, s[H])
    put('altGear', row, s[H] - TERRAIN_FT - GEAR_BELOW_CG_FT)
    put('terrain', row, TERRAIN_FT)
    put('altPressure', row, s[H] + noise(0.25))
    // local frame: a flat plane tangent at the origin, so "up" falls away with the Earth's curvature
    put('x', row, s[XE])
    put('y', row, s[H] * M_PER_FT - (s[XE] * s[XE] + s[ZS] * s[ZS]) / (2 * EARTH_RADIUS_M))
    put('z', row, s[ZS])
    put('vx', row, a.vEast * M_PER_FT)
    put('vy', row, a.hDot * M_PER_FT)
    put('vz', row, -a.vNorth * M_PER_FT)
    put('distFt', row, s[DIST])
    put('distNm', row, s[DIST] / 6076.12)

    put('emptyWeight', row, AC.emptyWeightLb)
    put('payload', row, AC.payloadLb)
    put('fuel', row, s[FUEL])
    put('totalWeight', row, weight)
    put('cg', row, AC.cgStartFt + AC.cgShiftFtPerLbBurnt * (AC.initialFuelLb - s[FUEL]))

    // controls: the stick carries whatever the trim does not hold (positive = pull); surfaces as ratios
    put('elevStick', row, -(a.elevator - s[TRIM]) / AC.elevatorDegPerRatio)
    put('ailStick', row, a.aileron)
    put('rudStick', row, card.rudderInput(t))
    put('elevSurf', row, -a.elevator / AC.elevatorDegPerRatio)
    put('ailSurf', row, a.aileron)
    put('rudSurf', row, a.rudder)
    put('elevTrim', row, -s[TRIM] / AC.trimDegPerRatio)
    put('flapHandle', row, a.flapHandle)
    put('flapPos', row, s[FLAP])
    put('sbHandle', row, a.speedbrakeHandle)
    put('sbPos', row, s[SB])

    const delta = air.delta
    put('throttle1', row, throttleForN1(n1ForThrust(a.thrustLeftCmd, delta, a.mach), delta))
    put('throttle2', row, throttleForN1(n1ForThrust(a.thrustRightCmd, delta, a.mach), delta))
    put('n1Left', row, n1ForThrust(a.thrustLeft, delta, a.mach))
    put('n1Right', row, n1ForThrust(a.thrustRight, delta, a.mach))
    put('ffLeft', row, a.tsfc * Math.max(0, a.thrustLeft))
    put('ffRight', row, a.tsfc * Math.max(0, a.thrustRight))
    // engine power as thrust power, T·V
    put('powerLeft', row, (a.thrustLeft * a.vair) / 550)
    put('powerRight', row, (a.thrustRight * a.vair) / 550)
    put('thrustLeft', row, a.thrustLeft)
    put('thrustRight', row, a.thrustRight)

    put('aileronLeft', row, AC.aileronDegPerRatio * a.aileron)
    put('aileronRight', row, -AC.aileronDegPerRatio * a.aileron)
    put('elevatorLeft', row, a.elevator)
    put('elevatorRight', row, a.elevator + 0.04)
    put('rudder', row, AC.rudderDegPerRatio * a.rudder)

    const qS = a.q * AC.wingAreaFt2
    put('liftOverDrag', row, a.cl / a.cd)
    put('cl', row, a.cl)
    put('cd', row, a.cd)
    put('sRef', row, AC.wingAreaFt2)
    put('lift', row, a.cl * qS)
    put('drag', row, drag)
    put('side', row, a.cy * qS)
  }

  for (let i = 0; i < nInt; i += 1) {
    const t = tInt[i]
    const h = i + 1 < nInt ? tInt[i + 1] - t : outStep / sub

    // ---- values held over this step
    const intensity = turbulenceScale * card.turbulenceIntensity(t)
    disc.gustU = intensity * gustU(h)
    disc.gustW = intensity * gustW(h)
    disc.gustV = intensity * gustV(h)
    disc.gustP = intensity * gustP(h)
    disc.elevatorNoise = elevatorNoise(h)
    disc.aileronNoise = aileronNoise(h)
    const vTarget = tasFromCas(card.targetKias(t) * FPS_PER_KT, isaInto(x[HB], airTarget))
    if (!disc.decelerating && x[VB] - vTarget > DECEL_ENTER_FPS) disc.decelerating = true
    else if (disc.decelerating && x[VB] - vTarget < DECEL_EXIT_FPS) disc.decelerating = false
    const longOn = card.longitudinalHandsOn(t)
    if (longOn > 0 && previousLongOn === 0) disc.altitudeRef = x[H] - x[HB]
    previousLongOn = longOn

    // ---- the sample at t (its derivative is also RK4's first stage)
    derivatives(t, x, disc, k1, aux)
    eulerFromWind(aux.alpha, x[BE], aux.gamma, x[CHI], x[MU], euler)
    theta[i] = euler[0]
    phi[i] = euler[1]
    // unwrap the heading so it can be differentiated
    let heading = euler[2]
    if (i > 0) heading += 2 * Math.PI * Math.round((previousPsi - heading) / (2 * Math.PI))
    psi[i] = heading
    previousPsi = heading
    if (i % sub === 0) recordRow(i / sub, x, aux)
    if (i === nInt - 1) break

    // ---- RK4 step to the next grid time
    for (let s = 0; s < NX; s += 1) stage[s] = x[s] + 0.5 * h * k1[s]
    derivatives(t + 0.5 * h, stage, disc, k2, stageAux)
    for (let s = 0; s < NX; s += 1) stage[s] = x[s] + 0.5 * h * k2[s]
    derivatives(t + 0.5 * h, stage, disc, k3, stageAux)
    for (let s = 0; s < NX; s += 1) stage[s] = x[s] + h * k3[s]
    derivatives(t + h, stage, disc, k4, stageAux)
    for (let s = 0; s < NX; s += 1) x[s] += (h / 6) * (k1[s] + 2 * k2[s] + 2 * k3[s] + k4[s])
  }

  // ---- body rates (from Euler-angle rates) and their derivatives, by central differences on the fine grid
  const rates = new Float64Array(3)
  const before = new Float64Array(3)
  const after = new Float64Array(3)
  const bodyRates = (j: number, out: Float64Array) => {
    const j0 = Math.max(0, j - 1)
    const j1 = Math.min(nInt - 1, j + 1)
    const span = tInt[j1] - tInt[j0]
    const thetaDot = (theta[j1] - theta[j0]) / span
    const phiDot = (phi[j1] - phi[j0]) / span
    const psiDot = (psi[j1] - psi[j0]) / span
    const st = Math.sin(theta[j])
    const ct = Math.cos(theta[j])
    const sp = Math.sin(phi[j])
    const cp = Math.cos(phi[j])
    out[0] = phiDot - psiDot * st
    out[1] = thetaDot * cp + psiDot * ct * sp
    out[2] = psiDot * ct * cp - thetaDot * sp
  }
  for (let row = 0; row < rowCount; row += 1) {
    const j = row * sub
    bodyRates(j, rates)
    bodyRates(Math.max(0, j - 1), before)
    bodyRates(Math.min(nInt - 1, j + 1), after)
    const span = tInt[Math.min(nInt - 1, j + 1)] - tInt[Math.max(0, j - 1)]
    put('p', row, rates[0] * RAD + noise(0.02))
    put('q', row, rates[1] * RAD + noise(0.02))
    put('r', row, rates[2] * RAD + noise(0.015))
    put('pDot', row, ((after[0] - before[0]) / span) * RAD + noise(0.15))
    put('qDot', row, ((after[1] - before[1]) / span) * RAD + noise(0.15))
    put('rDot', row, ((after[2] - before[2]) / span) * RAD + noise(0.1))
  }

  return { tokens: [...DEMO_TOKENS], columns, rowCount }
}
