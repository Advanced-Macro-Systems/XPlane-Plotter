// What the landing page and the help dialog say about recording Data.txt in X-Plane 12. The steps and the rows to tick
// per test come from the channel dictionary (core/channels: recordingSteps, loggingGuide), whose wording follows the
// recording research (X-Plane 12 Desktop Manual, "Data Input and Output from X-Plane"): never invent menu paths here.

import { recordingSteps } from '../core/channels/guide'

/** Habits that keep a run analysable (help dialog, "Before every run"). */
export const BEFORE_EVERY_RUN: readonly string[] = [
  'Start each run from a fresh, stable state: loading a flight or repositioning resets the mission clock, and the first seconds after a reset hold junk values.',
  'Set calm ISA weather for performance and trim work.',
  'Tick the same rows for every run in a series, so the files can be compared.',
  'Disconnect the autopilot for stick-fixed points and dynamic modes; switch the yaw damper off for dutch-roll and spiral tests.',
  'Do not pause during a run.',
]

/** Recording steps for the landing card: the first `max` of the dictionary's steps, and how many more there are. */
export function landingSteps(max = 4): { steps: string[]; more: number } {
  const steps = recordingSteps()
  return { steps: steps.slice(0, max), more: Math.max(0, steps.length - max) }
}
