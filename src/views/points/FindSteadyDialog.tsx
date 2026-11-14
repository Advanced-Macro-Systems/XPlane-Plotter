// "Find steady points…": finds the stretches of steady, level flight in the log (core/analysis/steady.ts) with the
// tolerances set here, previews them (window on the current time axis, duration, mean speed ± σ, vertical speed,
// altitude drift, the power setting's drift and a name like "250 KIAS"), and adds the ticked ones as test points in one
// group, with an Undo.

import { CheckCircleIcon, InfoIcon } from '@primer/octicons-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatFixed, formatNumber } from '../../charts/format'
import { rangeText, useSettled } from '../../components/hooks'
import {
  airspeedChannels,
  findSteadyWindows,
  powerKind,
  speedUnit,
  steadyChannels,
  steadyDefaults,
  type SteadyOptions,
} from '../../core/analysis/steady'
import { formatDuration } from '../../core/time'
import type { Channel, Dataset, RowRange, TimeAxis, Workspace } from '../../core/types'
import { useApp } from '../../store/app'
import { Modal } from '../../ui/Modal'
import { addPointsWithUndo } from './pointsActions'
import { formatMeanSd } from './pointsModel'
import { GroupField } from './PointsTools'
import { defaultTarget, type GroupTarget } from './pointSets'
import { signedText, steadyRows, type SteadyRow } from './steadyModel'

interface FindSteadyDialogProps {
  ds: Dataset
  ws: Workspace
  /** The time axis Time history shows: windows are written on it */
  axis: TimeAxis
  onClose: () => void
}

type Scope = 'all' | 'selection' | 'view'

interface Form {
  speedTol: string
  vviTol: string
  minDuration: string
  bankTol: string
  powerTol: string
}

/**
 * The search follows the fields once typing pauses this long: on a long log it takes a tenth of a second or so, which
 * would stall every key.
 */
const SEARCH_PAUSE_MS = 250

/** A number typed in a field: finite and at least `min`, else null. */
function typed(text: string, min: number): number | null {
  const value = Number(text.trim().replace(',', '.'))
  return text.trim() !== '' && Number.isFinite(value) && value >= min ? value : null
}

/** A field that may be left empty (not checked): null when empty, undefined when it holds no valid number. */
function optional(text: string, min: number): number | null | undefined {
  return text.trim() === '' ? null : (typed(text, min) ?? undefined)
}

/** The search's tolerances from the fields, or null while one of them holds no valid number. */
function tolerances(form: Form): Pick<SteadyOptions, 'speedTol' | 'vviTol' | 'minDuration' | 'bankTol' | 'powerTol'> | null {
  const speedTol = typed(form.speedTol, Number.MIN_VALUE)
  const vviTol = typed(form.vviTol, 0)
  const minDuration = typed(form.minDuration, 1)
  const bankTol = optional(form.bankTol, 0)
  const powerTol = optional(form.powerTol, 0)
  if (speedTol === null || vviTol === null || minDuration === null || bankTol === undefined || powerTol === undefined) return null
  return { speedTol, vviTol, minDuration, bankTol, powerTol }
}

/** "the vertical speed stays near zero, the wings level and the throttle steady" */
function conditions(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}

export function FindSteadyDialog({ ds, ws, axis, onClose }: FindSteadyDialogProps) {
  const formId = useId()
  const selection = useApp((s) => s.selection)
  const view = useApp((s) => s.view)
  const speeds = useMemo(() => airspeedChannels(ds), [ds])
  const [speedId, setSpeedId] = useState(() => speeds[0]?.id ?? '')
  const channels = useMemo(() => steadyChannels(ds, speedId), [ds, speedId])
  const speed = channels?.speed ?? null
  const power = channels?.power ?? null
  const unit = speed ? speedUnit(speed) : 'kt'
  const defaults = useMemo(() => steadyDefaults(unit), [unit])
  const [form, setForm] = useState<Form>(() => ({
    speedTol: String(defaults.speedTol),
    vviTol: String(defaults.vviTol),
    minDuration: String(defaults.minDuration),
    bankTol: String(defaults.bankTol),
    powerTol: String(defaults.powerTol),
  }))
  const [scope, setScope] = useState<Scope>('all')
  const [target, setTarget] = useState<GroupTarget>(() => defaultTarget(ws.groups))
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())

  // Without a vertical speed or an altitude, level flight cannot be checked (a CSV with the speed alone).
  const checksLevel = !!(channels?.vvi || channels?.altitude)
  const invalid = {
    speedTol: typed(form.speedTol, Number.MIN_VALUE) === null,
    vviTol: checksLevel && typed(form.vviTol, 0) === null,
    minDuration: typed(form.minDuration, 1) === null,
    bankTol: optional(form.bankTol, 0) === undefined,
    powerTol: optional(form.powerTol, 0) === undefined,
  }
  // A scope that has gone (the selection cleared behind the dialog) is the whole log.
  const where: Scope = (scope === 'selection' && !selection) || (scope === 'view' && !view) ? 'all' : scope
  const range: RowRange | null = where === 'selection' ? selection : where === 'view' ? view : null
  const floor = defaults.floor
  const settled = useSettled(form, SEARCH_PAUSE_MS)
  const options = useMemo<SteadyOptions | null>(() => {
    const set = tolerances(settled)
    return set ? { ...set, floor, range, time: axis.values } : null
  }, [settled, floor, range, axis])
  const ready = options !== null && !Object.values(invalid).some(Boolean)
  const windows = useMemo(() => (channels && options ? findSteadyWindows(ds, channels, options) : []), [ds, channels, options])
  const rows = useMemo(() => (speed ? steadyRows(ws, axis, windows, speed.meta.short) : []), [ws, axis, windows, speed])
  const addable = rows.filter((r) => !r.overlaps)
  const chosen = addable.filter((r) => !unticked.has(r.key))
  const repeats = rows.length - addable.length

  const set = (key: keyof Form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }))
  const tick = (key: string, on: boolean) =>
    setUnticked((old) => {
      const next = new Set(old)
      if (on) next.delete(key)
      else next.add(key)
      return next
    })
  const allTicked = chosen.length === addable.length && addable.length > 0
  const someTicked = chosen.length > 0 && !allTicked
  const headerBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someTicked
  }, [someTicked])

  const kind = power ? powerKind(power) : ''
  const kindWord = kind === 'N1' ? kind : kind.toLowerCase()
  const add = (event?: FormEvent) => {
    event?.preventDefault()
    if (!speed || !chosen.length || !options) return
    const checks = [`${speed.meta.short} within ± ${formatNumber(options.speedTol, 3)} ${unit}`]
    if (channels?.vvi) checks.push(`VS within ± ${formatNumber(options.vviTol, 3)} fpm`)
    else if (channels?.altitude) checks.push(`altitude within ± ${formatNumber(options.vviTol, 3)} ft/min`)
    if (channels?.bank && options.bankTol !== null) checks.push(`bank within ± ${formatNumber(options.bankTol, 3)}°`)
    if (power && options.powerTol !== null) checks.push(`${kindWord} within ± ${formatNumber(options.powerTol, 3)} %`)
    const note = `Found steady: ${checks.join(', ')}, at least ${formatNumber(options.minDuration, 3)} s.`
    const added = addPointsWithUndo(
      ds.id,
      chosen.map((r) => ({ name: r.name, start: r.window.start, end: r.window.end, note })),
      target,
    )
    if (added) onClose()
  }

  const short = speed?.meta.short ?? 'Speed'
  const lead = conditions([
    ...(channels?.vvi ? ['the vertical speed stays near zero'] : channels?.altitude ? ['the altitude holds'] : []),
    ...(channels?.bank ? ['the wings level'] : []),
    ...(power ? [`the ${kindWord} steady`] : []),
  ])
  return (
    <Modal
      title="Find steady points"
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
            data-testid="steady-add"
          >
            Add {chosen.length} test point{chosen.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <form id={formId} className="pt-tool" onSubmit={add} noValidate data-testid="steady-dialog">
        {!speed ? (
          <div className="callout callout-warning" role="note">
            <InfoIcon size={16} />
            <span>This file has no airspeed channel (KIAS, KEAS or KTAS), so there is no speed to hold.</span>
          </div>
        ) : (
          <>
            <p className="pt-tool-lead">
              Finds stretches where the {short} holds within the tolerance (its scatter and its trend across the window)
              {lead ? `, ${lead}` : ''}, for at least the minimum time — never across a sim reset or a recording gap, nothing
              slower than {formatNumber(defaults.floor, 2)} {unit}. Each window keeps to the steady core of the hold.
            </p>
            {!checksLevel && (
              <div className="callout callout-warning" role="note" data-testid="steady-level-note">
                <InfoIcon size={16} />
                <span>
                  This file has no vertical speed or altitude, so level flight is not checked: a climb or a descent at a
                  steady speed counts as steady.
                </span>
              </div>
            )}
            <fieldset className="pt-tool-settings">
              <legend className="sr-only">Settings</legend>
              {speeds.length > 1 && (
                <label className="field">
                  <span className="field-label">Speed</span>
                  <select className="select select-sm" value={speed.id} onChange={(e) => setSpeedId(e.target.value)}>
                    {speeds.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.meta.short}
                        {c.meta.label && c.meta.label !== c.meta.short ? ` — ${c.meta.label}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <NumberField
                label={`Speed within ± (${unit})`}
                value={form.speedTol}
                invalid={invalid.speedTol}
                step="0.5"
                onChange={set('speedTol')}
                testId="steady-speed-tol"
                autoFocus
              />
              {checksLevel && (
                <NumberField
                  label={channels?.vvi ? 'Vertical speed within ± (fpm)' : 'Altitude drift within ± (ft/min)'}
                  value={form.vviTol}
                  invalid={invalid.vviTol}
                  step="10"
                  onChange={set('vviTol')}
                  testId="steady-vvi-tol"
                />
              )}
              <NumberField
                label="At least (s)"
                value={form.minDuration}
                invalid={invalid.minDuration}
                step="5"
                onChange={set('minDuration')}
                testId="steady-min-duration"
              />
              {channels?.bank && (
                <NumberField
                  label="Bank within ± (°)"
                  value={form.bankTol}
                  invalid={invalid.bankTol}
                  step="1"
                  onChange={set('bankTol')}
                  title="The mean bank, and its swings within 40 % of this. Leave empty to allow turns"
                />
              )}
              {power && (
                <NumberField
                  label={`${kind} within ± (%)`}
                  value={form.powerTol}
                  invalid={invalid.powerTol}
                  step="1"
                  onChange={set('powerTol')}
                  title={`${power.meta.label} (${power.meta.short}), as a share of its level. Leave empty to allow power changes`}
                  testId="steady-power-tol"
                />
              )}
              {(selection || view) && (
                <label className="field">
                  <span className="field-label">Search</span>
                  <select className="select select-sm" value={where} onChange={(e) => setScope(e.target.value as Scope)}>
                    <option value="all">The whole log</option>
                    {selection && <option value="selection">The selection ({rangeText(ds, axis, selection)})</option>}
                    {view && <option value="view">The zoom range ({rangeText(ds, axis, view)})</option>}
                  </select>
                </label>
              )}
            </fieldset>

            <p className="pt-tool-status" role="status">
              {!ready ? (
                'Type a number in each field.'
              ) : rows.length === 0 ? (
                `No steady stretches with these settings: try a wider tolerance${power && options?.powerTol !== null ? `, a wider ${kindWord} band` : ''} or a shorter minimum time.`
              ) : (
                <>
                  <CheckCircleIcon size={14} />
                  Found {rows.length} steady stretch{rows.length === 1 ? '' : 'es'}
                  {repeats > 0 ? ` · ${repeats} already ${repeats === 1 ? 'is a test point' : 'are test points'} (not added)` : ''}
                  {addable.length > 0 && chosen.length < addable.length ? ` · ${chosen.length} of ${addable.length} ticked` : ''}
                </>
              )}
            </p>

            {rows.length > 0 && (
              <div className="table-wrap pt-tool-table-wrap">
                <table className="table pt-tool-table" data-testid="steady-table">
                  <thead>
                    <tr>
                      <th scope="col" className="pt-tool-check">
                        <input
                          ref={headerBox}
                          type="checkbox"
                          aria-label="Add every new stretch"
                          checked={allTicked}
                          disabled={!addable.length}
                          onChange={(e) => setUnticked(e.target.checked ? new Set() : new Set(addable.map((r) => r.key)))}
                        />
                      </th>
                      <th scope="col">Name</th>
                      <th scope="col" title={`First and last row on the time axis (${axis.label})`}>
                        Window ({axis.label.toLowerCase()})
                      </th>
                      <th scope="col" className="num">
                        Duration
                      </th>
                      <th scope="col" className="num">
                        {short} <span className="pt-th-unit">{unit}</span>
                      </th>
                      <th scope="col" className="num">
                        Drift <span className="pt-th-unit">{unit}/min</span>
                      </th>
                      {channels?.vvi && (
                        <th scope="col" className="num">
                          VS <span className="pt-th-unit">fpm</span>
                        </th>
                      )}
                      {channels?.altitude && (
                        <th scope="col" className="num">
                          Alt drift <span className="pt-th-unit">ft/min</span>
                        </th>
                      )}
                      {power && (
                        <th scope="col" className="num" title={`${power.meta.label}: its trend across the window, as a share of its mean`}>
                          {power.meta.short} drift <span className="pt-th-unit">%/min</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <SteadyRowView
                        key={row.key}
                        row={row}
                        vs={!!channels?.vvi}
                        altitude={!!channels?.altitude}
                        power={power}
                        ticked={!row.overlaps && !unticked.has(row.key)}
                        onTick={(on) => tick(row.key, on)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  )
}

function SteadyRowView({
  row,
  vs,
  altitude,
  power,
  ticked,
  onTick,
}: {
  row: SteadyRow
  /** Show the vertical speed and altitude drift columns (the file has those channels) */
  vs: boolean
  altitude: boolean
  power: Channel | null
  ticked: boolean
  onTick: (on: boolean) => void
}) {
  const w = row.window
  const speed = formatMeanSd(w.speed.mean, w.speed.std)
  const vvi = w.vvi ? { mean: formatFixed(w.vvi.mean, 0), sd: formatFixed(w.vvi.std, 0) } : null
  const label = row.overlaps ? `Already a test point: ${row.overlaps.name}` : `Add ${row.name}`
  const level = w.power ? formatMeanSd(w.power.mean, w.power.std) : null
  const unit = power?.meta.unit ? ` ${power.meta.unit}` : ''
  return (
    <tr className={row.overlaps ? 'pt-tool-row is-repeat' : 'pt-tool-row'} data-testid="steady-row">
      <td className="pt-tool-check">
        <input type="checkbox" aria-label={label} checked={ticked} disabled={!!row.overlaps} onChange={(e) => onTick(e.target.checked)} />
      </td>
      <td className="pt-tool-name">
        {row.overlaps ? (
          <span className="subtle" title="It overlaps this saved test point, so it is not added again">
            Already a test point: {row.overlaps.name}
          </span>
        ) : (
          row.name
        )}
      </td>
      <td className="num pt-tool-window">{row.range}</td>
      <td className="num">{formatDuration(w.seconds)}</td>
      <td className="num">
        {speed.mean}
        {speed.sd && <span className="pt-sd"> ± {speed.sd}</span>}
      </td>
      <td className="num">{signedText(w.speed.drift, 1)}</td>
      {vs && (
        <td className="num">
          {vvi ? (
            <>
              {vvi.mean}
              {vvi.sd && <span className="pt-sd"> ± {vvi.sd}</span>}
            </>
          ) : (
            '—'
          )}
        </td>
      )}
      {altitude && <td className="num">{signedText(w.altDrift, 1)}</td>}
      {power && (
        <td className="num" title={level ? `${power.meta.short} ${level.mean}${level.sd ? ` ± ${level.sd}` : ''}${unit}` : undefined}>
          {signedText(w.power && w.power.mean !== 0 ? (100 * w.power.drift) / Math.abs(w.power.mean) : NaN, 1)}
        </td>
      )}
    </tr>
  )
}

function NumberField({
  label,
  value,
  invalid,
  step,
  onChange,
  title,
  testId,
  autoFocus,
}: {
  label: string
  value: string
  invalid: boolean
  step: string
  onChange: (event: { target: { value: string } }) => void
  title?: string
  testId?: string
  autoFocus?: boolean
}) {
  return (
    <label className="field pt-tool-number" title={title}>
      <span className="field-label">{label}</span>
      <input
        className="input input-sm num"
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        value={value}
        aria-invalid={invalid}
        data-autofocus={autoFocus ? true : undefined}
        data-testid={testId}
        onChange={onChange}
        onKeyDown={(event) => {
          // The preview follows the field as it is typed: Enter here must not add the points.
          if (event.key === 'Enter') event.preventDefault()
        }}
      />
    </label>
  )
}
