// One way to write a time range everywhere (selection bar, visible range, tab-bar chips, dialogs, tables): the two ends
// to the same precision, then the unit once — "120.4 – 132.7 s", "09:15:15 – 09:15:27", "rows 1200–1322". Pure.

import { MINUS } from '../charts/format'
import { formatClock } from '../core/time'
import type { TimeAxis } from '../core/types'

function withMinus(text: string): string {
  return text.replace(/-/g, MINUS)
}

/** Two axis values as a range: "120.4 – 132.7 s", "1.23 – 3.46 s", "rows 1200–1322", "14:30:00 – 14:30:12". */
export function formatTimeRange(axis: Pick<TimeAxis, 'id' | 'unit' | 'clock'>, from: number, to: number): string {
  if (axis.clock) return `${formatClock(from)} – ${formatClock(to)}`
  if (axis.id === 'index') return `rows ${Math.round(from)}–${Math.round(to)}`
  const span = Math.abs(to - from)
  const decimals = axis.unit === 'h' ? 4 : span >= 10 ? 1 : span >= 1 ? 2 : 3
  const a = withMinus(from.toFixed(decimals))
  const b = withMinus(to.toFixed(decimals))
  return axis.unit ? `${a} – ${b} ${axis.unit}` : `${a} – ${b}`
}
