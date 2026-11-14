// What a click in the Time-history channel list does to the panel stack. Pure: unit-tested in panelEdit.test.ts.
//
// - A plotted channel (ticked) is removed: from the active panel when it is there, otherwise from every panel.
// - An unplotted channel joins the active panel when it has the panel's unit and the panel has room; otherwise it
//   opens a new panel at the bottom, which becomes the active one (no dual y-axes: one unit per panel).
// - "New panel" (Shift+click or the toggle) always opens a new panel with the channel.
// - Colour follows the channel: the others in a panel keep their colour slots when one is removed, and a channel added
//   takes the lowest slot free in its panel (core/slots.ts).

import { assignSlots } from '../../core/slots'
import type { PanelConfig } from '../../core/types'

export interface PickOptions {
  /** Always open a new panel */
  newPanel: boolean
  /** Unit of a channel id ('' when dimensionless); null when the channel does not exist */
  unitOf: (id: string) => string | null
  makeId: () => string
  maxSeries: number
  maxPanels: number
}

export type PickChange = 'added' | 'removed' | 'created' | 'limit' | 'none'

export interface PickResult {
  panels: PanelConfig[]
  activeId: string | null
  change: PickChange
  /** The panel the channel went into (added / created) */
  panelId: string | null
}

/** The unit a panel's y-axis shows: its first existing channel's unit (null when it has none). */
export function panelUnit(panel: PanelConfig, unitOf: (id: string) => string | null): string | null {
  for (const id of panel.channelIds) {
    const unit = unitOf(id)
    if (unit !== null) return unit
  }
  return null
}

/** `panel` with these channels: the ones that stay keep their colour slots, a new one gets the lowest free slot. */
export function withChannels(panel: PanelConfig, channelIds: string[]): PanelConfig {
  return { ...panel, channelIds, slots: assignSlots(channelIds, panel.channelIds, panel.slots) }
}

/** The active panel's id: `wanted` when it still exists, else the first panel's. */
export function resolveActive(panels: readonly PanelConfig[], wanted: string | null): string | null {
  return panels.some((p) => p.id === wanted) ? wanted : (panels[0]?.id ?? null)
}

export function pickChannel(
  panels: readonly PanelConfig[],
  activeId: string | null,
  channelId: string,
  opts: PickOptions,
): PickResult {
  const unit = opts.unitOf(channelId)
  const active = panels.find((p) => p.id === resolveActive(panels, activeId)) ?? null
  if (unit === null) return { panels: [...panels], activeId: active?.id ?? null, change: 'none', panelId: null }

  const plotted = panels.some((p) => p.channelIds.includes(channelId))
  if (plotted && !opts.newPanel) {
    const inActive = active?.channelIds.includes(channelId) ?? false
    const next = panels
      .map((p) =>
        (!inActive || p.id === active?.id) && p.channelIds.includes(channelId)
          ? withChannels(p, p.channelIds.filter((id) => id !== channelId))
          : p,
      )
      .filter((p) => p.channelIds.length > 0)
    return { panels: next, activeId: resolveActive(next, active?.id ?? null), change: 'removed', panelId: null }
  }

  const fits =
    !opts.newPanel &&
    active !== null &&
    active.channelIds.length < opts.maxSeries &&
    (panelUnit(active, opts.unitOf) ?? unit) === unit
  if (fits && active) {
    const next = panels.map((p) => (p.id === active.id ? withChannels(p, [...p.channelIds, channelId]) : p))
    return { panels: next, activeId: active.id, change: 'added', panelId: active.id }
  }

  if (panels.length >= opts.maxPanels) {
    return { panels: [...panels], activeId: active?.id ?? null, change: 'limit', panelId: null }
  }
  const id = opts.makeId()
  return { panels: [...panels, { id, channelIds: [channelId], slots: [0] }], activeId: id, change: 'created', panelId: id }
}

/** Channel ids plotted anywhere, in stack order, without repeats. */
export function plottedIds(panels: readonly PanelConfig[]): string[] {
  return [...new Set(panels.flatMap((p) => p.channelIds))]
}

/** Up to `max` channel ids for the selection stats: the active panel's first, then the others in stack order. */
export function statChannelIds(panels: readonly PanelConfig[], activeId: string | null, max: number): string[] {
  const active = panels.find((p) => p.id === activeId)
  const ordered = active ? [active, ...panels.filter((p) => p !== active)] : [...panels]
  return plottedIds(ordered).slice(0, max)
}
