// Adding many test points at once (the steady stretches Find steady points found, or windows typed as times): their
// names, the group they go in (a new "Speed points" group by default), the points they would repeat, and the workspace
// change with its undo. Pure: no React, no DOM.

import type { PointGroup, RowRange, TestPoint, Workspace } from '../../core/types'
import { MAX_GROUPS, nextGroupSlot } from '../../store/defaults'

/** The group new speed points go in unless the user picks another. */
export const SPEED_POINTS_GROUP = 'Speed points'

/** A name made unique among `taken` (case-insensitive) with " (2)", " (3)"... */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base
  for (let k = 2; ; k += 1) {
    const candidate = `${base} (${k})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** "250 KIAS": a speed, rounded, and its channel's short name ("KIAS", "KTAS"); "Point" without a speed. */
export function speedName(speed: number, short: string): string {
  return Number.isFinite(speed) ? `${Math.round(speed)} ${short}`.trim() : 'Point'
}

/**
 * The speed a hold was flown at, for its name: pilots hold round speeds, so a mean within 1 of a multiple of 5 is
 * named by it (300.5 → 300, 169.4 → 170); any other mean is rounded (116.4 → 116).
 */
export function heldSpeed(mean: number): number {
  const round = Math.round(mean / 5) * 5
  return Math.abs(mean - round) <= 1 ? round : Math.round(mean)
}

/** Names for a list of new points: each base name unique among the existing names and the ones before it. */
export function uniqueNames(bases: readonly string[], existing: readonly string[]): string[] {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()))
  return bases.map((base) => {
    const name = uniqueName(base.trim() || 'Point', taken)
    taken.add(name.toLowerCase())
    return name
  })
}

/** The first saved point whose rows overlap [start, end), or null: a window there would repeat it. */
export function overlappingPoint(points: readonly TestPoint[], range: RowRange): TestPoint | null {
  return points.find((p) => p.start < range[1] && range[0] < p.end) ?? null
}

/** Where new points go: a group that exists, or a new one with this name. */
export type GroupTarget = { kind: 'existing'; id: string } | { kind: 'new'; name: string }

/**
 * The group new speed points go in by default: the file's "Speed points" group when it has one, else a new one (the
 * last group when the file already has MAX_GROUPS).
 */
export function defaultTarget(groups: readonly PointGroup[]): GroupTarget {
  const named = groups.find((g) => g.name.trim().toLowerCase() === SPEED_POINTS_GROUP.toLowerCase())
  if (named) return { kind: 'existing', id: named.id }
  if (groups.length >= MAX_GROUPS && groups.length > 0) return { kind: 'existing', id: groups[groups.length - 1].id }
  return { kind: 'new', name: SPEED_POINTS_GROUP }
}

/** A new group's name: the one typed, else "Speed points", unique among the groups. */
export function newGroupName(typed: string, groups: readonly PointGroup[]): string {
  const base = typed.trim().slice(0, 60) || SPEED_POINTS_GROUP
  return uniqueName(base, new Set(groups.map((g) => g.name.trim().toLowerCase())))
}

/** A point to add (its group comes from the target). */
export type NewPoint = Omit<TestPoint, 'id' | 'groupId'>

/** What adding a set changed, for its undo. */
export interface PointSetRecord {
  ids: string[]
  groupId: string
  /** The group was made for these points */
  createdGroup: boolean
  /** The file's untouched default group ("Test 1", no points) was renamed for them: its name before */
  renamedFrom: string | null
  /** The X–Y group filter before and after (it gains the group, so the new points are plotted) */
  xyGroupsBefore: string[] | undefined
  xyGroupsAfter: string[] | undefined
}

/** The only group, still named "Test N" and with no points: a fresh file's default group, free to rename. */
function untouchedDefault(ws: Pick<Workspace, 'groups' | 'points'>): PointGroup | null {
  const [only] = ws.groups
  return ws.groups.length === 1 && ws.points.length === 0 && /^Test \d+$/.test(only.name.trim()) ? only : null
}

/**
 * The workspace with `points` added to the target group, all at once (one change, one undo). A new group takes the
 * next free colour, or is the fresh file's empty default group renamed (so a first set of points is not left beside
 * an empty "Test 1"); at MAX_GROUPS the last group is used. When X–Y plots only some groups, the target joins them.
 */
export function addPointSet(
  ws: Workspace,
  points: readonly NewPoint[],
  target: GroupTarget,
  makeId: (prefix: 'g' | 't') => string,
): { ws: Workspace; record: PointSetRecord } {
  let groups = ws.groups
  let groupId: string
  let createdGroup = false
  let renamedFrom: string | null = null
  if (target.kind === 'existing' && groups.some((g) => g.id === target.id)) {
    groupId = target.id
  } else {
    const name = newGroupName(target.kind === 'new' ? target.name : '', groups)
    const reuse = untouchedDefault(ws)
    if (reuse) {
      groupId = reuse.id
      renamedFrom = reuse.name
      groups = [{ ...reuse, name }]
    } else if (groups.length >= MAX_GROUPS) {
      groupId = groups[groups.length - 1].id
    } else {
      groupId = makeId('g')
      createdGroup = true
      groups = [...groups, { id: groupId, name, slot: nextGroupSlot(groups) }]
    }
  }
  const added: TestPoint[] = points.map((p) => ({ ...p, id: makeId('t'), groupId }))
  const before = ws.xy.groups
  let after = before
  if (before && before.length > 0 && !before.includes(groupId)) {
    const chosen = new Set([...before, groupId])
    const ordered = groups.map((g) => g.id).filter((id) => chosen.has(id))
    after = ordered.length === groups.length ? [] : ordered
  }
  return {
    ws: { ...ws, groups, points: [...ws.points, ...added], xy: after === before ? ws.xy : { ...ws.xy, groups: after } },
    record: {
      ids: added.map((p) => p.id),
      groupId,
      createdGroup,
      renamedFrom,
      xyGroupsBefore: before,
      xyGroupsAfter: after,
    },
  }
}

/**
 * Undoes addPointSet: the points go, a group made for them goes too while it is empty (never the last group), a
 * renamed default group gets its name back while it is empty, and the X–Y filter goes back unless it changed since.
 */
export function undoPointSet(ws: Workspace, record: PointSetRecord): Workspace {
  const ids = new Set(record.ids)
  const points = ws.points.filter((p) => !ids.has(p.id))
  const empty = !points.some((p) => p.groupId === record.groupId)
  let groups = ws.groups
  if (empty && record.createdGroup && groups.length > 1) groups = groups.filter((g) => g.id !== record.groupId)
  else if (empty && record.renamedFrom !== null) {
    const name = record.renamedFrom
    groups = groups.map((g) => (g.id === record.groupId ? { ...g, name } : g))
  }
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    (a ?? []).length === (b ?? []).length && (a ?? []).every((id, i) => id === (b ?? [])[i]) && (a === undefined) === (b === undefined)
  let xy = ws.xy
  if (record.xyGroupsAfter !== record.xyGroupsBefore && same(ws.xy.groups, record.xyGroupsAfter)) {
    const kept = (record.xyGroupsBefore ?? []).filter((id) => groups.some((g) => g.id === id))
    xy = { ...ws.xy, groups: kept }
    if (record.xyGroupsBefore === undefined) delete xy.groups
  }
  // A Modes window that pointed at a removed point falls back to the selection (as removePoint does).
  const modes = ws.modes.source.startsWith('point:') && ids.has(ws.modes.source.slice(6)) ? { ...ws.modes, source: 'selection' as const } : ws.modes
  return { ...ws, points, groups, xy, modes }
}
