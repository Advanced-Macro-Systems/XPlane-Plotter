import { describe, expect, it } from 'vitest'
import { defaultGroupId } from './pointDraft'

describe('defaultGroupId', () => {
  const groups = [
    { id: 'g1', name: 'Trim points', slot: 0 },
    { id: 'g2', name: 'Dynamic modes', slot: 1 },
  ]

  it('reuses the last group while it exists, else the first', () => {
    expect(defaultGroupId(groups, 'g2')).toBe('g2')
    expect(defaultGroupId(groups, 'gone')).toBe('g1')
    expect(defaultGroupId(groups, undefined)).toBe('g1')
    expect(defaultGroupId([], 'g1')).toBe('')
  })
})
