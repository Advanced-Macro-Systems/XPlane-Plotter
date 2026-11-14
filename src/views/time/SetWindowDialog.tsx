// "Set window…": type the start and end of a time window on the current time axis, then select it (to save as a test
// point, analyse, ...) or zoom to it. The keyboard way to do what a drag does in Select mode.

import { useId, useState, type FormEvent } from 'react'
import { rangeText } from '../../components/hooks'
import { formatTimeRange } from '../../components/timeText'
import { rangeToRows } from '../../core/time'
import type { Dataset, RowRange, TimeAxis } from '../../core/types'
import { setSelection } from '../../store/app'
import { Modal } from '../../ui/Modal'
import { axisInputText, parseAxisInput, type XFrame } from './timeMath'

interface SetWindowDialogProps {
  ds: Dataset
  axis: TimeAxis
  frame: XFrame
  /** The rows the fields start with: the selection, else what the panels show */
  initial: RowRange
  onZoom: (rows: RowRange) => void
  onClose: () => void
}

function fieldHint(axis: TimeAxis): string {
  if (axis.clock) return 'Clock time, hh:mm:ss'
  if (axis.id === 'index') return 'Row number'
  return axis.unit ? `${axis.label} [${axis.unit}]` : axis.label
}

export function SetWindowDialog({ ds, axis, frame, initial, onZoom, onClose }: SetWindowDialogProps) {
  const formId = useId()
  const errorId = useId()
  const n = axis.values.length
  const last = Math.max(initial[0], initial[1] - 1)
  const [from, setFrom] = useState(() => axisInputText(axis, axis.values[initial[0]], frame.step))
  const [to, setTo] = useState(() => axisInputText(axis, axis.values[last], frame.step))
  const [tried, setTried] = useState(false)

  const lo = parseAxisInput(axis, from)
  const hi = parseAxisInput(axis, to)
  const rows: RowRange | null = lo !== null && hi !== null && n > 0 ? rangeToRows(axis.values, lo, hi) : null
  const error =
    lo === null || hi === null
      ? axis.clock
        ? 'Type both times as hh:mm:ss, for example 09:15:30.'
        : `Type both ${axis.id === 'index' ? 'row numbers' : 'times'} as numbers, for example ${axisInputText(axis, axis.values[0], frame.step) || '0'}.`
      : null
  const showError = tried && error !== null

  const apply = (action: 'select' | 'zoom') => {
    setTried(true)
    if (!rows) return
    if (action === 'select') setSelection(rows)
    else onZoom(rows)
    onClose()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    apply('select')
  }

  const hint = fieldHint(axis)
  return (
    <Modal
      title="Set the time window"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-outline" onClick={() => apply('zoom')}>
            Zoom to it
          </button>
          <button type="submit" form={formId} className="btn btn-primary" data-testid="set-window-select">
            Select
          </button>
        </>
      }
    >
      <form id={formId} className="tv-save" onSubmit={submit} noValidate>
        <p className="field-hint">
          On the {axis.label.toLowerCase()} axis. The log runs{' '}
          <span className="num">{formatTimeRange(axis, axis.values[0], axis.values[n - 1])}</span>.
        </p>
        <div className="tv-window-fields">
          <label className="field">
            <span className="field-label">From</span>
            <input
              className="input num"
              value={from}
              inputMode={axis.clock ? 'text' : 'decimal'}
              spellCheck={false}
              autoComplete="off"
              placeholder={axis.clock ? 'hh:mm:ss' : undefined}
              title={hint}
              aria-invalid={showError && lo === null}
              aria-describedby={showError ? errorId : undefined}
              data-autofocus
              data-testid="set-window-from"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <input
              className="input num"
              value={to}
              inputMode={axis.clock ? 'text' : 'decimal'}
              spellCheck={false}
              autoComplete="off"
              placeholder={axis.clock ? 'hh:mm:ss' : undefined}
              title={hint}
              aria-invalid={showError && hi === null}
              aria-describedby={showError ? errorId : undefined}
              data-testid="set-window-to"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
        {showError ? (
          <p id={errorId} className="tv-window-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="tv-save-range num" aria-live="polite">
            {rows ? `${rangeText(ds, axis, rows)} · ${(rows[1] - rows[0]).toLocaleString('en-GB')} rows` : '—'}
          </p>
        )}
      </form>
    </Modal>
  )
}
