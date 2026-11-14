import { describe, expect, it } from 'vitest'
import type { Channel } from '../../core/types'
import { channel, dataset, workspace, xyConfig } from './xyFixtures'
import { availablePresets, matchingPreset, withFormulaChannel } from './xyPresets'

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
      'range-endurance-jet',
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

describe('range and endurance presets', () => {
  const find = (tokens: string[], id: string, extra: Channel[] = []) => {
    const ds = fileWith(tokens)
    return availablePresets({ ...ds, channels: [...ds.channels, ...extra] }, workspace()).find((p) => p.id === id)
  }
  const formulaChannel = (id: string, expression: string): Channel => ({
    ...channel(id, [1, 2, 3], id, 'lb'),
    token: '',
    column: -1,
    derived: { expression },
  })

  it('plots one engine power against TAS with the power model, markers and axes from zero', () => {
    const preset = find(['Vtrue,_ktas', 'engn1,___hp'], 'range-endurance-prop')
    expect(preset?.name).toBe('Range & endurance — propeller (engine power vs TAS)')
    expect(preset?.section).toBe('Performance')
    expect(preset?.formula).toBeUndefined()
    expect(preset?.config).toMatchObject({
      x: 'Vtrue,_ktas',
      ys: ['engn1,___hp'],
      ySlots: [0],
      source: 'points',
      colorBy: 'series',
      fit: 'power-model',
      fitTarget: 'means',
      showMeans: true,
      rangeEndurance: true,
      axesFromZero: true,
    })
    // X-Plane 8–11 logs name engine power differently.
    expect(find(['Vtrue,_ktas', 'power,_1,hp'], 'range-endurance-prop')?.config.ys).toEqual(['power,_1,hp'])
    expect(find(['Vtrue,_ktas'], 'range-endurance-prop')).toBeUndefined()
    expect(find(['engn1,___hp'], 'range-endurance-prop')).toBeUndefined()
  })

  it('sums several engines in a formula channel made when the preset is chosen', () => {
    const preset = find(['Vtrue,_ktas', 'engn1,___hp', 'engn2,___hp'], 'range-endurance-prop')
    expect(preset?.formula).toEqual({
      name: 'Total engine power',
      unit: 'hp',
      expression: 'engn1_hp + engn2_hp',
      slug: 'total_engine_power',
      placeholder: 'fx:total_engine_power',
    })
    expect(preset?.config.ys).toEqual(['fx:total_engine_power'])
    // Once made (the store may give it another id), the preset plots it.
    expect(withFormulaChannel(preset!, 'fx:total_engine_power_2').ys).toEqual(['fx:total_engine_power_2'])
  })

  it('plots total thrust for a jet (the formula preset, reused when the file has it), else one engine, else drag', () => {
    const twin = find(['Vtrue,_ktas', 'thrst,_1,lb', 'thrst,_2,lb', '_drag,___lb'], 'range-endurance-jet')
    expect(twin?.formula).toMatchObject({ name: 'Total thrust', expression: 'thrst_1_lb + thrst_2_lb', slug: 'total_thrust' })
    expect(twin?.config).toMatchObject({ x: 'Vtrue,_ktas', ys: ['fx:total_thrust'], fit: 'drag-model', rangeEndurance: true, axesFromZero: true })
    // A formula channel with the same expression (spaced differently) is used as it is: nothing to make.
    const made = find(['Vtrue,_ktas', 'thrst,_1,lb', 'thrst,_2,lb'], 'range-endurance-jet', [
      formulaChannel('fx:my_thrust', 'thrst_1_lb+thrst_2_lb'),
    ])
    expect(made?.formula).toBeUndefined()
    expect(made?.config.ys).toEqual(['fx:my_thrust'])
    expect(find(['Vtrue,_ktas', 'thrst,_1,lb'], 'range-endurance-jet')?.config.ys).toEqual(['thrst,_1,lb'])
    expect(find(['Vtrue,_ktas', '_drag,___lb'], 'range-endurance-jet')?.config.ys).toEqual(['_drag,___lb'])
    expect(find(['Vtrue,_ktas'], 'range-endurance-jet')).toBeUndefined()
  })

  it('names the range-and-endurance preset when it plots the same channels as another, and resets its flags elsewhere', () => {
    const ds = fileWith(['Vtrue,_ktas', '_drag,___lb'])
    const presets = availablePresets(ds, workspace())
    const both = { x: 'Vtrue,_ktas', ys: ['_drag,___lb'] }
    expect(matchingPreset(presets, xyConfig({ ...both, fit: 'drag-model' }))?.id).toBe('range-endurance-jet')
    expect(matchingPreset(presets, xyConfig({ ...both, fit: 'none' }))?.id).toBe('thrust-drag')
    // Any other preset is a fresh plot: markers and axes from zero go back to off.
    const other = presets.find((p) => p.id === 'thrust-drag')
    expect(other?.config.rangeEndurance).toBeUndefined()
    expect(other?.config.axesFromZero).toBeUndefined()
    expect(other?.config).toHaveProperty('rangeEndurance')
  })
})
