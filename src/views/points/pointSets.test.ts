import { describe, expect, it } from 'vitest'
import type { TestPoint } from '../../core/types'
import { MAX_GROUPS } from '../../store/defaults'
import { workspace } from '../xy/xyFixtures'
import {
  SPEED_POINTS_GROUP,
  addPointSet,
  defaultTarget,
  heldSpeed,
  newGroupName,
  overlappingPoint,
  speedName,
  undoPointSet,
  uniqueNames,
} from './pointSets'

function ids() {
  let n = 0
  return (prefix: 'g' | 't') => `new-${prefix}${(n += 1)}`
}

const point = (id: string, start: number, end: number, groupId = 'g1', name = id): TestPoint => ({ id, name, groupId, start, end })

const NEW = [
  { name: '250 KIAS', start: 100, end: 300 },
  { name: '240 KIAS', start: 500, end: 700 },
]

describe('names', () => {
  it('names a point by its speed, unique among the others', () => {
    expect(speedName(249.6, 'KIAS')).toBe('250 KIAS')
    expect(speedName(NaN, 'KIAS')).toBe('Point')
    expect(uniqueNames(['250 KIAS', '250 KIAS', '240 KIAS'], ['250 kias', 'Other'])).toEqual([
      '250 KIAS (2)',
      '250 KIAS (3)',
      '240 KIAS',
    ])
  })

  it('names a hold by the round speed it was flown at', () => {
    expect([300.5, 280.9, 169.4, 209.5, 116.4, 102.3, 88.6, 255].map(heldSpeed)).toEqual([300, 280, 170, 210, 116, 102, 89, 255])
    expect(heldSpeed(NaN)).toBeNaN()
  })

  it('makes a new group name unique', () => {
    expect(newGroupName('', [])).toBe(SPEED_POINTS_GROUP)
    expect(newGroupName('  ', [{ id: 'g1', name: 'Speed points', slot: 0 }])).toBe('Speed points (2)')
    expect(newGroupName('Cruise', [])).toBe('Cruise')
  })
})

describe('overlappingPoint', () => {
  it('finds a saved point that shares rows', () => {
    const points = [point('a', 100, 200), point('b', 300, 400)]
    expect(overlappingPoint(points, [150, 160])?.id).toBe('a')
    expect(overlappingPoint(points, [199, 301])?.id).toBe('a')
    expect(overlappingPoint(points, [200, 300])).toBeNull()
    expect(overlappingPoint(points, [390, 500])?.id).toBe('b')
  })
})

describe('defaultTarget', () => {
  it('is the "Speed points" group, else a new one, else the last group when the file is full', () => {
    expect(defaultTarget([{ id: 'g1', name: 'Test 1', slot: 0 }])).toEqual({ kind: 'new', name: SPEED_POINTS_GROUP })
    expect(defaultTarget([{ id: 'g1', name: 'Test 1', slot: 0 }, { id: 'g7', name: 'speed points', slot: 1 }])).toEqual({
      kind: 'existing',
      id: 'g7',
    })
    const full = Array.from({ length: MAX_GROUPS }, (_, i) => ({ id: `g${i}`, name: `G${i}`, slot: i }))
    expect(defaultTarget(full)).toEqual({ kind: 'existing', id: `g${MAX_GROUPS - 1}` })
  })
})

describe('addPointSet and undoPointSet', () => {
  it('adds the points to a new group with the next free colour, then undoes it', () => {
    const ws = workspace({ points: [point('p0', 0, 50)] })
    const { ws: next, record } = addPointSet(ws, NEW, { kind: 'new', name: 'Speed points' }, ids())
    expect(next.groups).toEqual([...ws.groups, { id: record.groupId, name: 'Speed points', slot: 1 }])
    expect(next.points.slice(1).map((p) => [p.name, p.groupId, p.start, p.end])).toEqual([
      ['250 KIAS', record.groupId, 100, 300],
      ['240 KIAS', record.groupId, 500, 700],
    ])
    expect(record).toMatchObject({ createdGroup: true, renamedFrom: null })
    expect(undoPointSet(next, record)).toEqual(ws)
  })

  it('adds to an existing group', () => {
    const ws = workspace()
    const { ws: next, record } = addPointSet(ws, NEW, { kind: 'existing', id: 'g2' }, ids())
    expect(next.groups).toEqual(ws.groups)
    expect(next.points.every((p) => p.groupId === 'g2')).toBe(true)
    expect(record.createdGroup).toBe(false)
    expect(undoPointSet(next, record)).toEqual(ws)
  })

  it('renames a fresh file’s empty default group instead of adding one beside it', () => {
    const ws = workspace({ groups: [{ id: 'g1', name: 'Test 1', slot: 0 }] })
    const { ws: next, record } = addPointSet(ws, NEW, { kind: 'new', name: 'Speed points' }, ids())
    expect(next.groups).toEqual([{ id: 'g1', name: 'Speed points', slot: 0 }])
    expect(record).toMatchObject({ groupId: 'g1', createdGroup: false, renamedFrom: 'Test 1' })
    expect(undoPointSet(next, record)).toEqual(ws)
  })

  it('puts the group in the X–Y group filter, so the new points are plotted', () => {
    const ws = workspace({ xy: { ...workspace().xy, source: 'points', groups: ['g1'] } })
    const { ws: next, record } = addPointSet(ws, NEW, { kind: 'new', name: 'Speed points' }, ids())
    expect(next.xy.groups).toEqual(['g1', record.groupId])
    expect(undoPointSet(next, record).xy.groups).toEqual(['g1'])
    // Every group chosen is stored as "every group".
    const all = workspace({ xy: { ...workspace().xy, groups: ['g1'] } })
    expect(addPointSet(all, NEW, { kind: 'existing', id: 'g2' }, ids()).ws.xy.groups).toEqual([])
    // No filter: nothing to change.
    expect(addPointSet(workspace(), NEW, { kind: 'existing', id: 'g2' }, ids()).ws.xy.groups).toBeUndefined()
  })

  it('uses the last group when the file already has the most groups', () => {
    const groups = Array.from({ length: MAX_GROUPS }, (_, i) => ({ id: `g${i}`, name: `G${i}`, slot: i }))
    const { ws: next, record } = addPointSet(workspace({ groups }), NEW, { kind: 'new', name: 'More' }, ids())
    expect(next.groups).toHaveLength(MAX_GROUPS)
    expect(record.groupId).toBe(`g${MAX_GROUPS - 1}`)
  })

  it('keeps on undo what changed since: a group that gained other points, a Modes window on a removed point', () => {
    const ws = workspace()
    const { ws: next, record } = addPointSet(ws, NEW, { kind: 'new', name: 'Speed points' }, ids())
    const later = {
      ...next,
      points: [...next.points, point('x', 900, 950, record.groupId)],
      modes: { ...next.modes, source: `point:${record.ids[0]}` as const },
    }
    const undone = undoPointSet(later, record)
    expect(undone.points.map((p) => p.id)).toEqual(['x'])
    expect(undone.groups.some((g) => g.id === record.groupId)).toBe(true)
    expect(undone.modes.source).toBe('selection')
  })
})
