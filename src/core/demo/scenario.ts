// The demo flight's test card: when each manoeuvre happens, the pilot's inputs, when the pilot is hands-off, and the
// turbulence level. DEMO_EVENTS publishes the same timeline (and the injected mode parameters) so tests and the UI can
// find each manoeuvre. All times are seconds from the first row (the log's sim time starts at 0, so elapsed = sim time).

import { DEMO_MODES } from './aircraft'

/** Pressure altitude of the test points, ft (ISA day) */
export const DEMO_TEST_ALTITUDE_FT = 12_000

export type DemoEventKind =
  | 'level'
  | 'trim'
  | 'speed-change'
  | 'short-period'
  | 'phugoid'
  | 'dutch-roll'
  | 'roll-subsidence'
  | 'throttle-step'
  | 'differential-thrust'
  | 'turn-descent'

export interface DemoEvent {
  /** Stable id, e.g. "trim-300", "phugoid" */
  id: string
  kind: DemoEventKind
  /** Short label for the UI, e.g. "Trim point 300 KIAS" */
  label: string
  /** One sentence on what happens */
  description: string
  /** Event window [start, end), seconds from the first row */
  start: number
  end: number
  /** Steady points: the indicated airspeed held (kt) */
  kias?: number
  /** The control input that starts the event: channel id (header token) and its [start, end) */
  input?: { channel: string; start: number; end: number }
  /** The response worth analysing, the channels where it shows, and the parameters injected into it */
  response?: {
    start: number
    end: number
    channels: string[]
    /** The Modes-tab model that fits this response */
    model?: 'oscillation' | 'first-order'
    /** Damped period 2π/ωd (s) and damping ratio, for oscillations */
    periodS?: number
    zeta?: number
    /** Time constant (s), for first-order responses */
    tauS?: number
  }
}

// ------------------------------------------------------------------ timeline (single source of truth)

const DEG = Math.PI / 180

/** Indicated-airspeed targets: the flight starts in trim at the first one and decelerates to each next one. */
const SPEED_STEPS = [
  { at: 0, kias: 330 },
  { at: 48, kias: 300 },
  { at: 116, kias: 270 },
  { at: 184, kias: 240 },
  { at: 252, kias: 210 },
] as const
const LEVEL_START_END = 8
/** A deceleration (idle + speedbrake, then thrust back) takes about 22 s; the steady hold starts this long after. */
const HOLD_LEAD_IN_S = 28
const HOLD_S = 40

/** The dynamic tests start where the last trim point ends; every time below is an offset from here (s). */
const T = SPEED_STEPS[SPEED_STEPS.length - 1].at + HOLD_LEAD_IN_S + HOLD_S

/** Length of the recording, s */
export const DEMO_DURATION_S = T + 376

/** Elevator doublet (deg, trailing edge down positive: the first half is a pull) */
const SP_DOUBLET = { start: T + 2, halfS: 1, amplitudeDeg: -2, rampS: 0.15 }
/** Elevator pulse: a 4 s pull that slows the aircraft, then the stick is returned to trim and held */
const PHUGOID_PULSE = { start: T + 14, widthS: 4, amplitudeDeg: -1.6, rampS: 0.3 }
/** Rudder doublet (ratio, + = right pedal) near the dutch-roll frequency */
const DR_DOUBLET = { start: T + 203, halfS: 2.5, amplitude: 0.16, rampS: 0.25 }
/** Aileron step to the right, held, then released to neutral */
const ROLL_STEP = { start: T + 233, widthS: 2.5, amplitude: 0.28, rampS: 0.2, releaseRampS: 0.15 }
/** Both throttles advanced together (total extra thrust), then pulled back */
const THROTTLE_STEP = { start: T + 248, end: T + 308, deltaLb: 3200, rampS: 0.8, releaseRampS: 2 }
/** Left engine up, right engine down (left − right thrust), hands off, then thrust matched again */
const DIFF_THRUST = { start: T + 314, end: T + 324, deltaLb: 6000, rampS: 0.8, releaseRampS: 1.5 }
/** Flaps 1, a gentle descent and a 20° banked right turn */
const TURN = {
  flapsAt: T + 338,
  flapHandle: 0.125,
  descentAt: T + 340,
  descentRampS: 10,
  gammaDeg: -2.5,
  bankAt: T + 342,
  bankEnd: T + 366,
  bankRampS: 5,
  bankDeg: 20,
}

/** Windows [off, on) in which the pilot keeps hands off (the gain fades out over 1 s from `off`, back in from `on`).
 * On letting go, the pilot first returns stick and throttles to the trimmed positions. */
const LONGITUDINAL_HANDS_OFF = [
  [T + 0.5, T + 200], // short period and phugoid: stick fixed after the inputs
  [T + 246, T + 308], // throttle step: propulsion-only response
] as const
const LATERAL_HANDS_OFF = [
  [T + 201, T + 228], // dutch roll: controls free
  [T + 232, T + 240], // roll subsidence: aileron input, then released
  [T + 312.5, T + 324.5], // differential thrust: no correction
] as const
const YAW_DAMPER_OFF = [[T + 201, T + 228]] as const

// ------------------------------------------------------------------ published timeline

const SP_INPUT_END = SP_DOUBLET.start + 2 * SP_DOUBLET.halfS + SP_DOUBLET.rampS
const PHUGOID_INPUT_END = PHUGOID_PULSE.start + PHUGOID_PULSE.widthS + PHUGOID_PULSE.rampS
const DR_INPUT_END = DR_DOUBLET.start + 2 * DR_DOUBLET.halfS + DR_DOUBLET.rampS
const ROLL_RELEASED = ROLL_STEP.start + ROLL_STEP.widthS + ROLL_STEP.releaseRampS

function trimEvents(): DemoEvent[] {
  const events: DemoEvent[] = [
    {
      id: 'level',
      kind: 'level',
      label: 'Level start',
      description: `Level flight at FL120, ${SPEED_STEPS[0].kias} KIAS: the recording starts in trim.`,
      start: 0,
      end: LEVEL_START_END,
      kias: SPEED_STEPS[0].kias,
    },
  ]
  SPEED_STEPS.forEach((step, i) => {
    if (i > 0) {
      events.push({
        id: `decel-${step.kias}`,
        kind: 'speed-change',
        label: `Decelerate to ${step.kias} KIAS`,
        description: 'Throttles to idle and speedbrake out, then thrust set for the new speed and the aircraft retrimmed.',
        start: step.at,
        end: step.at + HOLD_LEAD_IN_S,
      })
    }
    const start = i === 0 ? LEVEL_START_END : step.at + HOLD_LEAD_IN_S
    events.push({
      id: `trim-${step.kias}`,
      kind: 'trim',
      label: `Trim point ${step.kias} KIAS`,
      description: `Steady level flight at ${step.kias} KIAS, FL120, in light turbulence.`,
      start,
      end: start + HOLD_S,
      kias: step.kias,
    })
  })
  return events
}

export const DEMO_EVENTS: readonly DemoEvent[] = [
  ...trimEvents(),
  {
    id: 'short-period',
    kind: 'short-period',
    label: 'Short period',
    description: 'Elevator doublet (pull then push, 1 s each) at 210 KIAS in smooth air; stick fixed afterwards.',
    start: T + 1,
    end: T + 12,
    input: { channel: 'elev1,__deg', start: SP_DOUBLET.start, end: SP_INPUT_END },
    response: {
      start: SP_INPUT_END + 0.15,
      end: SP_INPUT_END + 6.15,
      channels: ['alpha,__deg', '____Q,deg/s', 'pitch,__deg', 'Gload,norml'],
      model: 'oscillation',
      ...DEMO_MODES.shortPeriod,
    },
  },
  {
    id: 'phugoid',
    kind: 'phugoid',
    label: 'Phugoid',
    description: 'Elevator pulse (4 s pull) at 210 KIAS (about 250 KTAS), then stick fixed for three cycles.',
    start: T + 13,
    end: T + 200,
    input: { channel: 'elev1,__deg', start: PHUGOID_PULSE.start, end: PHUGOID_INPUT_END },
    response: {
      start: T + 20,
      end: T + 200,
      channels: ['Vtrue,_ktas', '_Vind,_kias', 'p-alt,ftMSL', 'pitch,__deg', '__VVI,__fpm'],
      model: 'oscillation',
      ...DEMO_MODES.phugoid,
    },
  },
  {
    id: 'dutch-roll',
    kind: 'dutch-roll',
    label: 'Dutch roll',
    description: 'Rudder doublet (2.5 s each way) with the yaw damper off; controls free afterwards.',
    start: T + 202,
    end: T + 228,
    input: { channel: 'ruddr,_surf', start: DR_DOUBLET.start, end: DR_INPUT_END },
    response: {
      start: DR_INPUT_END + 0.25,
      end: T + 228,
      channels: ['_beta,__deg', '____R,deg/s', '_roll,__deg', 'hding,_true'],
      model: 'oscillation',
      ...DEMO_MODES.dutchRoll,
    },
  },
  {
    id: 'roll-subsidence',
    kind: 'roll-subsidence',
    label: 'Roll subsidence',
    description: 'Aileron step to the right, held 2.5 s, then released: the roll rate builds up and dies away.',
    start: T + 232,
    end: T + 241,
    input: { channel: 'ailrn,_surf', start: ROLL_STEP.start, end: ROLL_RELEASED },
    response: {
      start: ROLL_RELEASED + 0.05,
      end: ROLL_RELEASED + 3.05,
      channels: ['____P,deg/s'],
      model: 'first-order',
      ...DEMO_MODES.rollSubsidence,
    },
  },
  {
    id: 'throttle-step',
    kind: 'throttle-step',
    label: 'Throttle step',
    description:
      'Both throttles advanced together (+3200 lbf), stick fixed: the aircraft settles into a climb through the phugoid.',
    start: T + 247,
    end: T + 310,
    input: { channel: 'thro1,handl', start: THROTTLE_STEP.start, end: THROTTLE_STEP.start + THROTTLE_STEP.rampS },
    response: {
      start: THROTTLE_STEP.start,
      end: THROTTLE_STEP.end,
      channels: ['thrst,_1,lb', 'pitch,__deg', 'vpath,__deg', '__VVI,__fpm', 'Vtrue,_ktas', 'p-alt,ftMSL'],
    },
  },
  {
    id: 'differential-thrust',
    kind: 'differential-thrust',
    label: 'Differential thrust',
    description: 'Left thrust up and right thrust down (6000 lbf apart) with hands off: the aircraft yaws and rolls right.',
    start: T + 313,
    end: T + 336,
    input: { channel: 'thro1,handl', start: DIFF_THRUST.start, end: DIFF_THRUST.end + DIFF_THRUST.releaseRampS },
    response: {
      start: DIFF_THRUST.start,
      end: DIFF_THRUST.end,
      channels: ['thrst,_1,lb', 'thrst,_2,lb', '_beta,__deg', '____R,deg/s', '_roll,__deg', 'hding,_true'],
    },
  },
  {
    id: 'turn-descent',
    kind: 'turn-descent',
    label: 'Turn and descent',
    description: 'Flaps 1, a gentle descent at about 1100 fpm and a 20° banked turn to the right.',
    start: TURN.flapsAt,
    end: DEMO_DURATION_S,
  },
]

// ------------------------------------------------------------------ schedules used by the simulation

/** 0 before t0, 1 after t0 + dur, smootherstep (C²) in between: a quick but not instantaneous pilot input. */
export function ramp(t: number, t0: number, dur: number): number {
  if (t <= t0) return 0
  if (t >= t0 + dur) return 1
  const x = (t - t0) / dur
  return x * x * x * (x * (6 * x - 15) + 10)
}

/** d/dt of ramp() (1/s) */
export function rampRate(t: number, t0: number, dur: number): number {
  if (t <= t0 || t >= t0 + dur) return 0
  const x = (t - t0) / dur
  return (30 * x * x * (1 - x) * (1 - x)) / dur
}

function doublet(t: number, start: number, half: number, rampS: number): number {
  return ramp(t, start, rampS) - 2 * ramp(t, start + half, rampS) + ramp(t, start + 2 * half, rampS)
}

function pulse(t: number, start: number, width: number, rampS: number, releaseRampS = rampS): number {
  return ramp(t, start, rampS) - ramp(t, start + width, releaseRampS)
}

/** 1 = pilot (or yaw damper) active, 0 = off; fades over 1 s at each window edge. */
function activeOutside(t: number, windows: readonly (readonly [number, number])[]): number {
  let active = 1
  for (const [off, on] of windows) active -= ramp(t, off, 1) - ramp(t, on, 1)
  return active
}

/** Indicated airspeed the pilot is flying (kt) */
export function targetKias(t: number): number {
  let kias: number = SPEED_STEPS[0].kias
  for (const step of SPEED_STEPS) if (t >= step.at) kias = step.kias
  return kias
}

/** Planned flight-path angle (rad) and its rate (rad/s): level, then the final descent */
export function baseGamma(t: number): number {
  return TURN.gammaDeg * DEG * ramp(t, TURN.descentAt, TURN.descentRampS)
}

export function baseGammaRate(t: number): number {
  return TURN.gammaDeg * DEG * rampRate(t, TURN.descentAt, TURN.descentRampS)
}

/** Bank angle the pilot flies (rad) */
export function bankCommand(t: number): number {
  return TURN.bankDeg * DEG * (ramp(t, TURN.bankAt, TURN.bankRampS) - ramp(t, TURN.bankEnd, TURN.bankRampS))
}

/** Flap handle ratio */
export function flapHandle(t: number): number {
  return TURN.flapHandle * ramp(t, TURN.flapsAt, 0.5)
}

/** Test inputs on the elevator (deg, trailing edge down positive) */
export function elevatorInput(t: number): number {
  return (
    SP_DOUBLET.amplitudeDeg * doublet(t, SP_DOUBLET.start, SP_DOUBLET.halfS, SP_DOUBLET.rampS) +
    PHUGOID_PULSE.amplitudeDeg * pulse(t, PHUGOID_PULSE.start, PHUGOID_PULSE.widthS, PHUGOID_PULSE.rampS)
  )
}

/** Test inputs on the ailerons (ratio, + = roll right) */
export function aileronInput(t: number): number {
  return ROLL_STEP.amplitude * pulse(t, ROLL_STEP.start, ROLL_STEP.widthS, ROLL_STEP.rampS, ROLL_STEP.releaseRampS)
}

/** Test inputs on the rudder pedals (ratio, + = yaw right) */
export function rudderInput(t: number): number {
  return DR_DOUBLET.amplitude * doublet(t, DR_DOUBLET.start, DR_DOUBLET.halfS, DR_DOUBLET.rampS)
}

/** Extra total thrust commanded by the throttle step (lbf) */
export function thrustStep(t: number): number {
  return (
    THROTTLE_STEP.deltaLb *
    pulse(t, THROTTLE_STEP.start, THROTTLE_STEP.end - THROTTLE_STEP.start, THROTTLE_STEP.rampS, THROTTLE_STEP.releaseRampS)
  )
}

/** Commanded left-minus-right thrust (lbf) */
export function thrustDifferential(t: number): number {
  return (
    DIFF_THRUST.deltaLb *
    pulse(t, DIFF_THRUST.start, DIFF_THRUST.end - DIFF_THRUST.start, DIFF_THRUST.rampS, DIFF_THRUST.releaseRampS)
  )
}

export function longitudinalHandsOn(t: number): number {
  return activeOutside(t, LONGITUDINAL_HANDS_OFF)
}

export function lateralHandsOn(t: number): number {
  return activeOutside(t, LATERAL_HANDS_OFF)
}

export function yawDamperOn(t: number): number {
  return activeOutside(t, YAW_DAMPER_OFF)
}

/**
 * Turbulence scale: light chop at the trim points, smooth air for the dynamic tests (as flight-test practice demands:
 * gusts would blur the lightly damped phugoid), some chop again in the descent.
 */
export function turbulenceIntensity(t: number): number {
  return 1 - 0.96 * ramp(t, T - 2, 2) + 0.66 * ramp(t, TURN.flapsAt - 2, 3)
}
