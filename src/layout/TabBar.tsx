// The tab bar (after the Bristol FSAI Board's): icon + name, a red line under the open tab, counts on Test points and
// Channels; on the right, chips for the shared zoom range and drag selection, each with × to clear it. On a narrow
// screen the tabs scroll sideways (faded at the edge with more tabs) and the open tab is kept in sight.

import { XIcon, ZoomInIcon } from '@primer/octicons-react'
import { useEffect, useRef, useState } from 'react'
import { rangeText, useTimeAxis } from '../components/hooks'
import type { RowRange, TabId } from '../core/types'
import { setSelection, setTab, setView, useActiveDataset, useApp } from '../store/app'
import { TAB_ICONS } from './tabIcons'
import {
  compactSpan,
  fadeEdges,
  formatCount,
  scrollToReveal,
  splitRangeText,
  TAB_NAMES,
  TAB_ORDER,
  type FadeEdges,
} from './shellModel'

/** Room kept beside the open tab when it is scrolled into sight (about the width of the edge fade). */
const REVEAL_MARGIN = 40

export function TabBar() {
  const tab = useApp((s) => s.tab)
  const points = useApp((s) => (s.activeId ? (s.workspaces[s.activeId]?.points.length ?? 0) : 0))
  const channels = useApp((s) => s.datasets.find((d) => d.id === s.activeId)?.channels.length ?? 0)
  const counts: Partial<Record<TabId, number>> = { points, channels }
  const navRef = useRef<HTMLElement>(null)
  const [fade, setFade] = useState<FadeEdges>(null)

  // Which edges hide tabs: follows scrolling and resizing.
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const update = () => setFade(fadeEdges(nav.scrollLeft, nav.clientWidth, nav.scrollWidth))
    update()
    nav.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(nav)
    return () => {
      nav.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [])

  // The open tab stays in sight (e.g. after pressing 6 on a phone); a count badge changing width re-checks the fade.
  useEffect(() => {
    const nav = navRef.current
    const active = nav?.querySelector<HTMLElement>('.sh-tab-active')
    if (!nav) return
    if (active) {
      const left = scrollToReveal(active.offsetLeft, active.offsetWidth, nav.scrollLeft, nav.clientWidth, REVEAL_MARGIN)
      if (left !== null) nav.scrollTo({ left })
    }
    setFade(fadeEdges(nav.scrollLeft, nav.clientWidth, nav.scrollWidth))
  }, [tab, points, channels])

  return (
    <div className="sh-bar">
      <nav ref={navRef} className="sh-tabs" aria-label="Views" data-fade={fade ?? undefined}>
        {TAB_ORDER.map((id, index) => {
          const Icon = TAB_ICONS[id]
          const active = id === tab
          const count = counts[id]
          return (
            <button
              key={id}
              type="button"
              className={`sh-tab${active ? ' sh-tab-active' : ''}`}
              data-testid={`tab-${id}`}
              aria-current={active ? 'page' : undefined}
              title={`${TAB_NAMES[id]} (${index + 1})`}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              <span className="sh-tab-name">{TAB_NAMES[id]}</span>
              {count !== undefined && count > 0 && <span className="badge badge-count sh-tab-count">{formatCount(count)}</span>}
            </button>
          )
        })}
      </nav>
      <RangeChips />
    </div>
  )
}

/** "Zoom 120.0 – 340.5 s ×" and "Selection 12.3 s ×" on the time axis the Time history uses. */
function RangeChips() {
  const ds = useActiveDataset()
  const axis = useTimeAxis()
  const view = useApp((s) => s.view)
  const selection = useApp((s) => s.selection)
  if (!ds || !axis || (!view && !selection)) return null

  const text = (range: RowRange) => {
    const full = rangeText(ds, axis, range)
    return { full, ...splitRangeText(full) }
  }
  const zoom = view ? text(view) : null
  const selected = selection ? text(selection) : null

  return (
    <div className="sh-ranges" role="group" aria-label="Current zoom and selection">
      {zoom && (
        <span className="sh-range" title={`Zoom range: ${zoom.full}`}>
          <ZoomInIcon className="sh-range-icon" size={14} />
          <span className="sh-range-label">Zoom</span>
          <span className="sh-range-value">{compactSpan(zoom.span)}</span>
          <button type="button" className="sh-range-clear" aria-label="Clear the zoom" title="Show the whole file" onClick={() => setView(null)}>
            <XIcon size={14} />
          </button>
        </span>
      )}
      {selected && (
        <span className="sh-range" title={`Selection: ${selected.full}`}>
          <span className="sh-range-swatch" aria-hidden="true" />
          <span className="sh-range-label">Selection</span>
          <span className="sh-range-value">{selected.duration || compactSpan(selected.span)}</span>
          <button type="button" className="sh-range-clear" aria-label="Clear the selection" title="Clear the selection" onClick={() => setSelection(null)}>
            <XIcon size={14} />
          </button>
        </span>
      )}
    </div>
  )
}
