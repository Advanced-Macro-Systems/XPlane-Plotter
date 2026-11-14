import { describe, expect, it } from 'vitest'
import { fitOscillation } from '../core/analysis/modes'
import { buildDataset } from '../core/buildDataset'
import { channelById } from '../core/dataset'
import { DEMO_MODES, generateDemoFlight } from '../core/demo/generateDemo'
import { parseText } from '../core/parse'
import { sanitizeWorkspace } from './defaults'
import { demoWorkspace } from './demoWorkspace'

const text = generateDemoFlight()
const ds = { ...buildDataset(parseText(text), { name: 'demo', size: text.length }), id: 'ds1' }

describe('demoWorkspace', () => {
  const ws = demoWorkspace(ds)

  it('marks five trim points and four dynamic-mode windows in two groups', () => {
    expect(ws.groups.map((g) => g.name)).toEqual(['Trim points', 'Dynamic modes'])
    const trim = ws.points.filter((p) => p.groupId === ws.groups[0].id)
    const dynamic = ws.points.filter((p) => p.groupId === ws.groups[1].id)
    expect(trim.map((p) => p.name)).toEqual(['Trim 330 KIAS', 'Trim 300 KIAS', 'Trim 270 KIAS', 'Trim 240 KIAS', 'Trim 210 KIAS'])
    expect(dynamic.map((p) => p.name)).toEqual(['Short period', 'Phugoid', 'Dutch roll', 'Roll subsidence'])
    for (const p of ws.points) {
      expect(p.end).toBeGreaterThan(p.start)
      expect(p.end).toBeLessThanOrEqual(ds.rowCount)
    }
    expect(dynamic.find((p) => p.name === 'Phugoid')?.note).toContain(`T = ${DEMO_MODES.phugoid.periodS} s`)
  })

  it('survives sanitising unchanged (points, X–Y group filter, modes source)', () => {
    expect(sanitizeWorkspace(ws, ds)).toEqual(JSON.parse(JSON.stringify(ws)))
    expect(ws.xy).toMatchObject({ x: '___cl,total', source: 'points', groups: ['g1'], fit: 'linear', fitTarget: 'means' })
    expect(ws.modes.source).toBe('point:demo-phugoid')
  })

  it('points the Dynamic modes tab at a window where the phugoid fit recovers the injected values', () => {
    const point = ws.points.find((p) => `point:${p.id}` === ws.modes.source)
    const channel = channelById(ds, ws.modes.channelId ?? '')
    expect(point && channel).toBeTruthy()
    if (!point || !channel) return
    const t = ds.elapsed.slice(point.start, point.end)
    const y = channel.values.slice(point.start, point.end)
    const fit = fitOscillation(t, y, { detrend: ws.modes.detrend })
    expect(fit.ok).toBe(true)
    expect(Math.abs(fit.periodS / DEMO_MODES.phugoid.periodS - 1)).toBeLessThan(0.05)
    expect(Math.abs(fit.zeta - DEMO_MODES.phugoid.zeta)).toBeLessThan(0.02)
  })
})

describe('sanitizeWorkspace: X–Y group filter', () => {
  it('keeps only existing group ids and drops an empty filter', () => {
    const ws = demoWorkspace(ds)
    expect(sanitizeWorkspace({ ...ws, xy: { ...ws.xy, groups: ['g2', 'nope', 'g2'] } }, ds).xy.groups).toEqual(['g2'])
    expect(sanitizeWorkspace({ ...ws, xy: { ...ws.xy, groups: ['nope'] } }, ds).xy).not.toHaveProperty('groups')
    expect(sanitizeWorkspace({ ...ws, xy: { ...ws.xy, groups: 'g1' } }, ds).xy).not.toHaveProperty('groups')
  })
})
