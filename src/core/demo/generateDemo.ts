// A synthetic but physically plausible flight, written in X-Plane 12 Data.txt format, for the "Try the demo" button.
// Clearly synthetic (never use it as flight-test evidence). Deterministic for a given seed.
// OWNER: demo agent. Public API below is a contract; keep these signatures.
//
// The flight (see scenario.ts for the exact timeline): a generic twin-engine narrow-body at FL120 flies steady trim
// points at 330/300/270/240/210 KIAS, then a short-period doublet, a phugoid pulse, a dutch-roll rudder doublet, an
// aileron step (roll subsidence), a symmetric throttle step, a differential-thrust yaw/roll test, and a descending
// turn with flaps 1. The physics is in simulate.ts, the file layout in xplaneFormat.ts; the injected mode parameters
// are published in DEMO_MODES and, with the timeline, in DEMO_EVENTS.

import { simulateDemo } from './simulate'
import { formatXPlaneLog } from './xplaneFormat'

export { DEMO_AIRCRAFT, DEMO_MODES } from './aircraft'
export { DEMO_DURATION_S, DEMO_EVENTS, DEMO_TEST_ALTITUDE_FT, type DemoEvent, type DemoEventKind } from './scenario'
export { DEMO_TOKENS, simulateDemo, type DemoTable, type SimulateOptions } from './simulate'
export { formatCell, formatXPlaneLog } from './xplaneFormat'

export const DEMO_FILE_NAME = 'Demo flight (synthetic).txt'

/** Seed used when none is given: the default demo is always the same file. */
export const DEMO_DEFAULT_SEED = 737
/** Output rate (rows per second) when none is given, as in a typical X-Plane recording */
export const DEMO_DEFAULT_RATE_HZ = 10
/** Accepted output rates (Hz); values outside are clamped */
export const DEMO_RATE_LIMITS_HZ = { min: 1, max: 50 } as const

/**
 * Generates the demo log text: blank first line, pipe-separated header of real X-Plane tokens, one row per frame
 * (X-Plane's number formatting: right-aligned, 5 decimals, " | " separators, trailing "| ").
 */
export function generateDemoFlight(opts?: { seed?: number; rateHz?: number }): string {
  const seed = opts?.seed !== undefined && Number.isFinite(opts.seed) ? opts.seed : DEMO_DEFAULT_SEED
  const requested = opts?.rateHz !== undefined && Number.isFinite(opts.rateHz) ? opts.rateHz : DEMO_DEFAULT_RATE_HZ
  const rateHz = Math.min(DEMO_RATE_LIMITS_HZ.max, Math.max(DEMO_RATE_LIMITS_HZ.min, requested))
  const table = simulateDemo(seed, rateHz)
  return formatXPlaneLog(table.tokens, table.columns, table.rowCount)
}
