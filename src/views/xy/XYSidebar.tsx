// The X–Y plot settings: a preset, the axes, which rows (and which test-point groups), how samples are drawn and
// coloured, the fit, and the labels. Every change goes through setXY.

import { ArrowSwitchIcon, ChevronDownIcon, InfoIcon, AlertIcon, XIcon } from '@primer/octicons-react'
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react'
import { ChannelPicker } from '../../components/ChannelPicker'
import { Segmented } from '../../components/Segmented'
import { ViewSidebar } from '../../components/ViewSidebar'
import { channelTitle } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { sanitizeSlots } from '../../core/slots'
import type { Dataset, RowRange, Workspace, XYConfig } from '../../core/types'
import { setXY } from '../../store/app'
import { Dropdown } from '../../ui/Dropdown'
import { MarkerGlyph } from './Glyphs'
import {
  FIT_OPTIONS,
  STYLE_OPTIONS,
  colorOptions,
  fitTargetOptions,
  sourceOptions,
  toggleGroupFilter,
  visiblePointCounts,
} from './xyControls'
import { MAX_Y, unitMismatch, type MarkerShape, type XYData, type XYLabels } from './xyModel'
import { availablePresets, matchingPreset, type ResolvedPreset } from './xyPresets'

/**
 * Width of the sidebar's popups (presets, channel pickers): the sidebar's inner width (--sidebar-w 300 px less its
 * 16 px padding each side). A wider popup is cut off by the sidebar, whose scrolling also shifts it sideways.
 */
const POPUP_WIDTH = 268

interface XYSidebarProps {
  ds: Dataset
  ws: Workspace
  view: RowRange | null
  data: XYData
  defaults: XYLabels
}

export function XYSidebar({ ds, ws, view, data, defaults }: XYSidebarProps) {
  const xy = ws.xy
  const effective = data.effective
  const withPoints = effective.source === 'points'
  const presets = useMemo(() => availablePresets(ds, ws), [ds, ws])
  const active = matchingPreset(presets, xy)
  // Each Y channel's chip in its stored colour slot, as in the plot and its legend.
  const ySlots = sanitizeSlots(xy.ySlots, xy.ys.length)
  const ys = xy.ys.flatMap((id, index) => {
    const ch = channelById(ds, id)
    return ch ? [{ id, ch, slot: ySlots[index] }] : []
  })
  const mismatch = unitMismatch(ys.map((y) => y.ch))
  const shapes = new Map<string, MarkerShape>(data.series.map((s) => [s.y.ch.id, s.shape]))
  const counts = visiblePointCounts(ws)
  const allGroupIds = ws.groups.map((g) => g.id)
  const xId = xy.x

  return (
    <ViewSidebar className="xy-sidebar" label="Plot settings">
      <section className="view-sidebar-section">
        <h3 className="eyebrow">Preset</h3>
        {presets.length ? (
          <PresetMenu presets={presets} active={active} />
        ) : (
          <p className="xy-note">No preset fits this file’s channels: choose the axes below.</p>
        )}
      </section>

      <section className="view-sidebar-section">
        <h3 className="eyebrow">Axes</h3>
        <div className="field">
          <div className="xy-field-head">
            <span className="field-label">X axis</span>
            {xId && ys.length === 1 && (
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                title="Swap the X and Y channels"
                onClick={() => setXY({ x: ys[0].id, ys: [xId] })}
              >
                <ArrowSwitchIcon size={12} /> Swap
              </button>
            )}
          </div>
          <div data-testid="xy-x-picker" className="xy-picker">
            <ChannelPicker
              dataset={ds}
              value={xId ? [xId] : []}
              onChange={(ids) => setXY({ x: ids[0] ?? null })}
              ariaLabel="X-axis channel"
              placeholder="Choose the X channel"
              width={POPUP_WIDTH}
            />
          </div>
        </div>
        <div className="field">
          <div className="xy-field-head">
            <span className="field-label">Y axis</span>
            <span className="xy-count">
              {ys.length}/{MAX_Y}
            </span>
          </div>
          {ys.length > 0 && (
            <ul className="xy-ychips" aria-label="Y channels">
              {ys.map(({ id, ch, slot }) => (
                <li key={id} className="series-chip xy-ychip" title={ch.meta.label}>
                  <MarkerGlyph
                    shape={shapes.get(id) ?? 'circle'}
                    slot={effective.colorBy === 'series' ? slot : null}
                  />
                  <span className="series-chip-name">{ch.meta.short}</span>
                  {ch.meta.unit && <span className="series-chip-unit">{ch.meta.unit}</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${channelTitle(ch)}`}
                    title="Remove"
                    onClick={() => setXY({ ys: xy.ys.filter((y) => y !== id) })}
                  >
                    <XIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div data-testid="xy-y-picker" className="xy-picker">
            <ChannelPicker
              dataset={ds}
              value={xy.ys}
              multiple
              max={MAX_Y}
              onChange={(ids) => setXY({ ys: ids })}
              ariaLabel="Y-axis channels"
              width={POPUP_WIDTH}
              label={
                <span className="cp-button-text">
                  {ys.length ? 'Add or remove Y channels' : <span className="subtle">Choose Y channels</span>}
                </span>
              }
            />
          </div>
          {mismatch && (
            <div className="callout callout-warning xy-callout" role="note">
              <AlertIcon size={14} />
              <span>{mismatch}</span>
            </div>
          )}
        </div>
      </section>

      <section className="view-sidebar-section">
        <h3 className="eyebrow">Data</h3>
        <div className="xy-seg">
          <Segmented
            value={xy.source}
            options={sourceOptions(view, ws)}
            onChange={(source) => setXY({ source })}
            ariaLabel="Which rows to plot"
            testId="xy-source"
          />
        </div>
        {effective.sourceNote && (
          <p className="xy-note">
            <InfoIcon size={12} /> {effective.sourceNote}
          </p>
        )}
        {withPoints && (
          <div className="xy-groups" role="group" aria-label="Test-point groups to plot">
            {ws.groups.map((g) => {
              const on = effective.groupIds.includes(g.id)
              const n = counts.get(g.id) ?? 0
              return (
                <button
                  key={g.id}
                  type="button"
                  className={`chip chip-md xy-group-chip slot-${g.slot}`}
                  aria-pressed={on}
                  title={on ? `Hide ${g.name}` : `Show ${g.name}`}
                  onClick={() => setXY({ groups: toggleGroupFilter(allGroupIds, xy.groups, g.id) })}
                >
                  <span className="chip-dot" aria-hidden="true" />
                  <span className="xy-group-name">{g.name}</span>
                  <span className="xy-group-count">{n}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="view-sidebar-section">
        <h3 className="eyebrow">Display</h3>
        <div className="field">
          <span className="field-label">Draw samples as</span>
          <div className="xy-seg">
            <Segmented value={xy.style} options={STYLE_OPTIONS} onChange={(style) => setXY({ style })} ariaLabel="Draw samples as" />
          </div>
        </div>
        <div className="field">
          <span className="field-label">Colour by</span>
          <div className="xy-seg">
            <Segmented
              value={effective.colorBy}
              options={colorOptions(withPoints)}
              onChange={(colorBy) => setXY({ colorBy })}
              ariaLabel="Colour by"
            />
          </div>
        </div>
        <div className="xy-checks">
          <label className="check">
            <input type="checkbox" checked={xy.showSamples} onChange={(e) => setXY({ showSamples: e.target.checked })} />
            Show samples
          </label>
          <label className={`check${withPoints ? '' : ' xy-check-off'}`} title={withPoints ? undefined : 'Needs the Test points source'}>
            <input
              type="checkbox"
              checked={effective.showMeans}
              disabled={!withPoints}
              onChange={(e) => setXY({ showMeans: e.target.checked })}
            />
            Show means (± 1σ)
          </label>
        </div>
      </section>

      <section className="view-sidebar-section">
        <h3 className="eyebrow">Fit</h3>
        <div className="xy-seg">
          <Segmented value={xy.fit} options={FIT_OPTIONS} onChange={(fit) => setXY({ fit })} ariaLabel="Fit" testId="xy-fit" />
        </div>
        <div className={`field${xy.fit === 'none' ? ' xy-field-off' : ''}`}>
          <span className="field-label">Fit through</span>
          <div className="xy-seg">
            <Segmented
              value={effective.fitTarget}
              options={fitTargetOptions(withPoints)}
              onChange={(fitTarget) => setXY({ fitTarget })}
              ariaLabel="Fit through"
              disabled={xy.fit === 'none'}
              title={xy.fit === 'none' ? 'Choose a fit first' : undefined}
              testId="xy-fit-target"
            />
          </div>
        </div>
      </section>

      <section className="view-sidebar-section">
        <h3 className="eyebrow">Labels</h3>
        <LabelField label="Title" value={xy.title} placeholder={defaults.title || 'Plot title'} onCommit={(title) => setXY({ title })} />
        <LabelField label="X label" value={xy.xLabel} placeholder={defaults.x} onCommit={(xLabel) => setXY({ xLabel })} />
        <LabelField label="Y label" value={xy.yLabel} placeholder={defaults.y} onCommit={(yLabel) => setXY({ yLabel })} />
        <p className="xy-note">Empty labels follow the channels. The title appears on exported figures.</p>
      </section>
    </ViewSidebar>
  )
}

const SECTIONS: ResolvedPreset['section'][] = ['Stability', 'Aerodynamics', 'Performance', 'Navigation']

function PresetMenu({ presets, active }: { presets: readonly ResolvedPreset[]; active: ResolvedPreset | null }) {
  return (
    <Dropdown
      label={
        <>
          <span className="cp-button-text">{active ? active.name : <span className="subtle">Custom plot: choose a preset…</span>}</span>
          <ChevronDownIcon className="cp-chevron" size={16} />
        </>
      }
      buttonClassName="cp-button"
      ariaLabel="Plot preset"
      title={active?.hint}
      width={POPUP_WIDTH}
    >
      {(close) => (
        <div role="menu" aria-label="Plot presets">
          {SECTIONS.map((section) => {
            const items = presets.filter((p) => p.section === section)
            if (!items.length) return null
            return (
              <div key={section} role="group" aria-label={section}>
                <p className="menu-heading" aria-hidden="true">
                  {section}
                </p>
                {items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    className="menu-item menu-item-stack xy-preset-item"
                    aria-current={p.id === active?.id ? 'true' : undefined}
                    onClick={() => {
                      setXY(p.config)
                      close()
                    }}
                  >
                    <span>{p.name}</span>
                    <small>{p.hint}</small>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </Dropdown>
  )
}

/** A label override: typed freely, saved after a pause, on Enter or on leaving the field. */
function LabelField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  value: XYConfig['title']
  placeholder: string
  onCommit: (text: string) => void
}) {
  const id = useId()
  const [text, setText] = useState(value)
  const [shown, setShown] = useState(value)
  // The saved value changed elsewhere (a preset resets the labels): show it.
  if (value !== shown) {
    setShown(value)
    setText(value)
  }
  const timer = useRef(0)
  /** Typed but not saved yet */
  const pending = useRef<string | null>(null)
  const commit = (next: string) => {
    window.clearTimeout(timer.current)
    pending.current = null
    if (next !== value) onCommit(next)
  }
  // Leaving the tab right after typing still saves the text.
  const flushOnLeave = useEffectEvent(() => {
    if (pending.current !== null) commit(pending.current)
  })
  useEffect(() => () => flushOnLeave(), [])
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input input-sm"
        value={text}
        placeholder={placeholder}
        maxLength={label === 'Title' ? 160 : 120}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          pending.current = next
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => {
            pending.current = null
            onCommit(next)
          }, 350)
        }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(text)
        }}
      />
    </div>
  )
}
