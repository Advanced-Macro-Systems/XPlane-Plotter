// Global keyboard shortcuts (rules in shellModel.shortcutFor): 1–6 switch tabs, Ctrl/Cmd+O opens a file, ? opens help.

import { useEffect } from 'react'
import { getActiveDataset, setTab } from '../store/app'
import { openFilePicker } from './filePicker'
import { shortcutFor } from './shellModel'

export function useShortcuts(onHelp: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutFor(event, {
        hasDataset: getActiveDataset() !== null,
        dialogOpen: document.querySelector('dialog[open]') !== null,
      })
      if (!action) return
      event.preventDefault()
      if (action.kind === 'open') openFilePicker()
      else if (action.kind === 'help') onHelp()
      else setTab(action.tab)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onHelp])
}
