// Dynamic modes: fits a damped oscillation (phugoid, short period, dutch roll) or a first-order response (roll
// subsidence, spiral) to one channel over a window (the selection, the zoom range or a test point), live, and reads
// out period, damping, natural frequency and time constants. Pure logic lives in modesModel.ts, the chart option in
// charts/options/modes.ts.

import { AlertIcon, CopyIcon, InfoIcon, LightBulbIcon, PulseIcon, ZoomInIcon } from '@primer/octicons-react'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { EChart } from '../../charts/EChart'
import { exportOptionImage } from '../../charts/exportChart'
import { formatNumber } from '../../charts/format'
import { buildModesOption, modesPlotData, type ModesPlotInput } from '../../charts/options/modes'
import { readChartTheme, useChartTheme } from '../../charts/theme'
import { ChannelPicker } from '../../components/ChannelPicker'
import { ExportMenu, type ExportItem } from '../../components/ExportMenu'
import { Segmented } from '../../components/Segmented'
import { rangeText, useTimeAxis } from '../../components/hooks'
import { channelTitle, describeChannel } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { copyText, downloadText, safeFilename } from '../../core/export/download'
import { matlabScript, matlabScriptName } from '../../core/export/matlab'
import { formatDuration } from '../../core/time'
import type { Channel, Dataset, TestPoint, Workspace } from '../../core/types'
import { setModes, setTab, toast, useActiveDataset, useApp, useWorkspace } from '../../store/app'
import {
  MODE_PRESETS,
  crossesSegment,
  figureSubtitle,
  fitCsv,
  fittedCurve,
  interpretFit,
  oscillationEnvelope,
  peakRows,
  presetChannel,
  presetPoint,
  resolveModeRows,
  resultTiles,
  resultsTsv,
  runModeFit,
  sourceKind,
  sourcePointId,
  windowSeries,
  type ModeFit,
  type ModePreset,
  type ModeRows,
  type SourceKind,
  type WindowSeries,
} from './modesModel'
import './modes.css'

export function ModesView() {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  return (
    <div className="view" data-testid="view-modes">
      {ds && ws && <ModesWorkspace ds={ds} ws={ws} />}
    </div>
  )
}

/** A value that follows `value` once it has stopped changing for `ms` (the first value is taken at once). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(settled, value)) return
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

interface FitRequest {
  series: WindowSeries
  model: Workspace['modes']['model']
  detrend: Workspace['modes']['detrend']
}

const FIT_DEBOUNCE_MS = 150
const count = (n: number) => n.toLocaleString('en-GB')

function ModesWorkspace({ ds, ws }: { ds: Dataset; ws: Workspace }) {
  const selection = useApp((s) => s.selection)
  const view = useApp((s) => s.view)
  const axis = useTimeAxis()
  const theme = useChartTheme()
  const modes = ws.modes
  const channel = modes.channelId ? channelById(ds, modes.channelId) : undefined
  const [wholeFile, setWholeFile] = useState(false)
  const [showResiduals, setShowResiduals] = useState(true)

  const resolved = useMemo(
    () => resolveModeRows(modes.source, { selection, view, points: ws.points, rowCount: ds.rowCount, wholeFile }),
    [modes.source, selection, view, ws.points, ds.rowCount, wholeFile],
  )
  const start = resolved.rows ? resolved.rows[0] : -1
  const end = resolved.rows ? resolved.rows[1] : -1
  const series = useMemo(
    () => (channel && start >= 0 ? windowSeries(ds, channel.values, [start, end]) : null),
    [ds, channel, start, end],
  )

  // Fit live, debounced: rapid changes (clicking through sources and models) fit once they settle.
  const request = useMemo<FitRequest | null>(
    () => (series ? { series, model: modes.model, detrend: modes.detrend } : null),
    [series, modes.model, modes.detrend],
  )
  const settled = useSettled(request, FIT_DEBOUNCE_MS)
  const latest = useMemo(() => (settled ? runModeFit(settled.series, settled.model, settled.detrend) : null), [settled])
  const fitting = request !== null && settled !== request
  // The settled fit belongs on screen only if it was made for this very window.
  const result = latest && settled && series && settled.series === series ? latest : null

  const plot = useMemo(
    () => (series && channel ? modesPlotData(plotInput(series, result, channel)) : null),
    [series, result, channel],
  )
  const option = useMemo(
    () => (plot ? buildModesOption(plot, theme, { residuals: showResiduals }) : null),
    [plot, theme, showResiduals],
  )
  const windowName = describeWindow(resolved, modes.source, view === null && wholeFile)

  return (
    <div className="view-split md">
      <ModesSidebar
        ds={ds}
        ws={ws}
        channel={channel}
        resolved={resolved}
        rowsText={resolved.rows && axis ? rangeText(ds, axis, resolved.rows) : null}
      />
      <main className="view-main md-main">
        {!resolved.rows ? (
          <NoRows ds={ds} ws={ws} problem={resolved.problem} onWholeFile={() => setWholeFile(true)} />
        ) : !channel || !series ? (
          <EmptyState
            icon={<PulseIcon size={24} />}
            title="Choose a channel to analyse"
            text="Use a quick pick on the left (Phugoid, Short period, Dutch roll…) or choose any channel."
          />
        ) : (
          <div className="view-body md-body">
            <ModesHeading
              ds={ds}
              ws={ws}
              channel={channel}
              series={series}
              result={result}
              windowName={windowName}
              rowsText={axis ? rangeText(ds, axis, series.rows) : ''}
              plotInput={plot?.input ?? null}
              showResiduals={showResiduals}
            />
            {crossesSegment(ds, series.rows) && (
              <div className="callout callout-warning" role="note">
                <AlertIcon size={16} />
                <span>
                  This window crosses a time reset or recording gap, where the time is joined up: the fit may be wrong.
                  Choose a window inside one continuous run.
                </span>
              </div>
            )}
            <div className="md-layout">
              <section className="chart-card md-chart-card" data-testid="modes-chart" aria-label="Window and fitted model">
                <div className="chart-card-header">
                  <div className="chart-card-title">
                    <span className="md-chart-title">{channelTitle(channel)}</span>
                    {fitting && (
                      <span className="md-fitting" role="status">
                        <span className="spinner" aria-hidden="true" /> Fitting…
                      </span>
                    )}
                  </div>
                  <label className="check md-residual-toggle">
                    <input
                      type="checkbox"
                      checked={showResiduals}
                      onChange={(e) => setShowResiduals(e.target.checked)}
                    />
                    Residuals
                  </label>
                </div>
                <Legend channel={channel} result={result} residuals={showResiduals} />
                {option && (
                  <EChart
                    option={option}
                    notMerge
                    className="md-plot"
                    style={{ height: showResiduals && plot?.residual ? 420 : 340 }}
                    ariaLabel={`${channelTitle(channel)} over ${windowName} (${formatDuration(series.durationS)}) with the fitted ${
                      modes.model === 'oscillation' ? 'damped oscillation' : 'first-order response'
                    }`}
                  />
                )}
              </section>
              <Results
                result={result ?? latest}
                stale={fitting || (latest !== null && result === null)}
                channel={channel}
                point={resolved.point}
                groups={ws.groups}
                series={series}
              />
            </div>
            {result?.model === 'oscillation' && result.fit.ok && result.fit.peaks.length > 0 && (
              <PeaksTable result={result} series={series} unit={channel.meta.unit} />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function plotInput(series: WindowSeries, result: ModeFit | null, ch: Channel): ModesPlotInput {
  const ok = result?.fit.ok ?? false
  return {
    t: series.t,
    y: series.y,
    fitted: result ? fittedCurve(result) : null,
    fitOk: ok,
    envelope: result?.model === 'oscillation' && ok ? oscillationEnvelope(series.t, result.fit) : null,
    peaks: result?.model === 'oscillation' && ok ? result.fit.peaks : [],
    firstOrder:
      result?.model === 'first-order' ? { tau: result.fit.tau, t0: result.fit.t0, offset: result.fit.offset } : null,
    name: ch.meta.short,
    yTitle: channelTitle(ch),
    t0Elapsed: series.t0,
  }
}

function describeWindow(resolved: ModeRows, source: Workspace['modes']['source'], whole: boolean): string {
  if (resolved.point) return resolved.point.name
  if (source === 'view') return whole ? 'Whole file' : 'Zoom range'
  return 'Selection'
}

// ------------------------------------------------------------------------------------------------ sidebar

function ModesSidebar({
  ds,
  ws,
  channel,
  resolved,
  rowsText,
}: {
  ds: Dataset
  ws: Workspace
  channel: Channel | undefined
  resolved: ModeRows
  rowsText: string | null
}) {
  const modes = ws.modes
  const kind = sourceKind(modes.source)
  const pointId = sourcePointId(modes.source)
  const [lastPoint, setLastPoint] = useState<string | null>(null)

  const applyPreset = (preset: ModePreset) => {
    const id = presetChannel(ds, preset)
    if (!id) return
    const source = presetPoint(ws.points, preset, modes.source)
    setModes({ channelId: id, model: preset.model, ...(source ? { source } : {}) })
  }

  const chooseKind = (next: SourceKind) => {
    if (next !== 'point') {
      setModes({ source: next })
      return
    }
    const target = ws.points.find((p) => p.id === (pointId ?? lastPoint)) ?? ws.points.at(-1)
    if (target) setModes({ source: `point:${target.id}` })
  }

  return (
    <aside className="view-sidebar md-sidebar" aria-label="Mode analysis settings">
      <section className="view-sidebar-section">
        <h3 className="eyebrow">Quick pick</h3>
        <div className="md-presets">
          {MODE_PRESETS.map((preset) => {
            const id = presetChannel(ds, preset)
            const active = !!id && id === modes.channelId && preset.model === modes.model
            return (
              <button
                key={preset.id}
                type="button"
                className="md-preset"
                aria-pressed={active}
                disabled={!id}
                title={id ? preset.hint : missingPresetText(preset)}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
      </section>

      <section className="view-sidebar-section">
        <span className="field-label">Channel</span>
        <div className="md-channel" data-testid="modes-channel-picker">
          <ChannelPicker
            dataset={ds}
            value={channel ? [channel.id] : []}
            onChange={(ids) => setModes({ channelId: ids[0] ?? null })}
            ariaLabel="Channel to analyse"
            placeholder="Choose a channel"
            width={268}
          />
        </div>
      </section>

      <section className="view-sidebar-section" data-testid="modes-source">
        <span className="field-label">Window</span>
        <Segmented<SourceKind>
          value={kind}
          ariaLabel="Rows to analyse"
          onChange={chooseKind}
          options={[
            { value: 'selection', label: 'Selection', title: 'The window you dragged in Time history (Select mode)' },
            { value: 'view', label: 'Zoom range', title: 'The part of the log Time history is zoomed into' },
            {
              value: 'point',
              label: 'Test point',
              title: ws.points.length ? 'A saved test point' : 'No test points saved yet',
              disabled: ws.points.length === 0,
            },
          ]}
        />
        {kind === 'point' && (
          <select
            className="select select-sm"
            aria-label="Test point"
            value={pointId ?? ''}
            onChange={(e) => {
              setLastPoint(e.target.value)
              setModes({ source: `point:${e.target.value}` })
            }}
          >
            {!resolved.point && <option value={pointId ?? ''}>Choose a test point</option>}
            {groupedPoints(ws).map(({ group, points }) => (
              <optgroup key={group.id} label={group.name}>
                {points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${p.name} · ${formatDuration(ds.elapsed[Math.max(p.start, p.end - 1)] - ds.elapsed[p.start])}${
                      p.hidden ? ' (hidden)' : ''
                    }`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <p className="md-rows num">
          {resolved.rows && rowsText
            ? `${rowsText} · ${count(resolved.rows[1] - resolved.rows[0])} rows`
            : 'No window yet'}
        </p>
      </section>

      <section className="view-sidebar-section">
        <span className="field-label">Model</span>
        <Segmented
          value={modes.model}
          ariaLabel="Model"
          onChange={(model) => setModes({ model })}
          options={[
            { value: 'oscillation', label: 'Oscillation', title: 'Damped second order: phugoid, short period, dutch roll' },
            { value: 'first-order', label: 'First order', title: 'Exponential: roll subsidence, spiral' },
          ]}
        />
        <p className="field-hint">
          {modes.model === 'oscillation'
            ? 'Damped second order, y = A·e^(−σt)·cos(ωd·t + φ) + c: phugoid, short period, dutch roll.'
            : 'Exponential, y = c + A·e^(−t/τ): roll subsidence, spiral.'}
        </p>
      </section>

      {modes.model === 'oscillation' && (
        <section className="view-sidebar-section">
          <span className="field-label">Trend</span>
          <Segmented
            value={modes.detrend}
            ariaLabel="Trend fitted with the oscillation"
            onChange={(detrend) => setModes({ detrend })}
            options={[
              { value: 'none', label: 'None', title: 'The oscillation settles to a constant value' },
              { value: 'linear', label: 'Linear', title: 'Also fit a straight-line drift (slow climb, speed creep)' },
            ]}
          />
          <p className="field-hint">Linear also fits a slow drift, such as speed creeping during a phugoid.</p>
        </section>
      )}

      <div className="md-help">
        <p className="md-help-title">
          <LightBulbIcon size={16} />
          Getting a good window
        </p>
        <ul>
          <li>Start just after the input ends: fit the free response, not the part you forced.</li>
          <li>Include at least two cycles (three to five is better); let a first-order response settle.</li>
          <li>Keep the controls fixed (or free) and the air smooth for the whole window.</li>
          <li>Save the window as a test point in Time history to come back to it.</li>
        </ul>
      </div>
    </aside>
  )
}

/** Why a quick pick is unavailable: the channels it looks for, by name (from the dictionary) and token. */
function missingPresetText(preset: ModePreset): string {
  const names = preset.channels.map((token) => `${describeChannel(token, 1).label} (${token})`)
  return `This log has no ${names.join(' or ')}: add that Data Output row in X-Plane to use this quick pick.`
}

function groupedPoints(ws: Workspace): { group: Workspace['groups'][number]; points: TestPoint[] }[] {
  return ws.groups
    .map((group) => ({ group, points: ws.points.filter((p) => p.groupId === group.id) }))
    .filter((entry) => entry.points.length > 0)
}

// ------------------------------------------------------------------------------------------------ empty states

function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="md-empty">
      <div className="md-empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h2>{title}</h2>
      <p>{text}</p>
      {children && <div className="md-empty-actions">{children}</div>}
    </div>
  )
}

function NoRows({
  ds,
  ws,
  problem,
  onWholeFile,
}: {
  ds: Dataset
  ws: Workspace
  problem: ModeRows['problem']
  onWholeFile: () => void
}) {
  const lastPoint = ws.points.at(-1)
  const usePoint = lastPoint ? (
    <button type="button" className="btn btn-outline" onClick={() => setModes({ source: `point:${lastPoint.id}` })}>
      Use a test point
    </button>
  ) : null
  if (problem === 'no-zoom') {
    return (
      <EmptyState
        icon={<ZoomInIcon size={24} />}
        title="Zoom into the response first"
        text={`Time history is not zoomed in, so the zoom range is the whole file (${formatDuration(
          ds.elapsed[ds.rowCount - 1] - ds.elapsed[0],
        )}): rarely one clean response. Zoom into the free response in Time history, or fit the whole file anyway.`}
      >
        <button type="button" className="btn btn-primary" onClick={() => setTab('time')}>
          Zoom in Time history
        </button>
        <button type="button" className="btn btn-ghost" onClick={onWholeFile}>
          Fit the whole file
        </button>
      </EmptyState>
    )
  }
  if (problem === 'no-point') {
    return (
      <EmptyState
        icon={<AlertIcon size={24} />}
        title="That test point no longer exists"
        text="Choose another test point on the left, or analyse the selection instead."
      >
        <button type="button" className="btn btn-primary" onClick={() => setModes({ source: 'selection' })}>
          Use the selection
        </button>
        {usePoint}
      </EmptyState>
    )
  }
  return (
    <EmptyState
      icon={<PulseIcon size={24} />}
      title="Select the response to analyse"
      text="In Time history, switch to Select mode (press S) and drag across the free response, starting just after the input ends. The fit runs here as soon as there is a window."
    >
      <button type="button" className="btn btn-primary" onClick={() => setTab('time')}>
        Select a window in Time history
      </button>
      {usePoint}
    </EmptyState>
  )
}

// ------------------------------------------------------------------------------------------------ heading + exports

function ModesHeading({
  ds,
  ws,
  channel,
  series,
  result,
  windowName,
  rowsText,
  plotInput: input,
  showResiduals,
}: {
  ds: Dataset
  ws: Workspace
  channel: Channel
  series: WindowSeries
  result: ModeFit | null
  windowName: string
  rowsText: string
  plotInput: ModesPlotInput | null
  showResiduals: boolean
}) {
  const view = useApp((s) => s.view)
  const rows = series.rows[1] - series.rows[0]
  const stem = safeFilename(
    `${ds.name.replace(/\.[A-Za-z0-9]{1,5}$/, '')}_${windowName}_${channel.meta.short}`,
    'mode_fit',
  )

  const copy = async () => {
    if (!result) return
    const text = resultsTsv(result, {
      dataset: ds.name,
      channel: channelTitle(channel),
      window: windowName,
      rows: series.rows,
      t0: series.t0,
      durationS: series.durationS,
      detrend: ws.modes.detrend,
    })
    const copied = await copyText(text)
    if (copied) toast('Results copied as tab-separated text: paste them into a spreadsheet.', 'success')
    else toast('Could not copy: the clipboard is not available here.', 'error')
  }

  const exportImage = async (format: 'png' | 'svg') => {
    if (!input) return
    try {
      const residuals = showResiduals && input.fitted !== null
      const option = buildModesOption(modesPlotData(input), readChartTheme('paper'), {
        residuals,
        figure: {
          title: `${windowName} — ${channelTitle(channel)}`,
          subtitle: result ? figureSubtitle(result) : undefined,
        },
      })
      await exportOptionImage(option, { format, width: 960, height: residuals ? 620 : 500, filename: `${stem}_fit` })
    } catch (error) {
      toast(`Could not export the figure: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const items: ExportItem[] = [
    {
      section: 'Figure',
      label: 'PNG image',
      hint: 'White background, high resolution',
      disabled: !input,
      onSelect: () => exportImage('png'),
    },
    { label: 'SVG image', hint: 'Vector, for reports', disabled: !input, onSelect: () => exportImage('svg') },
    {
      section: 'Data',
      label: 'Window and fit (CSV)',
      hint: 'Time, value, fit, residual, envelope',
      onSelect: () => {
        const envelope =
          result?.model === 'oscillation' && result.fit.ok ? oscillationEnvelope(series.t, result.fit) : null
        downloadText(`${stem}.csv`, fitCsv(series, result, channelTitle(channel), envelope), 'text/csv')
      },
    },
    {
      section: 'MATLAB',
      label: 'MATLAB script',
      hint: 'Re-runs this fit on the original log',
      onSelect: () => {
        try {
          const text = matlabScript({
            ds,
            ws,
            include: { points: false, xy: false, time: false, modes: true },
            view,
            modeRows: series.rows,
          })
          downloadText(matlabScriptName(ds.name), text, 'text/plain')
        } catch (error) {
          toast(`Could not write the MATLAB script: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      },
    },
  ]

  return (
    <div className="md-heading">
      <div className="md-heading-text">
        <p className="eyebrow">Dynamic modes · {windowName}</p>
        <h2 title={channel.meta.description ?? channel.meta.label}>{channel.meta.label}</h2>
        <p className="md-heading-sub num">
          {rowsText} · {count(rows)} rows
          {series.finite < rows ? ` (${count(series.finite)} with values)` : ''}
        </p>
      </div>
      <div className="md-heading-actions">
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void copy()} disabled={!result}>
          <CopyIcon size={16} />
          Copy results
        </button>
        <ExportMenu items={items} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ chart legend

const keyStyle = (color: string): CSSProperties => ({ ['--key' as string]: color }) as CSSProperties

function Legend({ channel, result, residuals }: { channel: Channel; result: ModeFit | null; residuals: boolean }) {
  const fitted = result ? fittedCurve(result) : null
  const ok = result?.fit.ok ?? false
  return (
    <div className="md-legend" aria-label="Legend">
      <span className="series-chip">
        <span className="line-key" style={keyStyle('var(--series-1)')} />
        <span className="series-chip-name">{channel.meta.short}</span>
        {channel.meta.unit && <span className="series-chip-unit">{channel.meta.unit}</span>}
      </span>
      {fitted && (
        <span className="series-chip">
          <span className={`line-key${ok ? '' : ' md-key-dashed'}`} style={keyStyle('var(--series-2)')} />
          <span className="series-chip-name">{ok ? 'Fit' : 'Fit (rejected)'}</span>
        </span>
      )}
      {ok && result?.model === 'oscillation' && (
        <span className="series-chip">
          <span className="line-key md-key-dashed md-key-thin" style={keyStyle('var(--series-2)')} />
          <span className="series-chip-name">Envelope</span>
        </span>
      )}
      {ok && result?.model === 'oscillation' && result.fit.peaks.length > 0 && (
        <span className="series-chip">
          <span className="md-key-peak" aria-hidden="true" />
          <span className="series-chip-name">Peaks</span>
        </span>
      )}
      {fitted && residuals && (
        <span className="series-chip">
          <span className="line-key md-key-thin" style={keyStyle('var(--chart-text-muted)')} />
          <span className="series-chip-name">Residual</span>
        </span>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ results

function Results({
  result,
  stale,
  channel,
  point,
  groups,
  series,
}: {
  result: ModeFit | null
  stale: boolean
  channel: Channel
  point: TestPoint | null
  groups: Workspace['groups']
  series: WindowSeries
}) {
  const tiles = result ? resultTiles(result, channel.meta.unit) : []
  const reading = result ? interpretFit(result, channel) : null
  const message = result?.fit.message
  const group = point ? groups.find((g) => g.id === point.groupId) : undefined
  return (
    <section
      className={`md-results${stale ? ' md-stale' : ''}`}
      data-testid="modes-results"
      aria-label="Fit results"
      aria-busy={stale || !result}
    >
      {!result ? (
        <p className="md-results-wait">
          <span className="spinner" aria-hidden="true" /> Fitting {count(series.finite)} samples…
        </p>
      ) : (
        <>
          {reading && <p className={`md-reading md-reading-${reading.tone}`}>{reading.text}</p>}
          {message && !result.fit.ok && (
            <div className="callout callout-warning" role="alert">
              <AlertIcon size={16} />
              <span>{message}</span>
            </div>
          )}
          {message && result.fit.ok && (
            <div className="callout md-caution">
              <InfoIcon size={16} />
              <span>{message}</span>
            </div>
          )}
          <div className="md-tiles">
            {tiles.map((tile) => (
              <div key={tile.key} className="stat-tile md-tile">
                <span className="md-tile-label">{tile.label}</span>
                <span className="stat-tile-value num">
                  {tile.value}
                  {tile.unit && tile.value !== '—' && <small>{tile.unit}</small>}
                </span>
                {tile.foot && (
                  <span className="stat-tile-foot" title={tile.foot}>
                    {tile.foot}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {point?.note && (
        <div className="md-note">
          <p className="md-note-head">
            <span className={`chip slot-${group?.slot ?? 0}`}>
              <span className="chip-dot" />
              {group?.name ?? 'Test point'}
            </span>
            <strong>{point.name}</strong>
          </p>
          <p className="md-note-text">{point.note}</p>
        </div>
      )}
    </section>
  )
}

function PeaksTable({
  result,
  series,
  unit,
}: {
  result: Extract<ModeFit, { model: 'oscillation' }>
  series: WindowSeries
  unit: string
}) {
  const rows = peakRows(result.fit, series.t0)
  const suffix = unit ? ` [${unit}]` : ''
  return (
    <details className="md-peaks">
      <summary>
        <span className="md-peaks-title">Peaks</span>
        <span className="badge badge-count">{rows.length}</span>
        <span className="md-peaks-hint">The turning points behind the log-decrement cross-check</span>
      </summary>
      <div className="table-wrap md-peaks-table">
        <table className="table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Kind</th>
              <th className="num">t [s]</th>
              <th className="num">Elapsed [s]</th>
              <th className="num">Value{suffix}</th>
              <th className="num">Amplitude{suffix}</th>
              <th className="num" title="ln(previous / this amplitude), against the previous peak of the same kind">
                Decrement δ
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.n}>
                <td className="num">{row.n}</td>
                <td>{row.kind === 'max' ? 'Maximum' : 'Minimum'}</td>
                <td className="num">{formatNumber(row.t, 4)}</td>
                <td className="num">{formatNumber(row.elapsed, 6)}</td>
                <td className="num">{formatNumber(row.value, 5)}</td>
                <td className="num">{formatNumber(row.amplitude, 4)}</td>
                <td className="num">{formatNumber(row.decrement, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
