// Time-history sidebar: every channel of the log (a click adds it to the active panel when it shares the panel's unit,
// otherwise opens a new panel; Shift+click or "New panel" always opens one; a ticked channel is plotted already and a
// click removes it), then the presets for each kind of flight test.

import { PlusIcon } from '@primer/octicons-react'
import { useMemo, useRef, useState } from 'react'
import { ChannelList } from '../../components/ChannelPicker'
import { channelById } from '../../core/dataset'
import type { Dataset, Workspace } from '../../core/types'
import { setPanels, toast } from '../../store/app'
import { MAX_SERIES, newId } from '../../store/defaults'
import { pickChannel, plottedIds, type PickResult } from './panelEdit'
import { resolvePresets, type ResolvedPreset } from './presets'
import { MAX_PANELS, applyPreset } from './timeActions'

interface TimeSidebarProps {
  ds: Dataset
  ws: Workspace
  activePanelId: string | null
  /** After a pick changed the stack: the panel to make active and show */
  onPicked: (result: PickResult) => void
  onPreset: (firstPanelId: string | null) => void
}

export function TimeSidebar({ ds, ws, activePanelId, onPicked, onPreset }: TimeSidebarProps) {
  const plotted = useMemo(() => plottedIds(ws.panels), [ws.panels])
  const [newPanel, setNewPanel] = useState(false)
  const shift = useRef(false)

  const pick = (id: string) => {
    const result = pickChannel(ws.panels, activePanelId, id, {
      newPanel: newPanel || shift.current,
      unitOf: (channelId) => channelById(ds, channelId)?.meta.unit ?? null,
      makeId: () => newId('p'),
      maxSeries: MAX_SERIES,
      maxPanels: MAX_PANELS,
    })
    shift.current = false
    if (result.change === 'limit') {
      toast(`The stack holds at most ${MAX_PANELS} panels: remove one before adding another.`, 'info')
      return
    }
    if (result.change === 'none') return
    setPanels(result.panels)
    if (result.change === 'created') setNewPanel(false)
    onPicked(result)
  }

  return (
    <aside className="view-sidebar tv-sidebar" aria-label="Channels and presets">
      <section className="tv-side-channels" aria-labelledby="tv-channels-title">
        <div className="tv-side-head">
          <h2 id="tv-channels-title" className="eyebrow">
            Channels
          </h2>
          <button
            type="button"
            className="btn btn-xs btn-ghost tv-new-panel"
            aria-pressed={newPanel}
            title="The next channel you pick opens a new panel (or Shift+click a channel)"
            onClick={() => setNewPanel((on) => !on)}
          >
            <PlusIcon size={14} />
            New panel
          </button>
        </div>
        <p className="tv-side-hint">
          {newPanel
            ? 'Pick a channel to open it in a new panel.'
            : 'Click adds to the active panel (another unit gets its own). Shift+click opens a new panel.'}
        </p>
        <div
          className="tv-channel-list"
          onClickCapture={(event) => {
            shift.current = event.shiftKey
          }}
          onKeyDownCapture={(event) => {
            if (event.key === 'Enter') shift.current = event.shiftKey
          }}
        >
          <ChannelList dataset={ds} selected={plotted} multiple onPick={pick} maxHeight={100_000} />
        </div>
      </section>
      <Presets ds={ds} ws={ws} onPreset={onPreset} />
    </aside>
  )
}

function Presets({ ds, ws, onPreset }: { ds: Dataset; ws: Workspace; onPreset: (firstPanelId: string | null) => void }) {
  const presets = useMemo(() => resolvePresets(ds), [ds])
  return (
    <section className="tv-presets" aria-labelledby="tv-presets-title">
      <h2 id="tv-presets-title" className="eyebrow">
        Presets
      </h2>
      <div className="tv-preset-list">
        {presets.map((resolved) => (
          <PresetButton key={resolved.preset.id} resolved={resolved} ws={ws} onPreset={onPreset} />
        ))}
      </div>
    </section>
  )
}

export function PresetButton({
  resolved,
  ws,
  onPreset,
}: {
  resolved: ResolvedPreset
  ws: Workspace
  onPreset: (firstPanelId: string | null) => void
}) {
  const count = resolved.panels.length
  const missing = count === 0
  return (
    <button
      type="button"
      className="tv-preset"
      disabled={missing}
      title={
        missing
          ? `${resolved.preset.description}. This log has none of these channels.`
          : `${resolved.preset.description}.\nIn this log: ${resolved.summary}`
      }
      onClick={() => onPreset(applyPreset(resolved, ws))}
    >
      <span className="tv-preset-name">{resolved.preset.name}</span>
      <span className="tv-preset-count">{missing ? 'none in log' : `${count} panel${count === 1 ? '' : 's'}`}</span>
    </button>
  )
}
