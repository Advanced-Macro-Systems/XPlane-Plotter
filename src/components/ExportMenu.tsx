import { DownloadIcon } from '@primer/octicons-react'
import type { ReactNode } from 'react'
import { Dropdown } from '../ui/Dropdown'

export interface ExportItem {
  label: string
  /** Second line, e.g. "Vector, for reports" */
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  /** Shown as a heading above this item */
  section?: string
  onSelect: () => void | Promise<void>
}

/** Consecutive items under one section heading (the first run has no heading when the first item names none). */
function sections(items: readonly ExportItem[]): { title?: string; items: ExportItem[] }[] {
  const runs: { title?: string; items: ExportItem[] }[] = []
  for (const item of items) {
    if (item.section || runs.length === 0) runs.push({ title: item.section, items: [] })
    runs[runs.length - 1].items.push(item)
  }
  return runs
}

/**
 * "Export ▾" button with a menu of export actions (PNG, SVG, CSV, MATLAB, session ...): a WAI-ARIA menu (↑/↓ move,
 * Esc closes), each section a labelled group.
 */
export function ExportMenu({
  items,
  label = 'Export',
  align = 'right',
  testId,
  disabled,
}: {
  items: ExportItem[]
  label?: string
  align?: 'left' | 'right'
  testId?: string
  disabled?: boolean
}) {
  return (
    <Dropdown
      label={
        <>
          <DownloadIcon size={16} />
          <span>{label}</span>
        </>
      }
      buttonClassName="btn btn-sm btn-outline"
      align={align}
      width={280}
      disabled={disabled}
      ariaLabel={label}
    >
      {(close) => (
        <div role="menu" aria-label={label} data-testid={testId}>
          {sections(items).map((section, s) => (
            <div key={`${section.title ?? ''}-${s}`} role="group" aria-label={section.title}>
              {section.title && (
                <p className="menu-heading" aria-hidden="true">
                  {section.title}
                </p>
              )}
              {section.items.map((item, i) => (
                <button
                  key={`${item.label}-${i}`}
                  type="button"
                  role="menuitem"
                  className="menu-item menu-item-stack"
                  disabled={item.disabled}
                  onClick={() => {
                    close()
                    void item.onSelect()
                  }}
                >
                  <span>{item.label}</span>
                  {item.hint && <small>{item.hint}</small>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </Dropdown>
  )
}
