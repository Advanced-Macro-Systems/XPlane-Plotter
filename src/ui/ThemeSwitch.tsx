// A light/dark toggle switch (sun and moon). It sets an explicit choice; "match device" is in the settings menu.

import { MoonIcon, SunIcon } from '@primer/octicons-react'
import { setThemeChoice, useShownTheme } from '../lib/theme'

export function ThemeSwitch({ className }: { className?: string }) {
  const dark = useShownTheme() === 'dark'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={className ? `theme-switch ${className}` : 'theme-switch'}
      onClick={() => setThemeChoice(dark ? 'light' : 'dark')}
    >
      <span className="theme-switch-icon theme-switch-sun" aria-hidden="true">
        <SunIcon size={14} />
      </span>
      <span className="theme-switch-icon theme-switch-moon" aria-hidden="true">
        <MoonIcon size={14} />
      </span>
      <span className="theme-switch-knob" aria-hidden="true" />
    </button>
  )
}
