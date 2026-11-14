// Small legend keys for the X–Y view, drawn like the chart draws them: a marker in its shape, a line key (solid, dashed
// or dotted, as the line it stands for), the fit line and the test-point mean with its ±1σ bars. Colours are CSS values
// (slot tokens follow the theme).

import type { CSSProperties } from 'react'
import { markerPolygon } from '../../charts/options/xy'
import type { LinePattern } from './xyControls'
import type { MarkerShape } from './xyModel'

/** The CSS colour of a categorical slot (0-based), or neutral ink for null. */
export function SlotSwatch({ slot }: { slot: number | null }) {
  return <span className="chip-dot" style={{ background: slotColor(slot) }} aria-hidden="true" />
}

function slotColor(slot: number | null): string {
  return slot === null ? 'var(--text-subtle)' : `var(--series-${(((slot % 8) + 8) % 8) + 1})`
}

export function MarkerGlyph({ shape, slot, size = 10 }: { shape: MarkerShape; slot: number | null; size?: number }) {
  const c = size / 2
  const fill: CSSProperties = { fill: slotColor(slot) }
  return (
    <svg className="xy-glyph" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      {shape === 'circle' ? (
        <circle cx={c} cy={c} r={c - 0.5} style={fill} />
      ) : (
        <polygon
          points={markerPolygon(shape, c, c, size / 2.7)
            .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
            .join(' ')}
          style={fill}
        />
      )}
    </svg>
  )
}

const DASHES: Record<LinePattern, { dasharray?: string; cap: 'round' | 'butt' }> = {
  solid: { cap: 'round' },
  dashed: { dasharray: '3 2', cap: 'butt' },
  // Round caps on near-zero dashes draw dots.
  dotted: { dasharray: '0.01 3.6', cap: 'round' },
}

export function LineGlyph({ slot, pattern = 'solid' }: { slot: number | null; pattern?: LinePattern }) {
  const { dasharray, cap } = DASHES[pattern]
  return (
    <svg className="xy-glyph" width={16} height={10} viewBox="0 0 16 10" aria-hidden="true" focusable="false">
      <line
        x1={pattern === 'dotted' ? 2 : 1}
        y1={5}
        x2={15}
        y2={5}
        style={{ stroke: slotColor(slot), strokeWidth: 2, strokeLinecap: cap, strokeDasharray: dasharray }}
      />
    </svg>
  )
}

/** A mean marker with ±1σ bars, as the chart draws it. */
export function MeanGlyph({ slot }: { slot: number | null }) {
  const ink = slotColor(slot)
  const bar: CSSProperties = { stroke: ink, strokeWidth: 1.25, strokeLinecap: 'round' }
  return (
    <svg className="xy-glyph" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <line x1={2} y1={8} x2={14} y2={8} style={bar} />
      <line x1={8} y1={2} x2={8} y2={14} style={bar} />
      <line x1={2} y1={6} x2={2} y2={10} style={bar} />
      <line x1={14} y1={6} x2={14} y2={10} style={bar} />
      <line x1={6} y1={2} x2={10} y2={2} style={bar} />
      <line x1={6} y1={14} x2={10} y2={14} style={bar} />
      <circle cx={8} cy={8} r={3.6} style={{ fill: ink, stroke: 'var(--chart-surface)', strokeWidth: 1.5 }} />
    </svg>
  )
}
