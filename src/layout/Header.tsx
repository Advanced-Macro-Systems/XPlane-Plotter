// Header: the app mark and name, the open-file switcher, "Open file", help, settings and the theme switch; under it
// the tab bar (only while a file is open).

import { QuestionIcon, UploadIcon } from '@primer/octicons-react'
import { useApp } from '../store/app'
import { ThemeSwitch } from '../ui/ThemeSwitch'
import { DatasetSwitcher } from './DatasetSwitcher'
import { openFilePicker } from './filePicker'
import { LogoMark } from './LogoMark'
import { SettingsMenu } from './SettingsMenu'
import type { HelpSection } from './shellModel'
import { TabBar } from './TabBar'
import { commandKey } from './platform'

export function Header({ onHelp }: { onHelp: (section?: HelpSection) => void }) {
  const hasFiles = useApp((s) => s.datasets.length > 0)
  const hasActive = useApp((s) => s.activeId !== null && s.datasets.some((d) => d.id === s.activeId))

  return (
    <header className="sh-header">
      <div className="sh-top">
        <div className="sh-brand">
          <LogoMark className="sh-logo" />
          <span className="sh-title">X-Plane Plotter</span>
          {hasFiles && (
            <>
              <span className="sh-crumb" aria-hidden="true">
                /
              </span>
              <DatasetSwitcher />
            </>
          )}
        </div>
        <div className="sh-actions">
          <button
            type="button"
            className="btn btn-primary sh-open"
            data-testid="open-button"
            aria-label="Open file"
            title={`Open a flight log (${commandKey()}+O)`}
            onClick={openFilePicker}
          >
            <UploadIcon />
            <span className="sh-open-label">Open file</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Help"
            title="Help and recording guide (?)"
            onClick={() => onHelp()}
          >
            <QuestionIcon />
          </button>
          <SettingsMenu onShortcuts={() => onHelp('use')} />
          <ThemeSwitch className="sh-theme-switch" />
        </div>
      </div>
      {hasActive && <TabBar />}
    </header>
  )
}
