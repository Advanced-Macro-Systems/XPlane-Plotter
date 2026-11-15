import { describe, expect, it } from 'vitest'
import { fill, makeLog, pointAt, times } from '../../core/checklists/fixtures'
import { defaultWorkspace } from '../../store/defaults'
import { perfChecklists, perfSets } from './checklistModel'

// Synthetic logs (invented values): what the range-and-endurance checklist plots when the X–Y plot is not a
// range-and-endurance fit.
function log(columns: Record<string, (t: number) => number>) {
  const t = times(100, 10)
  return makeLog(t, Object.fromEntries(Object.entries(columns).map(([token, f]) => [token, fill(t, f)])))
}

describe('perfSets: the preset’s curve when the X–Y plot is not a range-and-endurance fit', () => {
  it('an engine type the log does not tell, with only engine power logged: the power curve and the power model', () => {
    const ds = log({ 'Vtrue,_ktas': (t) => 100 + t / 10, 'engn1,___hp': () => 97 })
    const ws = { ...defaultWorkspace(ds), points: [pointAt(ds, 'P1', 10, 40)] }
    const [set] = perfSets(ds, ws)
    expect(set.y?.token).toBe('engn1,___hp')
    expect(set.fit).toBe('power-model')
    // The construction check still asks for the engine type.
    const [{ report }] = perfChecklists(ds, ws)
    expect(report.propulsion).toBeNull()
    expect(report.set.find((c) => c.id === 'construction')?.status).toBe('not-checkable')
  })

  it('with thrust logged (or declared jet) it stays on the thrust curve and the drag model', () => {
    const ds = log({ 'Vtrue,_ktas': (t) => 100 + t / 10, 'thrst,_1,lb': () => 3000, 'engn1,___hp': () => 900 })
    const ws = { ...defaultWorkspace(ds), points: [pointAt(ds, 'P1', 10, 40)] }
    expect(perfSets(ds, ws)[0].fit).toBe('drag-model')
    expect(perfSets(ds, ws)[0].y?.token).toBe('thrst,_1,lb')
    const powerOnly = log({ 'Vtrue,_ktas': (t) => 100 + t / 10, 'engn1,___hp': () => 97 })
    const declared = { ...defaultWorkspace(powerOnly), points: [pointAt(powerOnly, 'P1', 10, 40)], perfCheck: { propulsion: 'jet' as const } }
    expect(perfSets(powerOnly, declared)[0].fit).toBe('drag-model')
  })
})
