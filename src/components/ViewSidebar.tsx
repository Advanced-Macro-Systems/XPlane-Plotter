// A view's sidebar (channel list, plot settings). On a phone it folds away behind one button, closed at first, so the
// plot comes first and the page is not split into two small scroll areas; tablets and desktops always show it. Folded
// content stays mounted (hidden), so searches and open sections survive.

import { ChevronDownIcon } from '@primer/octicons-react'
import { useId, useState, type ReactNode } from 'react'
import { PHONE_QUERY, useMediaQuery } from './hooks'

interface ViewSidebarProps {
  /** The view's own class (`tv-sidebar`, `xy-sidebar` …), next to `view-sidebar` */
  className: string
  /** The sidebar's name for assistive tech, and the fold button's text on a phone */
  label: string
  children: ReactNode
}

export function ViewSidebar({ className, label, children }: ViewSidebarProps) {
  const phone = useMediaQuery(PHONE_QUERY)
  const [open, setOpen] = useState(false)
  const folded = phone && !open
  const contentId = useId()
  return (
    <aside className={`view-sidebar ${className}`} aria-label={label} data-folded={folded || undefined}>
      {phone && (
        <button
          type="button"
          className="view-sidebar-fold"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{label}</span>
          <ChevronDownIcon size={16} className="view-sidebar-fold-icon" />
        </button>
      )}
      <div id={contentId} className="view-sidebar-content" hidden={folded}>
        {children}
      </div>
    </aside>
  )
}
