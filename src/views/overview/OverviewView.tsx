// Overview: what is in the open file. Name and facts, data-quality notes, the flight at a glance (altitude, airspeed,
// attitude and the ground track), the channel groups, and where to go next.

import { AlertIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, InfoIcon } from '@primer/octicons-react'
import { useMemo, useState, type ReactNode } from 'react'
import { ExportMenu, type ExportItem } from '../../components/ExportMenu'
import { groupChannels } from '../../components/channelGroups'
import { groupById } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { DEMO_FILE_NAME } from '../../core/demo/generateDemo'
import { formatDuration, timeAxis } from '../../core/time'
import type { Dataset, TabId, Workspace } from '../../core/types'
import { downloadDemoLog, exportAllChannelsCsv, exportMatlabScript, saveSessionFile } from '../../layout/fileActions'
import { formatBytes, formatCount, plural, TAB_NAMES } from '../../layout/shellModel'
import { TAB_ICONS } from '../../layout/tabIcons'
import { openChannels, setTab, useActiveDataset, useWorkspace } from '../../store/app'
import { GlanceCharts } from './GlanceCharts'
import { GroundTrackCard } from './GroundTrack'
import {
  formatRate,
  glanceTime,
  groundTrack,
  groupsShown,
  overviewFigures,
  segmentSummary,
  type OverviewFigures,
} from './overviewModel'
import './overview.css'

export function OverviewView() {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  if (!ds) return null
  return <Overview ds={ds} ws={ws} />
}

function Overview({ ds, ws }: { ds: Dataset; ws: Workspace | null }) {
  const figures = useMemo(() => overviewFigures(ds, ws), [ds, ws])
  const track = useMemo(() => groundTrack(ds), [ds])

  return (
    <div className="view" data-testid="view-overview">
      <div className="view-scroll">
        <div className="ov-page">
          <Heading ds={ds} />
          <Figures ds={ds} figures={figures} />
          <QualityNotes ds={ds} figures={figures} />

          <section className="ov-section" aria-labelledby="ov-glance-title">
            <SectionHead
              id="ov-glance-title"
              title="Flight at a glance"
              note={`The whole log against ${glanceTime(ds).against}. Hover to read values.`}
            />
            <div className={`ov-glance-grid${track ? '' : ' ov-glance-grid-single'}`}>
              <GlanceCharts ds={ds} ws={ws} />
              {track && <GroundTrackCard ds={ds} track={track} />}
            </div>
          </section>

          <ChannelGroups ds={ds} figures={figures} />
          <NextSteps ds={ds} ws={ws} />
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ heading

function Heading({ ds }: { ds: Dataset }) {
  const demo = ds.name === DEMO_FILE_NAME
  const loaded = new Date(ds.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const items: ExportItem[] = [
    {
      section: 'For your report',
      label: 'MATLAB script (.m)',
      hint: 'Re-reads this log: test points, X–Y, time histories, mode fit',
      onSelect: exportMatlabScript,
    },
    ...(demo
      ? [{ label: 'The demo log (.txt)', hint: 'Save it next to the MATLAB script, which reads it', onSelect: downloadDemoLog }]
      : []),
    {
      section: 'Data',
      label: 'All channels (CSV)',
      hint: `${plural(ds.rowCount, 'row')} × ${formatCount(ds.channels.length)} channels, time first`,
      onSelect: exportAllChannelsCsv,
    },
    { label: 'Session file (.json)', hint: 'Test points, panels, formulas and plot settings', onSelect: saveSessionFile },
  ]

  return (
    <header className="ov-head">
      <div className="ov-head-text">
        <p className="eyebrow">{demo ? 'Synthetic demo flight' : ds.format === 'xplane' ? 'X-Plane 12 log' : 'CSV / TSV log'}</p>
        <h1 className="ov-title">{ds.name}</h1>
        <p className="ov-meta">
          <span>{ds.format === 'xplane' ? 'X-Plane Data.txt format' : 'Delimited text (CSV / TSV)'}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(ds.sizeBytes)}</span>
          <span aria-hidden="true">·</span>
          <span>Opened at {loaded}</span>
          {demo && <span className="badge badge-warning ov-demo-badge">Not flight-test evidence</span>}
        </p>
      </div>
      <div className="ov-head-actions">
        <ExportMenu items={items} />
      </div>
    </header>
  )
}

// ------------------------------------------------------------------ figures

function Figures({ ds, figures }: { ds: Dataset; figures: OverviewFigures }) {
  const source = ds.timeSourceId ? timeAxis(ds, `ch:${ds.timeSourceId}`).label : null
  const dt = Number.isFinite(ds.sampleRateHz) && ds.sampleRateHz > 0 ? 1 / ds.sampleRateHz : Number.NaN
  return (
    <div className="stat-grid ov-figures">
      {/* Without a time column the elapsed "time" is the row number: no duration to report. */}
      <Figure
        label="Duration"
        value={source ? formatDuration(figures.durationS) : '—'}
        foot={!source ? 'No time column in this file' : figures.segments > 1 ? `${source}, gaps left out` : source}
      />
      <Figure label="Rows" value={formatCount(figures.rows)} foot={ds.format === 'xplane' ? 'One per disk write' : 'One per data line'} />
      <Figure
        label="Sample rate"
        value={formatRate(figures.rateHz)}
        foot={Number.isFinite(dt) ? `Median step ${dt < 1 ? dt.toFixed(3) : dt.toFixed(2)} s` : 'No time column'}
      />
      <Figure
        label="Channels"
        value={
          <>
            {formatCount(figures.channels)}
            <small>({formatCount(figures.known)} known)</small>
          </>
        }
        foot={[`${formatCount(figures.constant)} constant`, figures.formulas ? plural(figures.formulas, 'formula') : ''].filter(Boolean).join(' · ')}
      />
      <Figure label="Segments" value={formatCount(figures.segments)} foot={segmentSummary(figures)} />
      <Figure
        label="Test points"
        value={formatCount(figures.points)}
        foot={figures.points ? `In ${plural(figures.groupsUsed, 'group')}` : 'None saved yet'}
      />
    </div>
  )
}

function Figure({ label, value, foot }: { label: string; value: ReactNode; foot: string }) {
  return (
    <div className="stat-tile">
      <p className="ov-figure-label">{label}</p>
      <p className="stat-tile-value">{value}</p>
      <p className="stat-tile-foot" title={foot}>
        {foot}
      </p>
    </div>
  )
}

// ------------------------------------------------------------------ data quality

function QualityNotes({ ds, figures }: { ds: Dataset; figures: OverviewFigures }) {
  const warnings = ds.warnings
  return (
    <div className="ov-notes">
      {warnings.length > 0 ? (
        <div className="callout callout-warning ov-callout" role="note">
          <AlertIcon size={16} />
          <div className="ov-callout-body">
            <strong>{warnings.length === 1 ? 'One thing to know about this file' : `${warnings.length} things to know about this file`}</strong>
            <ul>
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="callout callout-success ov-callout" role="note">
          <CheckCircleIcon size={16} />
          <div className="ov-callout-body">Every row was read and the time runs without resets or gaps.</div>
        </div>
      )}
      {figures.constant > 0 && (
        <div className="callout ov-callout ov-callout-quiet" role="note">
          <InfoIcon size={16} />
          <div className="ov-callout-body">
            {figures.constant === 1 ? 'One channel never changes' : `${formatCount(figures.constant)} channels never change`} in this
            log (empty weights, unused stations, switches left alone). The channel pickers tuck them away.{' '}
            <button type="button" className="ov-link" onClick={() => openChannels({ constant: true })}>
              Show them in Channels
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ channel groups

function ChannelGroups({ ds, figures }: { ds: Dataset; figures: OverviewFigures }) {
  const blocks = useMemo(() => groupChannels(ds.channels), [ds])
  const [expanded, setExpanded] = useState(false)
  const shown = groupsShown(blocks.length, expanded)
  const note =
    figures.fileChannels > 0
      ? `${formatCount(figures.known)} of ${formatCount(figures.fileChannels)} columns recognised from X-Plane 12's Data Output list`
      : undefined
  return (
    <section className="ov-section" aria-labelledby="ov-groups-title">
      <SectionHead id="ov-groups-title" title="Data in this file" note={note} />
      <div className="ov-groups">
        {blocks.slice(0, shown).map((block) => {
          const group = groupById(block.id)
          const title = [group.description, group.index !== null ? `Data Output row ${group.index}` : ''].filter(Boolean).join(' · ')
          return (
            <button
              key={block.id}
              type="button"
              className="ov-group"
              title={title || undefined}
              onClick={() => openChannels({ group: block.id })}
            >
              <span className="ov-group-name">{block.name}</span>
              <span className="ov-group-count">{formatCount(block.channels.length)}</span>
            </button>
          )
        })}
        {shown < blocks.length && (
          <button type="button" className="ov-group ov-group-more" aria-expanded="false" onClick={() => setExpanded(true)}>
            {`${blocks.length - shown} more groups`}
            <ChevronDownIcon size={16} />
          </button>
        )}
        {expanded && groupsShown(blocks.length, false) < blocks.length && (
          <button type="button" className="ov-group ov-group-more" aria-expanded="true" onClick={() => setExpanded(false)}>
            Show fewer
            <ChevronUpIcon size={16} />
          </button>
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ next steps

function NextSteps({ ds, ws }: { ds: Dataset; ws: Workspace | null }) {
  const short = (id: string | null | undefined) => (id ? channelById(ds, id)?.meta.short : undefined)

  const points = ws?.points.length ?? 0
  const groups = new Set(ws?.points.map((p) => p.groupId)).size
  const timeStatus = points ? `${plural(points, 'test point')} saved${groups > 1 ? ` in ${groups} groups` : ''}` : 'No test points yet'

  let xyStatus = 'Choose the channels to plot'
  if (ws?.xy.x && ws.xy.ys.length) {
    const y = short(ws.xy.ys[0])
    const x = short(ws.xy.x)
    const more = ws.xy.ys.length > 1 ? ` (+${ws.xy.ys.length - 1})` : ''
    const source = ws.xy.source === 'points' ? ', test points' : ws.xy.source === 'view' ? ', zoom range' : ''
    if (x && y) xyStatus = `Now: ${y}${more} against ${x}${source}`
  }

  let modesStatus = 'Choose a channel and a window'
  const channel = short(ws?.modes.channelId)
  if (ws && channel) {
    const source = ws.modes.source
    const point = source.startsWith('point:') ? ws.points.find((p) => `point:${p.id}` === source) : undefined
    const window = point ? point.name : source === 'view' ? 'the zoom range' : 'the selection'
    modesStatus = `Now: ${channel} in ${window}`
  }

  const steps: { tab: TabId; lead: string; text: string; status: string }[] = [
    {
      tab: 'time',
      lead: 'Pick steady test points',
      text: 'Drag across a steady stretch in Select mode and save it as a test point in a group.',
      status: timeStatus,
    },
    {
      tab: 'xy',
      lead: 'Lift curve, drag polar, trim curves',
      text: 'Any channel against another, through every sample or the test-point means, with fits.',
      status: xyStatus,
    },
    {
      tab: 'modes',
      lead: 'Fit phugoid, short period, dutch roll',
      text: 'Fit a damped oscillation or a first-order response to a window: period, damping, time constant.',
      status: modesStatus,
    },
  ]

  return (
    <section className="ov-section" aria-labelledby="ov-next-title">
      <SectionHead id="ov-next-title" title="Next steps" />
      <div className="ov-next-grid">
        {steps.map((step) => {
          const Icon = TAB_ICONS[step.tab]
          return (
            <button key={step.tab} type="button" className="ov-next" onClick={() => setTab(step.tab)}>
              <span className="ov-next-top">
                <span className="ov-next-icon" aria-hidden="true">
                  <Icon size={16} />
                </span>
                <span className="ov-next-tab">{TAB_NAMES[step.tab]}</span>
                <ChevronRightIcon className="ov-next-arrow" size={16} />
              </span>
              <span className="ov-next-lead">{step.lead}</span>
              <span className="ov-next-text">{step.text}</span>
              <span className="ov-next-status">{step.status}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function SectionHead({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="ov-section-head">
      <h2 id={id} className="ov-section-title">
        {title}
      </h2>
      {note && <p className="ov-section-note">{note}</p>}
    </div>
  )
}
