// The X–Y axis ranges the app shows for a workspace, for MATLAB scripts written away from the X–Y tab (Overview, Test
// points): the script's fit through the samples then leaves out the same off-axis samples (CL of order 10^8 on the
// ground) as the app does. The X–Y tab passes its own ranges (they follow "Show all").

import { timeAxis } from '../../core/time'
import type { Dataset, RowRange, Workspace } from '../../core/types'
import { focusExtent, focusedAxes } from './xyControls'
import { buildXYData } from './xyModel'

export interface XYLimits {
  x: [number, number] | null
  y: [number, number] | null
}

/** The focused axis ranges of the workspace's X–Y plot; null when nothing is plotted or the axes need no focus. */
export function xyAxisLimits(ds: Dataset, ws: Workspace, view: RowRange | null): XYLimits | null {
  const xy = ws.xy
  const data = buildXYData({
    ds,
    xy,
    ws,
    view: xy.source === 'view' ? view : null,
    axis: timeAxis(ds, ws.timeBase),
    lines: false,
  })
  return data.empty ? null : focusedAxes(focusExtent(data), false)
}
