import type { ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

/**
 * A row of mutually exclusive buttons (styles: .segmented in global.css). `disabled` turns the whole control off when
 * it does not apply (e.g. X–Y "Fit through" without a fit): it still shows its choice, muted, without the "on" colours.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
  title,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  testId?: string
  disabled?: boolean
  /** Shown on the whole control, e.g. why it is off */
  title?: string
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      title={title}
      data-testid={testId}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="segmented-option"
          title={disabled ? undefined : o.title}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
