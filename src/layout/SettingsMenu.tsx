// Settings (gear) menu: theme (light / dark / match device), the open file's session file, keyboard shortcuts.

import { DeviceDesktopIcon, DownloadIcon, GearIcon, KeyAsteriskIcon, MoonIcon, SunIcon, UploadIcon } from '@primer/octicons-react'
import { useRef } from 'react'
import { setThemeChoice, useThemeChoice, type ThemeChoice } from '../lib/theme'
import { useApp } from '../store/app'
import { Dropdown } from '../ui/Dropdown'
import { loadSessionFile, saveSessionFile } from './fileActions'

const THEMES: { value: ThemeChoice; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'Match device', Icon: DeviceDesktopIcon },
]

export function SettingsMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const choice = useThemeChoice()
  const hasFile = useApp((s) => s.activeId !== null)
  const sessionInput = useRef<HTMLInputElement>(null)

  return (
    <>
      <Dropdown
        label={<GearIcon />}
        ariaLabel="Settings"
        title="Settings"
        buttonClassName="btn btn-ghost btn-icon"
        align="right"
        width={312}
        haspopup="dialog"
      >
        {(close) => (
          <div className="sh-settings">
            <p className="menu-heading">Theme</p>
            <div className="sh-theme" role="group" aria-label="Theme">
              {THEMES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  className="sh-theme-option"
                  aria-pressed={choice === value}
                  onClick={() => setThemeChoice(value)}
                >
                  <Icon size={14} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {hasFile && (
              <>
                <div className="menu-divider" />
                <p className="menu-heading">Session</p>
                <button
                  type="button"
                  className="menu-item sh-settings-item"
                  onClick={() => {
                    close()
                    saveSessionFile()
                  }}
                >
                  <DownloadIcon size={16} />
                  <span className="sh-settings-text">
                    <span>Save session file</span>
                    <small>Test points, panels, formulas and plot settings, as .json</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="menu-item sh-settings-item"
                  onClick={() => {
                    close()
                    sessionInput.current?.click()
                  }}
                >
                  <UploadIcon size={16} />
                  <span className="sh-settings-text">
                    <span>Load session file…</span>
                    <small>Bring back a workspace saved on another computer</small>
                  </span>
                </button>
              </>
            )}
            <div className="menu-divider" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close()
                onShortcuts()
              }}
            >
              <KeyAsteriskIcon size={16} />
              <span>Keyboard shortcuts</span>
            </button>
          </div>
        )}
      </Dropdown>
      <input
        ref={sessionInput}
        type="file"
        hidden
        accept=".json,application/json"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void loadSessionFile(file)
        }}
      />
    </>
  )
}
