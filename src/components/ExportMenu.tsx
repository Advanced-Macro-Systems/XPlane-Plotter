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

/** "Export ▾" button with a menu of export actions (PNG, SVG, CSV, MATLAB, session ...). */
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
        <div data-testid={testId}>
          {items.map((item, i) => (
            <div key={`${item.label}-${i}`}>
              {item.section && <p className="menu-heading">{item.section}</p>}
              <button
                type="button"
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
            </div>
          ))}
        </div>
      )}
    </Dropdown>
  )
}
