// The checklist registry: every check of the three test-validity checklists by kind and id, with its title, severity,
// citations and whether its numbers are engineering judgement. Shared ids (time-base, sample-rate, throttle-fixed,
// trim-fixed, configuration-constant, weather, envelope, ...) compute the same thing in every checklist; only the
// thresholds are each test's.

import { DYNAMIC_DEFS } from './dynamic'
import { PERFORMANCE_DEFS } from './performance'
import { STATIC_DEFS } from './staticStability'
import type { CheckDef, ChecklistKind } from './types'

export const CHECKLISTS: Readonly<Record<ChecklistKind, { title: string; defs: readonly CheckDef[] }>> = {
  dynamic: { title: 'Dynamic modes', defs: DYNAMIC_DEFS },
  static: { title: 'Static stability — trim curve', defs: STATIC_DEFS },
  performance: { title: 'Performance — range & endurance', defs: PERFORMANCE_DEFS },
}

/** A check's definition, or undefined. */
export function checkDef(kind: ChecklistKind, id: string): CheckDef | undefined {
  return CHECKLISTS[kind].defs.find((d) => d.id === id)
}

/** The ids every checklist has (shared checks). */
export function sharedIds(): string[] {
  const sets = (Object.keys(CHECKLISTS) as ChecklistKind[]).map((k) => new Set(CHECKLISTS[k].defs.map((d) => d.id)))
  return [...sets[0]].filter((id) => sets.every((s) => s.has(id)))
}
