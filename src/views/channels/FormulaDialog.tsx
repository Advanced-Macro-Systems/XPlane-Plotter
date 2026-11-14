// The formula editor of the Channels tab: name, unit and expression with live validation — syntax first (with a caret
// under the error), then evaluation over the whole file for a preview — the channel names, functions and constants to
// insert at the cursor, and ready-made presets. Saving goes through the store's saveDerived, which checks it again.
// Pure logic lives in formulaCheck.ts.

import { AlertIcon, CheckCircleIcon, InfoIcon } from '@primer/octicons-react'
import { useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatNumber } from '../../charts/format'
import { Segmented } from '../../components/Segmented'
import { Sparkline } from '../../components/Sparkline'
import { availablePresets, withDerived, type DerivedPreset } from '../../core/analysis/derived'
import type { Dataset, DerivedDef, Workspace } from '../../core/types'
import { saveDerived } from '../../store/app'
import { Modal } from '../../ui/Modal'
import {
  FORMULA_HELP,
  aliasEntries,
  caretLocation,
  checkFormula,
  formulaDependents,
  formulaSlug,
  formulasBefore,
  insertCompletion,
  predictFormulaId,
  suggestAliases,
  suggestHelp,
  wordAtCaret,
} from './formulaCheck'

interface Form {
  name: string
  unit: string
  expression: string
  /** The preset the form was filled from (its id becomes the channel id while the name is the preset's) */
  presetId: string | null
}

/** A new formula's unsaved text, kept when the dialog closes without saving (say, after a stray click outside it). */
const drafts = new Map<string, Form>()

const EMPTY: Form = { name: '', unit: '', expression: '', presetId: null }

function initialForm(datasetId: string, editing: DerivedDef | null, preset: DerivedPreset | null): Form {
  if (editing) return { name: editing.name, unit: editing.unit, expression: editing.expression, presetId: null }
  if (preset) return { name: preset.name, unit: preset.unit, expression: preset.expression, presetId: preset.id }
  return drafts.get(datasetId) ?? EMPTY
}

/** Marks the <dialog> element for the end-to-end tests (Modal takes no test id of its own). */
function tagDialog(element: HTMLElement | null): void {
  element?.closest('dialog')?.setAttribute('data-testid', 'formula-dialog')
}

type InsertTab = 'channels' | 'functions'

/** Channel names listed at once (typing narrows the list). */
const LIST_LIMIT = 80

const count = (n: number) => n.toLocaleString('en-GB')

export function FormulaDialog({
  ds,
  ws,
  editing,
  preset,
  onClose,
  onSaved,
}: {
  ds: Dataset
  ws: Workspace
  /** The formula to edit; null for a new one */
  editing: DerivedDef | null
  /** A preset to start a new formula from */
  preset: DerivedPreset | null
  onClose: () => void
  /** After a successful save: the channel id and the name */
  onSaved: (id: string, name: string) => void
}) {
  const [form, setForm] = useState<Form>(() => initialForm(ds.id, editing, preset))
  const { name, unit, expression, presetId } = form
  const [caret, setCaret] = useState(() => form.expression.length)
  const [tab, setTab] = useState<InsertTab>('channels')
  const [saveError, setSaveError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const nameId = useId()
  const unitId = useId()
  const expressionId = useId()
  const statusId = useId()

  // What the formula can refer to: the file's channels and the formulas before it (all of them for a new one).
  const defsBefore = useMemo(() => formulasBefore(ws.derived, editing?.id ?? null), [ws.derived, editing])
  const base = useMemo(() => (editing ? withDerived(ds, defsBefore).dataset : ds), [ds, editing, defsBefore])
  const typed = useDeferredValue(expression)
  const check = useMemo(() => checkFormula(ds, defsBefore, typed, base), [ds, defsBefore, typed, base])

  const presets = useMemo(
    () => (editing ? [] : availablePresets(ds).filter((p) => !ws.derived.some((d) => d.id === `fx:${p.id}`))),
    [ds, editing, ws.derived],
  )
  const activePreset = presets.find((p) => p.id === presetId && p.name === name.trim()) ?? null
  const dependents = useMemo(() => (editing ? formulaDependents(ws.derived, editing.id) : []), [ws.derived, editing])
  const slug = formulaSlug(name, editing, activePreset?.id ?? null, dependents.length > 0)
  const alias = predictFormulaId(ds, slug, editing?.id ?? null).replace(/^fx:/, '')

  const word = wordAtCaret(expression, caret)
  const entries = useMemo(() => aliasEntries(base.channels), [base])
  const channelMatches = useMemo(() => suggestAliases(entries, word.prefix, Infinity), [entries, word.prefix])
  const channelsShown = channelMatches.slice(0, LIST_LIMIT)
  const functionMatches = useMemo(() => suggestHelp(FORMULA_HELP.functions, word.prefix), [word.prefix])
  const constantMatches = useMemo(() => suggestHelp(FORMULA_HELP.constants, word.prefix), [word.prefix])

  const canSave = name.trim() !== '' && check.status === 'ok'
  const blocker = !name.trim()
    ? 'Name the formula to save it.'
    : check.status === 'empty'
      ? 'Write the formula to save it.'
      : check.status === 'error'
        ? 'Fix the formula to save it.'
        : null

  const edit = (next: Partial<Form>) => {
    setForm((f) => ({ ...f, ...next }))
    setSaveError(null)
  }

  // After inserting text, put the cursor back in the formula, just after what was inserted.
  useLayoutEffect(() => {
    const element = textareaRef.current
    const at = pendingCaret.current
    if (!element || at === null) return
    pendingCaret.current = null
    element.focus()
    element.setSelectionRange(at, at)
  }, [expression])

  const insert = (text: string, caretOffset?: number) => {
    const at = textareaRef.current?.selectionStart ?? caret
    const next = insertCompletion(expression, at, text, caretOffset)
    edit({ expression: next.text })
    setCaret(next.caret)
    pendingCaret.current = next.caret
  }

  const goTo = (position: number) => {
    const element = textareaRef.current
    if (!element) return
    element.focus()
    element.setSelectionRange(position, position)
    setCaret(position)
  }

  const applyPreset = (p: DerivedPreset) => {
    edit({ name: p.name, unit: p.unit, expression: p.expression, presetId: p.id })
    setCaret(p.expression.length)
  }

  const close = () => {
    if (!editing) {
      if (name.trim() || expression.trim()) drafts.set(ds.id, form)
      else drafts.delete(ds.id)
    }
    onClose()
  }

  const save = () => {
    if (!canSave) return
    const result = saveDerived({ name, unit, expression }, slug, editing?.id)
    if (!result.ok) {
      setSaveError(result.error)
      return
    }
    if (!editing) drafts.delete(ds.id)
    onSaved(result.id, name.trim())
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      save()
    }
  }

  const where = check.status === 'error' && check.position !== null ? caretLocation(typed, check.position) : null
  const multiLine = typed.includes('\n')

  const footer = (
    <div className="ch-fd-footer">
      {saveError ? (
        <p className="field-error ch-fd-save-error" role="alert">
          {saveError}
        </p>
      ) : (
        blocker && <p className="ch-fd-blocker">{blocker}</p>
      )}
      <button type="button" className="btn btn-ghost" onClick={close}>
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary"
        data-testid="formula-save"
        disabled={!canSave}
        title="Ctrl+Enter"
        onClick={save}
      >
        {editing ? 'Save changes' : 'Save formula'}
      </button>
    </div>
  )

  return (
    <Modal title={editing ? `Edit ${editing.name}` : 'New formula'} onClose={close} width={960} className="ch-fd" footer={footer}>
      <div ref={tagDialog} className="ch-fd-grid" onKeyDown={onKeyDown}>
        <div className="ch-fd-form">
          {presets.length > 0 && (
            <div className="ch-fd-presets">
              <span className="field-label">Start from a preset</span>
              <div className="ch-fd-chips" role="group" aria-label="Presets">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="ch-pill"
                    aria-pressed={activePreset?.id === p.id}
                    title={p.description}
                    onClick={() => applyPreset(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="ch-fd-names">
            <div className="field">
              <label className="field-label" htmlFor={nameId}>
                Name
              </label>
              <input
                id={nameId}
                className="input"
                value={name}
                maxLength={80}
                placeholder="e.g. Dynamic pressure"
                autoComplete="off"
                data-autofocus={editing ? undefined : ''}
                onChange={(e) => edit({ name: e.target.value })}
              />
              <p className="field-hint ch-fd-hint">
                {!name.trim() ? (
                  'Shown in legends and channel lists.'
                ) : dependents.length > 0 ? (
                  <>
                    {dependents.map((d) => d.name).join(', ')} {dependents.length === 1 ? 'uses' : 'use'} it as{' '}
                    <code>{alias}</code>, so that name stays.
                  </>
                ) : (
                  <>
                    In other formulas: <code>{alias}</code>
                  </>
                )}
              </p>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={unitId}>
                Unit
              </label>
              <input
                id={unitId}
                className="input"
                value={unit}
                maxLength={24}
                placeholder="e.g. Pa"
                autoComplete="off"
                onChange={(e) => edit({ unit: e.target.value })}
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor={expressionId}>
              Formula
            </label>
            <textarea
              ref={textareaRef}
              id={expressionId}
              className="textarea ch-fd-expression"
              data-testid="formula-expression"
              data-autofocus={editing ? '' : undefined}
              value={expression}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              placeholder="e.g. 0.5 * rho0 * (Vind_keas * kt2ms)^2"
              aria-invalid={check.status === 'error'}
              aria-describedby={statusId}
              onChange={(e) => {
                edit({ expression: e.target.value })
                setCaret(e.target.selectionStart)
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            />
            <div id={statusId} aria-live="polite">
              {check.status === 'error' ? (
                <div className="ch-fd-status ch-fd-error">
                  <p className="ch-fd-error-text">
                    <AlertIcon size={16} />
                    <span>{check.message}</span>
                  </p>
                  {where && check.position !== null && (
                    <>
                      <pre className="ch-fd-caret" aria-hidden="true">
                        {where.lineText || ' '}
                        {'\n'}
                        {' '.repeat(where.column)}
                        <span className="ch-fd-caret-mark">^</span>
                        {multiLine ? `  line ${where.line}, column ${where.column + 1}` : ''}
                      </pre>
                      <button
                        type="button"
                        className="btn btn-xs btn-outline ch-fd-goto"
                        onClick={() => goTo(check.position ?? 0)}
                      >
                        Put the cursor there
                      </button>
                    </>
                  )}
                </div>
              ) : check.status === 'ok' ? (
                <p className="ch-fd-status ch-fd-ok">
                  <CheckCircleIcon size={16} />
                  <span>
                    Valid.{' '}
                    {check.refs.length ? (
                      <>
                        Uses{' '}
                        {check.refs.map((ref, i) => (
                          <span key={ref}>
                            {i > 0 && ', '}
                            <code>{ref}</code>
                          </span>
                        ))}
                        .
                      </>
                    ) : (
                      'It uses no channel: the same value on every row.'
                    )}
                  </span>
                </p>
              ) : (
                <p className="ch-fd-status">
                  <InfoIcon size={16} />
                  <span>
                    Channel names from the list, numbers, + − * / ^, comparisons, functions such as{' '}
                    <code>sqrt(x)</code> or <code>diff(x)</code> and constants such as <code>g0</code>. It is worked
                    out row by row over the whole file.
                  </span>
                </p>
              )}
            </div>
          </div>

          {activePreset && (
            <div className="callout callout-info ch-fd-preset-note">
              <InfoIcon size={16} />
              <span>{activePreset.description}</span>
            </div>
          )}

          {check.status === 'ok' && (
            <section className="ch-fd-preview" aria-label="Preview">
              <div className="ch-fd-preview-head">
                <span className="eyebrow">Preview</span>
                <span className="ch-fd-insert-match num">{previewNote(check.stats.finite, check.stats.constant, ds.rowCount)}</span>
              </div>
              <div className="ch-fd-stats">
                <Stat label="Min" value={check.stats.min} unit={unit} />
                <Stat label="Mean" value={check.stats.mean} unit={unit} />
                <Stat label="Max" value={check.stats.max} unit={unit} />
                <Stat label="σ" value={check.stats.std} unit={unit} />
              </div>
              <div className="ch-fd-spark">
                <Sparkline
                  x={ds.elapsed}
                  y={check.values}
                  width={520}
                  height={44}
                  buckets={260}
                  ariaLabel="The formula over the whole file, against elapsed time"
                />
              </div>
            </section>
          )}
        </div>

        <aside className="ch-fd-insert" aria-label="Insert into the formula">
          <div className="ch-fd-insert-head">
            <Segmented<InsertTab>
              value={tab}
              ariaLabel="What to insert"
              onChange={setTab}
              options={[
                { value: 'channels', label: `Channels · ${channelMatches.length}` },
                { value: 'functions', label: `Functions · ${functionMatches.length + constantMatches.length}` },
              ]}
            />
            <span className="ch-fd-insert-match">
              {word.prefix ? `Matching “${word.prefix}”` : 'Click to insert at the cursor'}
            </span>
          </div>
          {tab === 'channels' ? (
            <ul className="ch-fd-list" aria-label="Channels">
              {channelsShown.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="ch-fd-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(entry.alias)}
                    title={`Insert ${entry.alias}`}
                  >
                    <code>{entry.alias}</code>
                    <span>
                      {entry.label}
                      {entry.unit ? ` · ${entry.unit}` : ''}
                      {entry.formula ? ' · formula' : ''}
                      {entry.constant ? ' · constant' : ''}
                    </span>
                  </button>
                </li>
              ))}
              {channelMatches.length > channelsShown.length && (
                <li className="ch-fd-none">
                  {count(channelMatches.length - channelsShown.length)} more: type part of a name to narrow the list.
                </li>
              )}
              {channelMatches.length === 0 && (
                <li className="ch-fd-none">No channel name contains “{word.prefix}”.</li>
              )}
            </ul>
          ) : (
            <ul className="ch-fd-list" aria-label="Functions and constants">
              {functionMatches.length > 0 && <li className="ch-fd-list-heading">Functions</li>}
              {functionMatches.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="ch-fd-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(`${entry.name}()`, entry.name.length + 1)}
                    title={`Insert ${entry.name}()`}
                  >
                    <code>{entry.signature}</code>
                    <span>{entry.description}</span>
                  </button>
                </li>
              ))}
              {constantMatches.length > 0 && <li className="ch-fd-list-heading">Constants</li>}
              {constantMatches.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="ch-fd-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(entry.name)}
                    title={`Insert ${entry.name}`}
                  >
                    <code>{entry.name}</code>
                    <span>{entry.description}</span>
                  </button>
                </li>
              ))}
              {functionMatches.length + constantMatches.length === 0 && (
                <li className="ch-fd-none">No function or constant contains “{word.prefix}”.</li>
              )}
            </ul>
          )}
        </aside>
      </div>
    </Modal>
  )
}

/** "All 6,961 rows have a value", "120 of 6,961 rows…", or that every row has the same value. */
function previewNote(finite: number, constant: boolean, rowCount: number): string {
  if (finite === 0) return 'No row has a value: check the channels it uses'
  const rows = finite === rowCount ? `All ${count(rowCount)} rows have a value` : `${count(finite)} of ${count(rowCount)} rows have a value`
  return constant ? `${rows}, the same on every row` : rows
}

function Stat({ label, value, unit }: { label: string; value: number; unit: string }) {
  const text = formatNumber(value, 4)
  return (
    <div className="ch-fd-stat">
      <span className="ch-fd-stat-label">{label}</span>
      <span className="ch-fd-stat-value num" title={unit ? `${text} ${unit}` : text}>
        {text}
      </span>
    </div>
  )
}
