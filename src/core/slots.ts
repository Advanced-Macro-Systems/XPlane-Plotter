// Colour slots of a channel list — a Time-history panel's channels (PanelConfig.slots) or the X–Y Y channels
// (XYConfig.ySlots) — stored parallel to the ids, so colour follows the entity: a channel keeps its categorical slot
// (0..7, styles/global.css --series-1..8) for as long as it stays in the list. Removing a channel never re-colours the
// others; a channel added gets the lowest slot that no other channel of that list uses. Pure: unit-tested in
// slots.test.ts.

/** The categorical palette has 8 validated slots; a list never holds more than 8 channels. */
export const SLOT_COUNT = 8

function isSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SLOT_COUNT
}

/** The lowest slot (0..7) not in `used`, or -1 when all 8 are taken. */
export function lowestFreeSlot(used: Iterable<number>): number {
  const taken = new Set(used)
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) if (!taken.has(slot)) return slot
  return -1
}

/**
 * Stored slots made valid for a list of `count` channels (entry i belongs to channel i). Entries that are whole numbers
 * 0..7 are kept, the first of a repeated slot keeping it; every other entry — missing (no stored list, or a shorter
 * one), not a slot, or a repeat — gets the lowest slot still free, in list order. Without stored slots this is
 * 0, 1, 2, ... (colour by position, as before slots were stored). Deterministic, so a saved workspace, a session file
 * and every renderer agree. Beyond 8 channels (never stored: lists are capped at 8) the slots wrap.
 */
export function sanitizeSlots(input: unknown, count: number): number[] {
  const stored: readonly unknown[] = Array.isArray(input) ? input : []
  const out: number[] = new Array<number>(count).fill(-1)
  const used = new Set<number>()
  for (let i = 0; i < count; i += 1) {
    const slot = stored[i]
    if (isSlot(slot) && !used.has(slot)) {
      out[i] = slot
      used.add(slot)
    }
  }
  for (let i = 0; i < count; i += 1) {
    if (out[i] >= 0) continue
    const free = lowestFreeSlot(used)
    out[i] = free >= 0 ? free : i % SLOT_COUNT
    used.add(out[i])
  }
  return out
}

/** True when `slots` is exactly what sanitizeSlots gives for `count` channels (nothing to repair). */
export function slotsValid(slots: unknown, count: number): slots is number[] {
  if (!Array.isArray(slots) || slots.length !== count) return false
  const fixed = sanitizeSlots(slots, count)
  return fixed.every((slot, i) => slot === slots[i])
}

/**
 * The slots of `ids` after an edit of a list that was `previousIds` (with `previousSlots`): a channel that was in the
 * list keeps its slot, a channel added gets the lowest slot the others leave free. The order of `ids` does not matter.
 */
export function assignSlots(
  ids: readonly string[],
  previousIds: readonly string[],
  previousSlots: readonly number[] | undefined,
): number[] {
  const before = sanitizeSlots(previousSlots, previousIds.length)
  const kept = new Map<string, number>()
  previousIds.forEach((id, i) => {
    if (!kept.has(id)) kept.set(id, before[i])
  })
  return sanitizeSlots(
    ids.map((id) => kept.get(id) ?? null),
    ids.length,
  )
}
