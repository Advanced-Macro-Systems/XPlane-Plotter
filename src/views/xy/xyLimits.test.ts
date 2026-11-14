import { describe, expect, it } from 'vitest'
import { channel, dataset, workspace, xyConfig } from './xyFixtures'
import { xyAxisLimits } from './xyLimits'

describe('xyAxisLimits', () => {
  // 1000 in-flight samples of CL 0.2 … 0.8 against airspeed, then a few absurd ones on the ground at zero airspeed.
  const n = 1003
  const speed = Array.from({ length: n }, (_, i) => (i < 1000 ? 150 + (i % 100) : 0))
  const cl = Array.from({ length: n }, (_, i) => (i < 1000 ? 0.2 + ((i * 7) % 600) / 1000 : -6e8 + i))
  const ds = dataset([channel('x', speed, 'KIAS', 'kt'), channel('y', cl, 'CL', '')], Array.from({ length: n }, (_, i) => i))

  it('gives the ranges the X–Y tab shows: the absurd samples stay off the axes', () => {
    const limits = xyAxisLimits(ds, workspace(), null)
    expect(limits?.y).toEqual([0.1, 0.9])
  })

  it('is null when nothing is plotted or nothing needs leaving out', () => {
    expect(xyAxisLimits(ds, workspace({ xy: xyConfig({ x: null }) }), null)).toBeNull()
    const tame = dataset([channel('x', [1, 2, 3, 4], 'X', ''), channel('y', [2, 4, 6, 8], 'Y', '')], [0, 1, 2, 3])
    expect(xyAxisLimits(tame, workspace(), null)).toBeNull()
  })

  it('uses the zoom range only for the zoom-range source', () => {
    const inFlight: [number, number] = [0, 1000]
    const zoomed = workspace({ xy: xyConfig({ source: 'view' }) })
    expect(xyAxisLimits(ds, zoomed, inFlight)).toBeNull()
    expect(xyAxisLimits(ds, workspace(), inFlight)?.y).toEqual([0.1, 0.9])
  })
})
