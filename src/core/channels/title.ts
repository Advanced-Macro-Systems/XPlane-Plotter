// A channel's display title. Its own module (no dictionary import), so the exports on the start page's path (CSV,
// MATLAB) can name channels without loading the channel dictionary; the core/channels barrel re-exports it.

import type { Channel } from '../types'

/** "KIAS [kt]" style name for legends and axis titles (short label + unit). */
export function channelTitle(ch: Channel): string {
  return ch.meta.unit ? `${ch.meta.short} [${ch.meta.unit}]` : ch.meta.short
}
