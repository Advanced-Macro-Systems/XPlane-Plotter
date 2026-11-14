import { describe, expect, it } from 'vitest'
import { channel, dataset, workspace, xyConfig } from './xyFixtures'
import { availablePresets, matchingPreset } from './xyPresets'

function fileWith(tokens: string[]) {
  return dataset(
    tokens.map((t) => channel(t, [1, 2, 3], t, '')),
    [0, 1, 2],
  )
}

const ALL = [
  'alpha,__deg',
  '___cl,total',
  '___cd,total',
  '__L/D,_aero',
  '_Vind,_kias',
  'Vtrue,_ktas',
  '_drag,___lb',
  'thrst,_1,lb',
  'thrst,_2,lb',
  'FF__1,_lb/h',
  'FF__2,_lb/h',
  '__VVI,__fpm',
  '__lat,__deg',
  '__lon,__deg',
  'elev1,__deg',
  '_elev,_surf',
]

describe('availablePresets', () => {
  it('offers every preset when the file has the channels', () => {
    const presets = availablePresets(fileWith(ALL), workspace())
    expect(presets.map((p) => p.id)).toEqual([
      'lift-curve',
      'drag-polar',
      'lift-to-drag',
      'static-stability',
      'trim-curve',
      'thrust-drag',
      'fuel-flow',
      'rate-of-climb',
      'ground-track',
    ])
  })

  it('offers only presets whose channels exist', () => {
    const presets = availablePresets(fileWith(['_Vind,_kias', 'Vtrue,_ktas', '__VVI,__fpm']), workspace())
    expect(presets.map((p) => p.id)).toEqual(['rate-of-climb'])
  })

  it('plots the elevator in degrees, else the surface ratio, else the trim', () => {
    const ws = workspace()
    const stability = (tokens: string[]) => availablePresets(fileWith(['___cl,total', ...tokens]), ws).find((p) => p.id === 'static-stability')
    expect(stability(['elev1,__deg', '_elev,_surf'])?.config.ys).toEqual(['elev1,__deg'])
    expect(stability(['_elev,_surf', '_trim,_elev'])?.config.ys).toEqual(['_elev,_surf'])
    expect(stability(['_trim,_elev'])?.config.ys).toEqual(['_trim,_elev'])
    expect(stability([])).toBeUndefined()
  })

  it('uses the test-point means for static stability when there are points', () => {
    const withPoints = workspace({ points: [{ id: 't1', name: 'A', groupId: 'g1', start: 0, end: 2 }], xy: xyConfig({ groups: ['g1'] }) })
    const preset = availablePresets(fileWith(ALL), withPoints).find((p) => p.id === 'static-stability')
    expect(preset?.config).toMatchObject({
      x: '___cl,total',
      ys: ['elev1,__deg'],
      source: 'points',
      groups: ['g1'],
      colorBy: 'group',
      fit: 'linear',
      fitTarget: 'means',
      showMeans: true,
      showSamples: true,
      title: '',
    })
    const without = availablePresets(fileWith(ALL), workspace()).find((p) => p.id === 'static-stability')
    expect(without?.config).toMatchObject({ source: 'all', colorBy: 'series', fitTarget: 'samples' })
    expect(without?.config.groups).toBeUndefined()
  })

  it('puts thrust with drag (same unit) and draws the ground track as a line', () => {
    const presets = availablePresets(fileWith(ALL), workspace())
    expect(presets.find((p) => p.id === 'thrust-drag')?.config.ys).toEqual(['_drag,___lb', 'thrst,_1,lb', 'thrst,_2,lb'])
    expect(presets.find((p) => p.id === 'fuel-flow')?.config.ys).toEqual(['FF__1,_lb/h', 'FF__2,_lb/h'])
    expect(presets.find((p) => p.id === 'ground-track')?.config).toMatchObject({
      x: '__lon,__deg',
      ys: ['__lat,__deg'],
      style: 'lines',
      source: 'all',
    })
  })

  it('finds the preset a config plots', () => {
    const presets = availablePresets(fileWith(ALL), workspace())
    expect(matchingPreset(presets, xyConfig({ x: 'alpha,__deg', ys: ['___cl,total'] }))?.id).toBe('lift-curve')
    expect(matchingPreset(presets, xyConfig({ x: 'alpha,__deg', ys: ['___cd,total'] }))).toBeNull()
  })
})
