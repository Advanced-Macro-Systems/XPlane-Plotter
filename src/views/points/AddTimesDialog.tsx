// "Add points from times…": paste the times of the test points as written down during the flight (one window per
// line, with the speed held if you have it), see which of the log's clocks they were read from (each window's mean
// speed against the speed listed), preview the windows (rows, mean speed ± σ against the listed speed, steadiness),
// and add the ticked ones as test points in one group, with an Undo. Optionally switch Time history to that clock.
// Windows whose speed is far from the one listed, that share rows with an earlier line or are not steady start
// unticked, with the reason.

import { AlertIcon, CheckCircleIcon, InfoIcon } from '@primer/octicons-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatFixed } from '../../charts/format'
import { airspeedChannels, speedUnit, steadyDefaults } from '../../core/analysis/steady'
import { channelById } from '../../core/dataset'
import { timeAxis } from '../../core/time'
import type { Channel, Dataset, TimeAxis, TimeBaseId, Workspace } from '../../core/types'
import { setTimeBase } from '../../store/app'
import { Modal } from '../../ui/Modal'
import { addPointsWithUndo } from './pointsActions'
import { formatMeanSd } from './pointsModel'
import { GroupField } from './PointsTools'
import { defaultTarget, type GroupTarget } from './pointSets'
import { signedText, timesRows, type TimesRow } from './steadyModel'
import {
  MATCH_LIMIT,
  SINGLE_TIME_PAD,
  clockVerdict,
  matchTimeBases,
  parseTimesTable,
  type BaseMatch,
  type SpeedKind,
} from './timesTable'

interface AddTimesDialogProps {
  ds: Dataset
  ws: Workspace
  /** The time axis Time history shows */
  axis: TimeAxis
  onClose: () => void
}

/** The airspeed channel a table's header names. */
const KIND_CHANNEL: Record<SpeedKind, string> = { ias: '_Vind,_kias', eas: '_Vind,_keas', tas: 'Vtrue,_ktas' }

const EXAMPLE = ['Time (s) | IAS', '95 | 260', '150-180 | 250', '210–240, 240 kt', '(not flown) | 230'].join('\n')

/** "Real time — 0.2 kt off" for the time-axis menu. */
function baseOption(match: BaseMatch, unit: string): string {
  if (match.inside === 0) return `${match.label} — outside the log`
  if (!Number.isFinite(match.median)) return match.label
  return `${match.label} — speeds ${match.median.toFixed(1)} ${unit} off (median)`
}

export function AddTimesDialog({ ds, ws, axis, onClose }: AddTimesDialogProps) {
  const formId = useId()
  const [text, setText] = useState('')
  const parsed = useMemo(() => parseTimesTable(text), [text])
  const speeds = useMemo(() => airspeedChannels(ds), [ds])
  const [speedChoice, setSpeedChoice] = useState<string | null>(null)
  const hinted = parsed.speedKind ? channelById(ds, KIND_CHANNEL[parsed.speedKind]) : undefined
  const speed: Channel | null = speeds.find((c) => c.id === speedChoice) ?? (hinted && speeds.includes(hinted) ? hinted : speeds[0]) ?? null
  const unit = speed ? speedUnit(speed) : 'kt'
  const matches = useMemo(() => matchTimeBases(ds, parsed.windows, speed), [ds, parsed, speed])
  const verdict = useMemo(() => clockVerdict(matches, ws.timeBase, unit), [matches, ws.timeBase, unit])
  const [baseChoice, setBaseChoice] = useState<TimeBaseId | null>(null)
  const base = baseChoice !== null && matches.some((m) => m.id === baseChoice) ? baseChoice : verdict.id
  const baseMatch = matches.find((m) => m.id === base)
  const on = useMemo(() => timeAxis(ds, base), [ds, base])
  const speedTol = steadyDefaults(unit).speedTol
  const rows = useMemo(
    () => timesRows(ds, ws, on, on, parsed.windows, speed, SINGLE_TIME_PAD, speedTol),
    [ds, ws, on, parsed, speed, speedTol],
  )
  // The ticks the user changed (by row); the others follow each row's suggestion.
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [switchAxis, setSwitchAxis] = useState(true)
  const [target, setTarget] = useState<GroupTarget>(() => defaultTarget(ws.groups))
  const addable = rows.filter((r) => r.rows && !r.overlaps)
  const isTicked = (r: TimesRow) => !!r.rows && !r.overlaps && (choices.get(r.key) ?? r.suggested)
  const chosen = addable.filter(isTicked)
  const outside = rows.filter((r) => !r.rows).length
  const repeats = rows.filter((r) => r.rows && r.overlaps).length
  const otherAxis = base !== ws.timeBase && on.id === base

  const allTicked = chosen.length === addable.length && addable.length > 0
  const someTicked = chosen.length > 0 && !allTicked
  const headerBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someTicked
  }, [someTicked])
  const tick = (keys: readonly string[], ticked: boolean) =>
    setChoices((old) => {
      const next = new Map(old)
      for (const key of keys) next.set(key, ticked)
      return next
    })

  const add = (event?: FormEvent) => {
    event?.preventDefault()
    if (!chosen.length || !baseMatch) return
    const clock = baseMatch.label
    const added = addPointsWithUndo(
      ds.id,
      chosen.map((r) => ({
        name: r.name,
        start: (r.rows as [number, number])[0],
        end: (r.rows as [number, number])[1],
        note: `From times: “${r.window.text}” on ${clock.toLowerCase()}${r.window.single ? ` (± ${SINGLE_TIME_PAD} s)` : ''}.`,
      })),
      target,
    )
    if (!added) return
    if (switchAxis && otherAxis) setTimeBase(base)
    onClose()
  }

  const short = speed?.meta.short ?? 'Speed'
  const lines = parsed.windows.length
  return (
    <Modal
      title="Add points from times"
      onClose={onClose}
      width={960}
      className="pt-tool-dialog"
      footer={
        <>
          {addable.length > 0 && <GroupField groups={ws.groups} target={target} onChange={setTarget} />}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={!chosen.length}
            data-testid="times-add"
          >
            Add {chosen.length} test point{chosen.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <form id={formId} className="pt-tool" onSubmit={add} noValidate data-testid="times-dialog">
        <label className="field">
          <span className="field-label">Times, one window per line</span>
          <textarea
            className="textarea pt-tool-paste"
            value={text}
            rows={4}
            spellCheck={false}
            placeholder={EXAMPLE}
            data-autofocus
            data-testid="times-input"
            onChange={(event) => setText(event.target.value)}
          />
          <span className="field-hint">
            From your notes or a spreadsheet: “150-180 250”, “150 180” or “210–240, 240 kt”, with a header line, tabs, pipes
            or commas if you like. A single time takes ± {SINGLE_TIME_PAD} s around it; a line without a time is skipped.
          </span>
        </label>

        {lines > 0 || parsed.skipped.length > 0 ? (
          <p className="pt-tool-status" role="status" data-testid="times-status">
            {lines} window{lines === 1 ? '' : 's'} read
            {parsed.skipped.length > 0 &&
              ` · skipped ${parsed.skipped.map((s) => `line ${s.line} (“${s.text}”: ${s.reason})`).join(', ')}`}
            {addable.length > 0 && chosen.length < addable.length ? ` · ${chosen.length} of ${addable.length} ticked` : ''}
          </p>
        ) : null}

        {lines > 0 && (
          <>
            <div
              className={`callout ${verdict.confirmed ? 'callout-success' : 'callout-warning'} pt-tool-verdict`}
              role="note"
              data-testid="times-verdict"
            >
              {verdict.confirmed ? <CheckCircleIcon size={16} /> : <AlertIcon size={16} />}
              <span>{verdict.message}</span>
            </div>
            <div className="pt-tool-settings">
              <label className="field">
                <span className="field-label">Read the times on</span>
                <select
                  className="select select-sm"
                  value={base}
                  data-testid="times-base"
                  onChange={(event) => setBaseChoice(event.target.value as TimeBaseId)}
                >
                  {matches.map((m) => (
                    <option key={m.id} value={m.id}>
                      {baseOption(m, unit)}
                    </option>
                  ))}
                </select>
              </label>
              {speed && speeds.length > 1 && (
                <label className="field">
                  <span className="field-label">Speeds listed are</span>
                  <select className="select select-sm" value={speed.id} onChange={(event) => setSpeedChoice(event.target.value)}>
                    {speeds.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.meta.short}
                        {c.meta.label && c.meta.label !== c.meta.short ? ` — ${c.meta.label}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {otherAxis && (
                <label className="check pt-tool-switch">
                  <input
                    type="checkbox"
                    checked={switchAxis}
                    data-testid="times-switch-axis"
                    onChange={(event) => setSwitchAxis(event.target.checked)}
                  />
                  Switch Time history from {axis.label.toLowerCase()} to {on.label.toLowerCase()}
                </label>
              )}
            </div>
            {(outside > 0 || repeats > 0) && (
              <p className="pt-tool-status pt-tool-warn">
                <InfoIcon size={14} />
                {[
                  outside > 0
                    ? `${outside} window${outside === 1 ? ' has' : 's have'} no data on ${on.label.toLowerCase()} (outside the log, or in a gap of this axis)`
                    : '',
                  repeats > 0 ? `${repeats} already ${repeats === 1 ? 'is a test point' : 'are test points'} (not added)` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            <div className="table-wrap pt-tool-table-wrap">
              <table className="table pt-tool-table" data-testid="times-table">
                <thead>
                  <tr>
                    <th scope="col" className="pt-tool-check">
                      <input
                        ref={headerBox}
                        type="checkbox"
                        aria-label="Add every window"
                        checked={allTicked}
                        disabled={!addable.length}
                        onChange={(e) => tick(addable.map((r) => r.key), e.target.checked)}
                      />
                    </th>
                    <th scope="col">Name</th>
                    <th scope="col">Typed</th>
                    <th scope="col" title={`First and last row found, on ${on.label.toLowerCase()}`}>
                      Rows found ({on.label.toLowerCase()})
                    </th>
                    <th scope="col" className="num">
                      Rows
                    </th>
                    <th scope="col" className="num">
                      {short} <span className="pt-th-unit">{unit}</span>
                    </th>
                    <th scope="col" className="num">
                      Listed
                    </th>
                    <th scope="col" className="num">
                      Δ <span className="pt-th-unit">{unit}</span>
                    </th>
                    <th scope="col">Check</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <TimesRowView
                      key={row.key}
                      row={row}
                      ticked={isTicked(row)}
                      onTick={(ticked) => tick([row.key], ticked)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {lines > 0 && !speed && (
          <div className="callout callout-warning" role="note">
            <InfoIcon size={16} />
            <span>This file has no airspeed channel (KIAS, KEAS or KTAS): the times cannot be checked against the speeds.</span>
          </div>
        )}
      </form>
    </Modal>
  )
}

function TimesRowView({ row, ticked, onTick }: { row: TimesRow; ticked: boolean; onTick: (ticked: boolean) => void }) {
  const stats = row.stats
  const speed = stats && stats.n > 0 ? formatMeanSd(stats.mean, stats.std) : null
  const off = Number.isFinite(row.diff) && Math.abs(row.diff) > MATCH_LIMIT
  const label = !row.rows
    ? `${row.window.text}: no data at these times`
    : row.overlaps
      ? `Already a test point: ${row.overlaps.name}`
      : `Add ${row.name}`
  return (
    <tr className={!row.rows || row.overlaps ? 'pt-tool-row is-repeat' : 'pt-tool-row'} data-testid="times-row">
      <td className="pt-tool-check">
        <input
          type="checkbox"
          aria-label={label}
          checked={ticked}
          disabled={!row.rows || !!row.overlaps}
          onChange={(event) => onTick(event.target.checked)}
        />
      </td>
      <td className="pt-tool-name">
        {!row.rows ? (
          <span className="subtle" title="Outside the log, or in a gap of this time axis">
            No data here
          </span>
        ) : row.overlaps ? (
          <span className="subtle" title="It overlaps this saved test point, so it is not added again">
            Already a test point: {row.overlaps.name}
          </span>
        ) : (
          row.name
        )}
      </td>
      <td className="pt-tool-typed mono" title={`Line ${row.window.line}`}>
        {row.window.text}
      </td>
      <td className="num pt-tool-window">{row.range || '—'}</td>
      <td className="num">{row.rows ? (row.rows[1] - row.rows[0]).toLocaleString('en-GB') : '—'}</td>
      <td className="num">
        {speed ? (
          <>
            {speed.mean}
            {speed.sd && <span className="pt-sd"> ± {speed.sd}</span>}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="num">{row.window.speed ?? '—'}</td>
      <td className={`num${off ? ' pt-tool-off' : ''}`} title={off ? `More than ${MATCH_LIMIT} away from the listed speed` : undefined}>
        {signedText(row.diff, 1)}
      </td>
      <td>
        <RowCheck row={row} />
      </td>
    </tr>
  )
}

/** Why a row with each caution starts unticked (its badge's tooltip). */
function cautionTitle(row: TimesRow): string {
  if (row.clash !== null) return `Its rows overlap line ${row.clash}'s`
  if (row.scattered && !(Math.abs(row.diff) > MATCH_LIMIT)) return 'The speed scatters more than a steady hold allows'
  if (row.window.speed === null) return 'The other lines list a speed and this one does not'
  return `Its mean speed is more than ${MATCH_LIMIT} away from the speed listed`
}

/** The row's check: why it starts unticked, else how steady its speed is. */
function RowCheck({ row }: { row: TimesRow }) {
  if (!row.rows || row.overlaps) return <span className="subtle">—</span>
  if (row.caution) {
    return (
      <span className="badge badge-warning" title={`${cautionTitle(row)}: not ticked to start with (tick it to add it anyway)`}>
        <AlertIcon size={12} /> {row.caution}
      </span>
    )
  }
  if (row.steady === null) return <span className="subtle">—</span>
  if (row.steady.flagged) {
    return (
      <span className="badge badge-warning" title={`${row.hint}: the trend moves it more than its scatter`}>
        <AlertIcon size={12} /> {row.hint.replace(/^drifting /, 'Drifting ')}
      </span>
    )
  }
  return (
    <span className="badge badge-success" title={`The speed's trend stays within its scatter (± ${formatFixed(row.stats?.std ?? NaN, 1)})`}>
      <CheckCircleIcon size={12} /> Steady
    </span>
  )
}
