import { describe, expect, it } from 'vitest'
import { computeStats } from '../core/dataset'
import type { Channel, Dataset } from '../core/types'
import { defaultWorkspace, nextGroupSlot, sanitizeWorkspace } from './defaults'

function channel(id: string, values: number[], unit = ''): Channel {
  const v = Float64Array.from(values)
  const [token, occ] = id.split('#')
  return {
    id,
    token,
    occurrence: occ ? Number(occ) : 1,
    column: 0,
    meta: { label: id, short: id, unit, quantity: 'other', group: 'other', known: false },
    values: v,
    stats: computeStats(v),
  }
}

function dataset(): Dataset {
  const n = 10
  const t = Array.from({ length: n }, (_, i) => i * 0.1)
  const ramp = Array.from({ length: n }, (_, i) => i)
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 1000,
    format: 'xplane',
    rowCount: n,
    channels: [
      channel('_totl,_time', t, 's'),
      channel('_Vind,_kias', ramp.map((x) => 150 + x), 'kt'),
      channel('alpha,__deg', ramp.map((x) => 2 + x / 10), 'deg'),
      channel('___cl,total', ramp.map((x) => 0.4 + x / 50)),
      channel('pitch,__deg', ramp.map((x) => 3 + x / 10), 'deg'),
      channel('elev1,__deg', ramp.map(() => 1), 'deg'),
      channel('elev1,__deg#2', ramp.map(() => 1), 'deg'),
    ],
    timeSourceId: '_totl,_time',
    elapsed: Float64Array.from(t),
    segments: [{ start: 0, end: n, reason: 'start' }],
    sampleRateHz: 10,
    warnings: [],
    signature: 'abc',
    loadedAt: 0,
  }
}

describe('defaultWorkspace', () => {
  it('builds panels, X–Y and tracked columns from channels that exist', () => {
    const ws = defaultWorkspace(dataset())
    expect(ws.version).toBe(1)
    expect(ws.panels.map((p) => p.channelIds)).toEqual([['_Vind,_kias'], ['pitch,__deg', 'alpha,__deg']])
    expect(ws.xy.x).toBe('alpha,__deg')
    expect(ws.xy.ys).toEqual(['___cl,total'])
    expect(ws.tracked).toEqual(['_Vind,_kias', 'alpha,__deg', 'pitch,__deg', '___cl,total'])
    expect(ws.groups).toHaveLength(1)
    expect(ws.modes.channelId).toBe('pitch,__deg')
  })
})

describe('sanitizeWorkspace', () => {
  it('returns defaults for garbage', () => {
    const ds = dataset()
    expect(sanitizeWorkspace(null, ds).panels).toEqual(defaultWorkspace(ds).panels.map((p) => ({ ...p, id: expect.any(String) })))
    expect(sanitizeWorkspace({ version: 2 }, ds).version).toBe(1)
    expect(sanitizeWorkspace('nope', ds).groups).toHaveLength(1)
  })

  it('drops unknown channels, clamps ranges, repairs groups and modes', () => {
    const ds = dataset()
    const ws = sanitizeWorkspace(
      {
        version: 1,
        timeBase: 'ch:does-not-exist',
        panels: [
          { id: 'p1', channelIds: ['_Vind,_kias', 'missing', '_Vind,_kias'] },
          { id: 'p1', channelIds: ['missing'] },
          { id: 'p3', channelIds: ['elev1,__deg#2'] },
        ],
        groups: [{ id: 'g1', name: 'CG fwd', slot: 42 }],
        points: [
          { id: 't1', name: 'ok', groupId: 'g1', start: 2, end: 5 },
          { id: 't2', name: 'clamped', groupId: 'gone', start: -5, end: 999 },
          { id: 't3', name: 'empty', groupId: 'g1', start: 6, end: 6 },
          { id: 't4', name: 'nan', groupId: 'g1', start: 'x', end: 3 },
        ],
        derived: [{ id: 'bad', name: 'x', expression: '1' }, { id: 'fx:ok', name: 'ok', unit: 'kt', expression: 'Vind_kias' }],
        xy: { x: 'missing', ys: ['alpha,__deg', 'missing'], source: 'weird', fit: 'poly3' },
        modes: { channelId: 'missing', source: 'point:t9', model: 'first-order' },
        tracked: ['missing', 'alpha,__deg'],
      },
      ds,
    )
    expect(ws.timeBase).toBe('elapsed')
    expect(ws.panels.map((p) => p.channelIds)).toEqual([['_Vind,_kias'], ['elev1,__deg#2']])
    expect(new Set(ws.panels.map((p) => p.id)).size).toBe(ws.panels.length)
    expect(ws.groups).toEqual([{ id: 'g1', name: 'CG fwd', slot: 7 }])
    expect(ws.points.map((p) => [p.name, p.groupId, p.start, p.end])).toEqual([
      ['ok', 'g1', 2, 5],
      ['clamped', 'g1', 0, 10],
    ])
    expect(ws.derived).toEqual([{ id: 'fx:ok', name: 'ok', unit: 'kt', expression: 'Vind_kias' }])
    expect(ws.xy.x).toBe('alpha,__deg')
    expect(ws.xy.ys).toEqual(['alpha,__deg'])
    expect(ws.xy.source).toBe('all')
    expect(ws.xy.fit).toBe('poly3')
    expect(ws.modes).toEqual({ channelId: 'pitch,__deg', source: 'selection', model: 'first-order', detrend: 'linear' })
    expect(ws.tracked).toEqual(['alpha,__deg'])
  })

  it('keeps a valid point source and time-base channel', () => {
    const ds = dataset()
    const ws = sanitizeWorkspace(
      {
        version: 1,
        timeBase: 'ch:_totl,_time',
        points: [{ id: 't1', name: 'a', groupId: 'g1', start: 0, end: 3 }],
        groups: [{ id: 'g1', name: 'A', slot: 2 }],
        modes: { channelId: 'alpha,__deg', source: 'point:t1', model: 'oscillation', detrend: 'none' },
      },
      ds,
    )
    expect(ws.timeBase).toBe('ch:_totl,_time')
    expect(ws.modes.source).toBe('point:t1')
    expect(ws.modes.detrend).toBe('none')
  })
})

describe('nextGroupSlot', () => {
  it('picks the first unused slot, then the least used', () => {
    expect(nextGroupSlot([])).toBe(0)
    expect(nextGroupSlot([{ id: 'a', name: 'a', slot: 0 }])).toBe(1)
    const all = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, name: '', slot: i }))
    expect(nextGroupSlot([...all, { id: 'x', name: '', slot: 0 }])).toBe(1)
  })
})
