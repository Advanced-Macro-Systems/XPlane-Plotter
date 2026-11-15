// How to record Data.txt in X-Plane 12 and which Data Output rows to tick for each kind of flight test (help dialog
// and landing page). Menu names follow the X-Plane 12 Desktop Manual ("Data Input and Output from X-Plane",
// Figure 10.1); row names and index numbers come from the dictionary's groups.

import { groupById } from './groups'

export interface LoggingRecommendation {
  /** e.g. "Performance, range & endurance" */
  title: string
  /** Why these rows matter for this test */
  summary: string
  rows: { index: number | null; name: string; why: string }[]
}

/** Steps to record Data.txt in X-Plane 12, essentials first (the landing page shows the first four). */
export function recordingSteps(): string[] {
  return [
    'In X-Plane 12, move the mouse to the top of the screen, click the Settings (gear) icon and open the Data Output tab, on its General Data Output page.',
    'Tick Disk (data.txt File), the third checkbox of each row, on every row you want logged. The list is sorted by topic, not by index: the Search box above it finds a row by name.',
    'Under Output Rates, set the Disk Rate in writes per second (default 10): 10 for performance and trim points, 20–25 for dynamic modes.',
    'Click Done and fly. Quit X-Plane normally afterwards, then copy Data.txt from the main X-Plane 12 folder (X-Plane 12\\Data.txt).',
    'Rename the copy after every session, e.g. Data_phugoid_run1.txt: Data.txt can stay empty until X-Plane closes, and the next session may overwrite it.',
    'Optional: also tick Show in Cockpit on a row to watch it live during a test, for example to check that the yaw-damper output stays at 0.',
  ]
}

/**
 * A row of the guide: X-Plane 12 name and index from the dictionary, plus why to tick it. Throws for an id the
 * dictionary does not have (groupById would quietly answer "Other"), so a typo fails guide.test.ts, not the help.
 */
function row(id: string, why: string): LoggingRecommendation['rows'][number] {
  const group = groupById(id)
  if (group.id !== id || id === 'other' || id === 'derived') throw new Error(`loggingGuide: unknown Data Output row "${id}"`)
  return { index: group.index, name: group.name, why }
}

/** Which Data Output rows to tick for each kind of flight test (a dash in the index column: find it by name). */
export function loggingGuide(): LoggingRecommendation[] {
  return [
    {
      title: 'Core rows (tick for every test)',
      summary: 'Time, air data, attitude, position, weight and controls. Add the rows for your kind of test on top of these.',
      rows: [
        row('times', 'Sim time `_totl,_time` is the time axis once its jumps are removed; mission time restarts with each flight.'),
        row('speeds', 'KIAS, KEAS, KTAS and ground speed.'),
        row('mach-vvi-gload', 'Mach number, vertical speed and load factors.'),
        row('aoa-sideslip-paths', 'α, β, flight-path angle γ and track.'),
        row('pitch-roll-headings', 'Pitch θ, bank φ and heading ψ.'),
        row('lat-lon-alt', 'CG and pressure altitude, and position for the ground track.'),
        row('weight-balance', 'Current weight `total,___lb` and CG position.'),
        row('trim-flaps-slats-speedbrakes', 'Trim and configuration (flaps, slats, speedbrakes).'),
        row('flight-controls', 'Elevator, aileron and rudder as fractions of full travel.'),
      ],
    },
    {
      title: 'Performance, range & endurance',
      summary:
        'Steady points at several speeds and altitudes, in calm ISA weather: drag polar, thrust and power required, specific range and endurance. Use `total,___lb` for the weight, never `gross,___lb`.',
      rows: [
        row('lift-drag-coefficients', 'CL, CD, L/D and S ref, the area X-Plane uses for the coefficients.'),
        row('lift-drag', 'Lift and drag: in steady level flight thrust required ≈ D and power required = D·V.'),
        row('point-weather-temp-press', 'Density ratio σ, dynamic pressure q, temperature and speed of sound.'),
        row('point-weather-precip-wind', 'Wind at the aircraft: it should read 0 for still-air points.'),
        row('fuel-weights', 'Fuel in each tank, so weight is known through the run.'),
        row('fuel-flow', 'Fuel flow per engine (lb/h or gal/h: read the unit from the token).'),
        row('sfc', 'TSFC for jets, BSFC for propeller aircraft.'),
        row('engine-thrust', 'Thrust per engine.'),
        row('engine-power', 'Shaft power of piston engines; for jets compute thrust × TAS yourself.'),
        row('throttle-commanded', 'Power setting (lever position).'),
        row('n1', 'Spool speed (jets).'),
        row('engine-rpm', 'Engine speed.'),
        row('prop-efficiency-cruise', 'Propeller efficiency ηp (propeller aircraft).'),
        row('cruise-stats', "X-Plane's own specific range, range and endurance, to check your numbers."),
      ],
    },
    {
      title: 'Static stability & trim',
      summary:
        'Trimmed points of 30–60 s at several speeds and at two or more CG positions: elevator (or trim) to trim against CL or speed.',
      rows: [
        row('elevator-deflections', 'Elevator angle δe in degrees (positive trailing edge down).'),
        row('joystick', 'Pilot input: shows the controls were held fixed.'),
        row('lift-drag-coefficients', 'CL for the δe–CL plot.'),
        row('point-weather-temp-press', 'Dynamic pressure q.'),
        row('payload-weights', 'Station loads that move the CG.'),
        row('fuel-weights', 'CG drift as fuel burns.'),
        row('servos', 'Autopilot servo commands: with the stick and the elevator they show who flew pitch, pilot or autopilot.'),
        row('artificial-stability', 'Stability augmentation: it should stay 0.'),
        row('control-forces', 'Stick force (optional; it reads 0 on aircraft without a control-feel model).'),
        row('angular-moments', 'Total pitching moment near 0 confirms the trim (optional).'),
      ],
    },
    {
      title: 'Dynamic stability modes',
      summary:
        'Disk Rate 20 /s or more, autopilot and yaw damper off. Phugoid: speed, θ and altitude; short period: α, Q and nz; Dutch roll: β, R and P; roll subsidence: P and φ; spiral: φ and ψ.',
      rows: [
        row('angular-velocities', 'Body rates P, Q and R in deg/s.'),
        row('angular-accelerations', 'Angular accelerations in deg/s².'),
        row('joystick', 'Timing of the doublets and steps.'),
        row('aileron-deflections-1', 'Aileron angle δa in degrees.'),
        row('elevator-deflections', 'Elevator angle δe in degrees.'),
        row('rudder-deflections', 'Rudder angle δr in degrees.'),
        row('artificial-stability', 'The yaw damper (`ruddr,astab`) must stay 0 for bare-airframe modes.'),
        row('servos', 'With Joystick and Flight controls, shows the surfaces followed the stick, not the autopilot.'),
        row('angular-moments', 'Total rolling, pitching and yawing moments (optional).'),
      ],
    },
    {
      title: 'Propulsion-only control',
      summary:
        'Throttles as the only control: what each engine was asked for and delivered, and the yaw, roll and track response. The core rows give attitude, β and the ground track.',
      rows: [
        row('throttle-commanded', 'Lever position of each engine.'),
        row('throttle-actual', 'What each engine received after FADEC or autothrottle logic.'),
        row('engine-thrust', 'Thrust per engine: the differential thrust.'),
        row('n1', 'Spool-up lag (jets).'),
        row('n2', 'Core spool speed (jets).'),
        row('engine-rpm', 'Engine speed.'),
        row('fuel-flow', 'Fuel flow per engine.'),
        row('angular-velocities', 'Yaw and roll response, R and P.'),
        row('location-velocity-distance', 'Local X/Z for short tracks (they jump when X-Plane moves its frame origin).'),
        row('joystick', 'Shows the stick and pedals stayed neutral.'),
        row('engine-forces', 'Total propulsive force (optional).'),
      ],
    },
  ]
}
