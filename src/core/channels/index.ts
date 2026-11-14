// Channel meanings: the X-Plane 12 Data Output dictionary (token -> label, short name, unit, quantity, group), header
// reading that tells shared tokens apart by their row, a fallback for tokens the dictionary does not know, the
// data-set groups, and the "how to record" guide shown in the app.
// OWNER: dictionary agent. dictionary.ts (channels) and groupRows.ts (Data Output rows) were built from X-Plane 12
// research notes kept outside the repo and are edited by hand; overrides.ts holds the curated labels and short names.
// Public API below is a contract; keep these signatures.

import type { Channel } from '../types'

export type { ChannelGroup } from './groups'
export { allGroups, groupById } from './groups'
export { describeChannel } from './describe'
export { describeHeader } from './header'
export type { LoggingRecommendation } from './guide'
export { loggingGuide, recordingSteps } from './guide'

/** "KIAS [kt]" style name for legends and axis titles (short label + unit). */
export function channelTitle(ch: Channel): string {
  return ch.meta.unit ? `${ch.meta.short} [${ch.meta.unit}]` : ch.meta.short
}
