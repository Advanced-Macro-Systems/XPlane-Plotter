import { describe, expect, it } from 'vitest'
import { computeStats } from '../../core/dataset'
import type { Channel, Dataset } from '../../core/types'
import { TIME_PRESETS, presetPanels, resolvePreset, resolvePresets, type TimePreset } from './presets'

function channel(id: string, short: string, unit: string): Channel {
  const values = Float64Array.from([1, 2, 3])
  return {
    id,
    token: id.replace(/#\d+$/, ''),
    occurrence: 1,
    column: 0,
    meta: { label: short, short, unit, quantity: 'other', group: 'other', known: false },
    values,
    stats: computeStats(values),
  }
}

function dataset(channels: Channel[]): Dataset {
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 1,
    format: 'xplane',
    rowCount: 3,
    channels,
    timeSourceId: null,
    elapsed: Float64Array.from([0, 1, 2]),
    segments: [{ start: 0, end: 3, reason: 'start' }],
    sampleRateHz: 1,
    warnings: [],
    signature: 'sig',
    loadedAt: 0,
  }
}

const lookupOf = (channels: Channel[]) => {
  const map = new Map(channels.map((c) => [c.id, c]))
  return (id: string) => map.get(id)
}

describe('resolvePreset', () => {
  const preset: TimePreset = {
    id: 'test',
    name: 'Test',
    description: '',
    panels: [
      ['a', 'b', 'missing'],
      [['alt-missing', 'c']],
      ['a', 'd'],
      ['nothing'],
    ],
  }

  it('keeps existing channels, takes the first existing alternative and never repeats a channel', () => {
    const channels = [channel('a', 'A', 'kt'), channel('b', 'B', 'kt'), channel('c', 'C', 'ft'), channel('d', 'D', 'kt')]
    expect(resolvePreset(preset, lookupOf(channels))).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('splits a panel whose channels have different units (no dual axes)', () => {
    const channels = [channel('a', 'A', 'kt'), channel('b', 'B', 'deg'), channel('d', 'D', 'deg')]
    expect(resolvePreset(preset, lookupOf(channels))).toEqual([['a'], ['b'], ['d']])
  })

  it('caps series per panel and the number of panels', () => {
    const many: TimePreset = { id: 'many', name: 'Many', description: '', panels: [['a', 'b', 'c', 'd'], ['e'], ['f']] }
    const channels = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => channel(id, id, 'kt'))
    expect(resolvePreset(many, lookupOf(channels), 2, 3)).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('gives nothing for a log without the preset channels', () => {
    expect(resolvePreset(preset, () => undefined)).toEqual([])
  })
})

describe('the built-in presets', () => {
  it('cover the six kinds of test, each with a name and a description', () => {
    expect(TIME_PRESETS.map((p) => p.name)).toEqual([
      'Longitudinal',
      'Lateral-directional',
      'Performance',
      'Engines',
      'Controls & trim',
      'Propulsion control',
    ])
    for (const preset of TIME_PRESETS) expect(preset.description.length).toBeGreaterThan(10)
  })

  it('look channels up by X-Plane token and summarise them by short name', () => {
    const ds = dataset([
      channel('_Vind,_kias', 'KIAS', 'kt'),
      channel('Vtrue,_ktas', 'KTAS', 'kt'),
      channel('p-alt,ftMSL', 'Altitude', 'ft'),
      channel('pitch,__deg', 'Pitch', 'deg'),
      channel('alpha,__deg', 'AoA', 'deg'),
      channel('thro1,handl', 'Throttle 1', ''),
      channel('thro2,handl', 'Throttle 2', ''),
      channel('thrst,_1,lb', 'Thrust 1', 'lb'),
    ])
    const resolved = resolvePresets(ds)
    const longitudinal = resolved.find((r) => r.preset.id === 'longitudinal')
    expect(longitudinal?.panels).toEqual([['_Vind,_kias', 'Vtrue,_ktas'], ['p-alt,ftMSL'], ['pitch,__deg', 'alpha,__deg']])
    expect(longitudinal?.summary).toBe('KIAS, KTAS · Altitude · Pitch, AoA')
    const propulsion = resolved.find((r) => r.preset.id === 'propulsion')
    expect(propulsion?.panels).toEqual([['thro1,handl', 'thro2,handl'], ['thrst,_1,lb'], ['pitch,__deg']])
    const lateral = resolved.find((r) => r.preset.id === 'lateral')
    expect(lateral?.panels).toEqual([])
    expect(lateral?.summary).toBe('')
  })

  it('makes panel configs with fresh ids', () => {
    let n = 0
    const panels = presetPanels([['a', 'b'], ['c']], () => `p${(n += 1)}`)
    expect(panels).toEqual([
      { id: 'p1', channelIds: ['a', 'b'] },
      { id: 'p2', channelIds: ['c'] },
    ])
  })
})
