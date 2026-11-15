// The Dynamic modes tab's "Test validity" card: was this window's mode excited and recorded the way the lectures, Cook
// and the NATO handbook ask (trimmed start, a suitable input, autopilot, yaw damper and autothrottle off, controls
// fixed, a long enough record, an accepted fit)? The verdict, what the input detection found, every check with its
// criterion and source, and the settings the checks need (the mode, a declared augmented run, test limits).

import { CopyIcon } from '@primer/octicons-react'
import { CheckList, VerdictBanner } from '../../components/Checklist'
import { Segmented } from '../../components/Segmented'
import { MODE_IDS, MODE_NAMES, type DynamicReport, type ModeId } from '../../core/checklists/dynamic'
import { copyText } from '../../core/export/download'
import type { Dataset, ModesCheckSettings, TestPoint, Workspace } from '../../core/types'
import { setModesCheck, toast } from '../../store/app'
import { checklistMode, modeChecklistCsv } from './modeChecksModel'

const fix = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d).replace('-', '−') : '—')

export function ModesChecklist({
  ds,
  ws,
  report,
  point,
  windowName,
  fitting,
}: {
  ds: Dataset
  ws: Workspace
  report: DynamicReport | null
  point: TestPoint | null
  windowName: string
  fitting: boolean
}) {
  const { mode, from } = checklistMode(ds, ws, point)
  const check = ws.modes.check ?? {}
  const copy = async () => {
    if (!report) return
    const ok = await copyText(modeChecklistCsv(report, windowName, '\t'))
    toast(ok ? 'Copied the checklist as tab-separated values.' : 'Could not copy: the clipboard is not available here.', ok ? 'success' : 'error')
  }
  return (
    <section className="card md-checklist" data-testid="modes-checklist" aria-labelledby="md-checklist-title">
      <header className="card-header md-cl-header">
        <div className="md-cl-heading">
          <h3 className="card-title" id="md-checklist-title">
            Test validity
          </h3>
          <span className="md-cl-sub">
            {mode ? `${MODE_NAMES[mode]} run, judged against the lectures, Cook and the NATO flight-test handbook` : 'Which mode is this window?'}
            {fitting ? ' · updating with the fit…' : ''}
          </span>
        </div>
        <div className="md-cl-actions">
          <label className="md-cl-mode">
            <span className="sr-only">Mode</span>
            <select
              className="select select-sm"
              aria-label="Mode the checklist judges"
              value={check.mode ?? ''}
              onChange={(e) => setModesCheck({ mode: (e.target.value || undefined) as ModeId | undefined })}
            >
              <option value="">{mode && from !== 'setting' ? `${MODE_NAMES[mode]} (from the ${from})` : 'Choose the mode'}</option>
              {MODE_IDS.map((id) => (
                <option key={id} value={id}>
                  {MODE_NAMES[id]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-sm btn-ghost" disabled={!report} onClick={() => void copy()}>
            <CopyIcon size={14} /> Copy
          </button>
        </div>
      </header>
      <div className="card-body md-cl-body">
        {!report ? (
          <p className="md-cl-empty">
            Choose the mode above (or use a quick pick, or name the test point after the mode) to check the run: the trim before the
            input, the input, the autopilot, yaw damper and throttle, the controls during the response and the fit.
          </p>
        ) : (
          <>
            <VerdictBanner verdict={report.verdict} testId="modes-checklist-verdict">
              <span className="md-cl-label">{report.label}</span>
            </VerdictBanner>
            <p className="md-cl-windows">
              {report.input
                ? `Input: ${report.input.shape} on ${report.input.channelId}, ${fix(report.input.startT)}–${fix(report.input.endT)} s (${fix(report.input.duration, 2)} s, ${report.input.variant === 'onset' ? 'the window starts at its onset' : 'then the free response'}).`
                : report.estimatedInput !== null
                  ? `No control channel is logged: the input was estimated from the response, at ${fix(report.estimatedInput)} s.`
                  : 'No input found on the mode’s control axis before the window.'}{' '}
              {report.trim ? `Trim window T: ${fix(report.trim.seconds)} s before the input${report.trim.cut ? ` (cut short by ${report.trim.cut === 'input' ? (report.trim.settled ? 'an earlier input and its response' : 'an earlier input') : 'the log start or a gap'})` : ''}.` : ''}
            </p>
            <DynamicSettings check={check} />
            <CheckList checks={report.checks} testId="modes-checklist-list" rowTestId="modes-checklist-row" />
            <p className="md-cl-foot">
              <span className="ck-tag">judgement</span> marks thresholds no source gives as numbers (engineering judgement). Rows
              not logged read “Not checkable — log row N”: tick them in X-Plane’s Data Output for the next run.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

function DynamicSettings({ check }: { check: ModesCheckSettings }) {
  const limits = check.limits ?? {}
  const setLimit = (key: keyof NonNullable<ModesCheckSettings['limits']>, value: string) => {
    const v = Number(value)
    const next = { ...limits, [key]: value.trim() && Number.isFinite(v) && v > 0 ? v : undefined }
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k]
    setModesCheck({ limits: Object.keys(next).length ? next : undefined })
  }
  return (
    <details className="md-cl-settings">
      <summary>Settings</summary>
      <div className="md-cl-grid">
        <div className="field">
          <span className="field-label">Yaw damper during the run</span>
          <Segmented<'off' | 'on'>
            value={check.yawDamper ?? 'off'}
            ariaLabel="Yaw damper during the run"
            onChange={(v) => setModesCheck({ yawDamper: v === 'on' ? 'on' : undefined })}
            options={[
              { value: 'off', label: 'Off (bare airframe)' },
              { value: 'on', label: 'On (augmented run)' },
            ]}
          />
        </div>
        {(
          [
            ['vsKias', 'Stall speed V_S (KIAS)'],
            ['vmoKias', 'V_MO (KIAS)'],
            ['mmo', 'M_MO'],
            ['alphaMaxDeg', 'Largest α (deg)'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="field">
            <span className="field-label">{label}</span>
            <input className="input input-sm" inputMode="decimal" defaultValue={limits[key] ?? ''} placeholder="not set" onBlur={(e) => setLimit(key, e.target.value)} />
          </label>
        ))}
      </div>
    </details>
  )
}
