// Grouping and search for channel lists (shared by ChannelPicker and any view that lists channels).

import { channelAlias } from '../core/channels/alias'
import { allGroups, groupById } from '../core/channels'
import type { Channel } from '../core/types'

export interface ChannelGroupBlock {
  id: string
  name: string
  channels: Channel[]
}

/** Channels grouped and ordered like the pickers show them (group order, then file order). */
export function groupChannels(channels: readonly Channel[]): ChannelGroupBlock[] {
  const order = new Map(allGroups().map((g, i) => [g.id, g.order ?? i]))
  const blocks = new Map<string, ChannelGroupBlock>()
  for (const ch of channels) {
    const group = groupById(ch.meta.group)
    let block = blocks.get(group.id)
    if (!block) {
      block = { id: group.id, name: group.name, channels: [] }
      blocks.set(group.id, block)
    }
    block.channels.push(ch)
  }
  return [...blocks.values()].sort((a, b) => (order.get(a.id) ?? 9998) - (order.get(b.id) ?? 9998))
}

/** Every search term must appear in the label, short name, unit, token, alias or group name. */
export function matchesChannel(ch: Channel, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const hay = [ch.meta.label, ch.meta.short, ch.meta.unit, ch.token, ch.id, channelAlias(ch), groupById(ch.meta.group).name]
    .join(' ')
    .toLowerCase()
  return terms.every((t) => hay.includes(t))
}
