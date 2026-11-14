import { describe, expect, it } from 'vitest'
import type { PanelConfig } from '../../core/types'
import { panelUnit, pickChannel, plottedIds, resolveActive, statChannelIds, type PickOptions } from './panelEdit'

const UNITS: Record<string, string> = { kias: 'kt', ktas: 'kt', alt: 'ft', pitch: 'deg', alpha: 'deg', thr: '' }

function options(patch: Partial<PickOptions> = {}): PickOptions {
  let n = 0
  return {
    newPanel: false,
    unitOf: (id) => UNITS[id] ?? null,
    makeId: () => `new${(n += 1)}`,
    maxSeries: 8,
    maxPanels: 4,
    ...patch,
  }
}

const stack: PanelConfig[] = [
  { id: 'p1', channelIds: ['kias'] },
  { id: 'p2', channelIds: ['alt'] },
]

describe('pickChannel', () => {
  it('adds a channel with the active panel’s unit to that panel', () => {
    const result = pickChannel(stack, 'p1', 'ktas', options())
    expect(result.change).toBe('added')
    expect(result.panelId).toBe('p1')
    expect(result.activeId).toBe('p1')
    expect(result.panels[0].channelIds).toEqual(['kias', 'ktas'])
    expect(stack[0].channelIds).toEqual(['kias']) // input untouched
  })

  it('opens a new active panel for a channel with another unit (no dual axes)', () => {
    const result = pickChannel(stack, 'p1', 'pitch', options())
    expect(result.change).toBe('created')
    expect(result.panels.map((p) => p.channelIds)).toEqual([['kias'], ['alt'], ['pitch']])
    expect(result.activeId).toBe('new1')
    expect(result.panelId).toBe('new1')
  })

  it('always opens a new panel when asked', () => {
    const result = pickChannel(stack, 'p1', 'ktas', options({ newPanel: true }))
    expect(result.change).toBe('created')
    expect(result.panels.map((p) => p.channelIds)).toEqual([['kias'], ['alt'], ['ktas']])
  })

  it('removes a plotted channel from the active panel, dropping a panel left empty', () => {
    const result = pickChannel(
      [
        { id: 'p1', channelIds: ['kias', 'ktas'] },
        { id: 'p2', channelIds: ['ktas'] },
      ],
      'p1',
      'ktas',
      options(),
    )
    expect(result.change).toBe('removed')
    expect(result.panels.map((p) => p.channelIds)).toEqual([['kias'], ['ktas']])

    const emptied = pickChannel(stack, 'p2', 'alt', options())
    expect(emptied.panels.map((p) => p.id)).toEqual(['p1'])
    expect(emptied.activeId).toBe('p1')
  })

  it('removes a channel plotted only in other panels from all of them', () => {
    const result = pickChannel(
      [
        { id: 'p1', channelIds: ['kias'] },
        { id: 'p2', channelIds: ['alt', 'kias'] },
        { id: 'p3', channelIds: ['kias'] },
      ],
      'p2',
      'kias',
      options(),
    )
    expect(result.panels.map((p) => p.channelIds)).toEqual([['kias'], ['alt'], ['kias']])
    const elsewhere = pickChannel(stack, 'p2', 'kias', options())
    expect(elsewhere.change).toBe('removed')
    expect(elsewhere.panels.map((p) => p.channelIds)).toEqual([['alt']])
  })

  it('respects the panel and series limits', () => {
    const full: PanelConfig[] = [1, 2, 3, 4].map((i) => ({ id: `p${i}`, channelIds: ['kias'] }))
    expect(pickChannel(full, 'p1', 'alt', options()).change).toBe('limit')
    const crowded = pickChannel([{ id: 'p1', channelIds: ['kias'] }], 'p1', 'ktas', options({ maxSeries: 1 }))
    expect(crowded.change).toBe('created')
  })

  it('starts the first panel when there is none, and ignores unknown channels', () => {
    const first = pickChannel([], null, 'kias', options())
    expect(first.change).toBe('created')
    expect(first.panels).toEqual([{ id: 'new1', channelIds: ['kias'] }])
    expect(pickChannel(stack, 'p1', 'nope', options()).change).toBe('none')
  })

  it('treats a dimensionless channel as its own unit', () => {
    expect(pickChannel(stack, 'p1', 'thr', options()).change).toBe('created')
    const result = pickChannel([{ id: 'p1', channelIds: ['thr'] }], 'p1', 'kias', options())
    expect(result.change).toBe('created')
  })
})

describe('panel helpers', () => {
  it('reads a panel’s unit from its first existing channel', () => {
    expect(panelUnit({ id: 'p', channelIds: ['gone', 'alpha'] }, (id) => UNITS[id] ?? null)).toBe('deg')
    expect(panelUnit({ id: 'p', channelIds: ['gone'] }, (id) => UNITS[id] ?? null)).toBeNull()
  })

  it('keeps the active panel while it exists', () => {
    expect(resolveActive(stack, 'p2')).toBe('p2')
    expect(resolveActive(stack, 'gone')).toBe('p1')
    expect(resolveActive([], 'p1')).toBeNull()
  })

  it('lists plotted channels in stack order without repeats', () => {
    expect(plottedIds([{ id: 'a', channelIds: ['x', 'y'] }, { id: 'b', channelIds: ['y', 'z'] }])).toEqual(['x', 'y', 'z'])
  })

  it('takes the active panel’s channels first for the selection stats', () => {
    const panels: PanelConfig[] = [
      { id: 'a', channelIds: ['x', 'y'] },
      { id: 'b', channelIds: ['z', 'w', 'v'] },
    ]
    expect(statChannelIds(panels, 'b', 4)).toEqual(['z', 'w', 'v', 'x'])
    expect(statChannelIds(panels, null, 3)).toEqual(['x', 'y', 'z'])
  })
})
