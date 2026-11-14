// Small dataset helpers every part of the app uses: channel lookup by id, column stats, the signature hash.
// Building a Dataset from a RawTable is core/buildDataset.ts: it reads the channel dictionary, so it is loaded on
// demand and kept off the start page.
// OWNER: parser agent. computeStats and channelById are final — keep them as they are.

import type { Channel, Dataset } from './types'
import { computeStats } from './channelStats'

// computeStats lives in its own module (the parser worker uses it too); it is still imported from here.
export { computeStats }

/** FNV-1a 32-bit hash of the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const lookup = new WeakMap<Dataset, Map<string, Channel>>()

/** O(1) lookup (cached per dataset object). */
export function channelById(ds: Dataset, id: string): Channel | undefined {
  let table = lookup.get(ds)
  if (!table) {
    table = new Map(ds.channels.map((ch) => [ch.id, ch]))
    lookup.set(ds, table)
  }
  return table.get(id)
}
