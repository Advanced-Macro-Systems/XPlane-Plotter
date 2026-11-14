// Defaults for the "Save test point" dialog. Pure: unit-tested in pointDraft.test.ts. (The suggested name is shared
// with Test points' "Add from selection": suggestPointName in views/points/pointsModel.ts.)

import type { PointGroup } from '../../core/types'

/** The group a new point goes in: the one used last when it still exists, else the first. */
export function defaultGroupId(groups: readonly PointGroup[], remembered: string | undefined): string {
  return groups.some((g) => g.id === remembered) ? (remembered as string) : (groups[0]?.id ?? '')
}
