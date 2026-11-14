// Shows the "add several test points" dialog (Find steady points, Add points from times) that a tab asked for with
// openPointsTool, over whichever tab is open. Its code is a chunk of its own, fetched the first time one opens: the
// start page never loads it. It renders nothing for a file that is no longer the active one.

import { lazy, Suspense } from 'react'
import { useApp } from '../store/app'

const PointsTools = lazy(() => import('../views/points/PointsTools').then((m) => ({ default: m.PointsTools })))

export function PointsToolHost() {
  const tool = useApp((s) => s.pointsTool)
  const activeId = useApp((s) => s.activeId)
  if (!tool || tool.datasetId !== activeId) return null
  return (
    <Suspense fallback={null}>
      <PointsTools kind={tool.kind} datasetId={tool.datasetId} />
    </Suspense>
  )
}
