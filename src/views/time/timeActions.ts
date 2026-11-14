// Store actions of the Time-history view that come with an Undo in their toast.

import type { Workspace } from '../../core/types'
import { removePanel, setPanels, toast, useApp } from '../../store/app'
import { newId } from '../../store/defaults'
import { presetPanels, type ResolvedPreset } from './presets'

/** Most panels in the stack (each one is its own chart). */
export const MAX_PANELS = 12

/** Replaces the panels with a preset's; returns the first new panel's id (null when the log has none of it). */
export function applyPreset(resolved: ResolvedPreset, ws: Workspace): string | null {
  const previous = ws.panels
  const panels = presetPanels(resolved.panels, () => newId('p'))
  if (!panels.length) return null
  const datasetId = useApp.getState().activeId
  setPanels(panels)
  toast(`${resolved.preset.name}: ${panels.length} panel${panels.length === 1 ? '' : 's'}.`, 'success', {
    label: 'Undo',
    run: () => {
      if (useApp.getState().activeId === datasetId) setPanels(previous)
    },
  })
  return panels[0].id
}

/** Removes a panel, with an Undo in the toast. */
export function removePanelWithUndo(panelId: string, message = 'Removed the panel.'): void {
  const state = useApp.getState()
  const datasetId = state.activeId
  const previous = datasetId ? state.workspaces[datasetId]?.panels : undefined
  removePanel(panelId)
  if (!previous) return
  toast(message, 'info', {
    label: 'Undo',
    run: () => {
      if (useApp.getState().activeId === datasetId) setPanels(previous)
    },
  })
}
