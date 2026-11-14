import { describe, expect, it } from 'vitest'
import { SLOT_COUNT, assignSlots, lowestFreeSlot, sanitizeSlots, slotsValid } from './slots'

describe('lowestFreeSlot', () => {
  it('finds the lowest slot no channel uses, or -1 when all 8 are taken', () => {
    expect(lowestFreeSlot([])).toBe(0)
    expect(lowestFreeSlot([0, 1, 3])).toBe(2)
    expect(lowestFreeSlot([1, 2])).toBe(0)
    expect(lowestFreeSlot([0, 1, 2, 3, 4, 5, 6, 7])).toBe(-1)
  })
})

describe('sanitizeSlots', () => {
  it('counts by position when nothing is stored (files saved before slots were)', () => {
    expect(sanitizeSlots(undefined, 3)).toEqual([0, 1, 2])
    expect(sanitizeSlots(null, 0)).toEqual([])
    expect(sanitizeSlots('0,1', 2)).toEqual([0, 1])
  })

  it('keeps valid slots as they are, whatever their order', () => {
    expect(sanitizeSlots([5, 0, 2], 3)).toEqual([5, 0, 2])
  })

  it('re-derives missing, invalid and repeated entries with the lowest free slots, deterministically', () => {
    // The first of a repeat keeps its slot; the repeat gets the lowest one left.
    expect(sanitizeSlots([2, 2, 2], 3)).toEqual([2, 0, 1])
    // Not slots: out of range, fractional, NaN, text, null.
    expect(sanitizeSlots([8, 1.5, Number.NaN, '3', null, -1], 6)).toEqual([0, 1, 2, 3, 4, 5])
    // A later valid slot is kept even when an earlier entry is invalid.
    expect(sanitizeSlots(['x', 0], 2)).toEqual([1, 0])
    // A list shorter than the channels: the rest take the lowest free slots; a longer one is cut.
    expect(sanitizeSlots([3], 3)).toEqual([3, 0, 1])
    expect(sanitizeSlots([4, 6, 1, 0], 2)).toEqual([4, 6])
    // Same input, same answer.
    expect(sanitizeSlots([7, 7, 'x'], 3)).toEqual(sanitizeSlots([7, 7, 'x'], 3))
  })

  it('wraps beyond 8 channels instead of failing (lists are capped at 8)', () => {
    const slots = sanitizeSlots(undefined, SLOT_COUNT + 2)
    expect(slots.slice(0, SLOT_COUNT)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(slots.slice(SLOT_COUNT)).toEqual([0, 1])
  })
})

describe('slotsValid', () => {
  it('accepts exactly the lists sanitizeSlots would keep', () => {
    expect(slotsValid([1, 0], 2)).toBe(true)
    expect(slotsValid([1, 1], 2)).toBe(false)
    expect(slotsValid([1], 2)).toBe(false)
    expect(slotsValid(undefined, 0)).toBe(false)
    expect(slotsValid([], 0)).toBe(true)
    expect(slotsValid([9], 1)).toBe(false)
  })
})

describe('assignSlots', () => {
  it('keeps the slot of every channel that stays when one is removed', () => {
    expect(assignSlots(['b', 'c'], ['a', 'b', 'c'], [0, 1, 2])).toEqual([1, 2])
    expect(assignSlots(['a', 'c'], ['a', 'b', 'c'], [4, 1, 6])).toEqual([4, 6])
  })

  it('gives a channel added the lowest slot the others leave free', () => {
    expect(assignSlots(['b', 'c', 'd'], ['b', 'c'], [1, 2])).toEqual([1, 2, 0])
    expect(assignSlots(['a', 'b', 'd'], ['a', 'b'], [0, 1])).toEqual([0, 1, 2])
    expect(assignSlots(['x', 'y'], [], undefined)).toEqual([0, 1])
  })

  it('follows the channel, not its place in the list', () => {
    expect(assignSlots(['c', 'a'], ['a', 'c'], [0, 3])).toEqual([3, 0])
  })

  it('reads a previous list without (valid) slots by position', () => {
    expect(assignSlots(['b'], ['a', 'b'], undefined)).toEqual([1])
    expect(assignSlots(['b', 'z'], ['a', 'b'], [5, 5])).toEqual([0, 1])
  })

  it('fills all 8 slots, one per channel', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const without = ids.filter((id) => id !== 'c')
    const slots = assignSlots([...without, 'i'], ids, [0, 1, 2, 3, 4, 5, 6, 7])
    expect(slots).toEqual([0, 1, 3, 4, 5, 6, 7, 2])
    expect(new Set(slots).size).toBe(8)
  })
})
