// Channel meanings: the X-Plane 12 Data Output dictionary (token -> label, short name, unit, quantity, group), header
// reading that tells shared tokens apart by their row, a fallback for tokens the dictionary does not know, the
// data-set groups, and the "how to record" guide shown in the app.
// OWNER: dictionary agent. dictionary.ts (channels) and groupRows.ts (Data Output rows) were built from X-Plane 12
// research notes kept outside the repo and are edited by hand; overrides.ts holds the curated labels and short names.
// Public API below is a contract; keep these signatures.
//
// Importing this barrel loads the whole dictionary (describe, header). Code on the start page's path (the shell, the
// store, the exports it reaches) imports the light modules directly instead — ./title, ./guide, ./groups, ./alias —
// so the start page never waits for the dictionary (see vite.config.ts and store/app.ts loadDatasetBuilder).

export type { ChannelGroup } from './groups'
export { allGroups, groupById } from './groups'
export { describeChannel } from './describe'
export { describeHeader } from './header'
export type { LoggingRecommendation } from './guide'
export { loggingGuide, recordingSteps } from './guide'
export { channelTitle } from './title'
