// The X–Y plot's tables: range and endurance (when its markers are on: V_E, V_R and the curve there, per fit), fit
// results (equation, R², RMSE, n, coefficients ± standard error) and, with test points, the mean ± σ of x and every Y
// channel per point. Each copies as TSV with plain numbers (paste into Excel or MATLAB).

import { AlertIcon, CopyIcon } from '@primer/octicons-react'
import { useMemo } from 'react'
import { MISSING, formatNumber } from '../../charts/format'
import { channelTitle } from '../../core/channels'
import { PHYSICAL_RATIO } from '../../core/analysis/rangeEndurance'
import { copyText } from '../../core/export/download'
import type { XYConfig } from '../../core/types'
import { toast } from '../../store/app'
import { formatMeanSd } from '../points/pointsModel'
import type { XYChecklist } from '../points/checklistModel'
import { SlotSwatch } from './Glyphs'
import { XYChecklistSummary } from './XYChecklistSummary'
import type { XYData, XYFit } from './xyModel'
import type { XYRange } from './xyRange'
import {
  fitKindName,
  fitRows,
  fitTableTsv,
  meanRows,
  meansTableTsv,
  rangeRows,
  rangeTableTsv,
  type FitRow,
  type RangeRow,
} from './xyTables'

async function copyTable(text: string, what: string): Promise<void> {
  const ok = await copyText(text)
  if (ok) toast(`Copied the ${what} as tab-separated values: paste into Excel or MATLAB.`, 'success')
  else toast('The browser did not allow copying. Use Export → CSV instead.', 'error')
}

function MeanSd({ mean, sd }: { mean: number; sd: number }) {
  const text = formatMeanSd(mean, sd)
  return (
    <span className="xy-meansd">
      {text.mean}
      {text.sd && <span className="xy-sd"> ± {text.sd}</span>}
    </span>
  )
}

function fitSubtitle(rows: readonly FitRow[]): string {
  if (rows[0].target === 'means') return 'Least squares through the test-point means'
  const left = rows.reduce((sum, r) => sum + r.excluded, 0)
  return left
    ? `Least squares through the samples on the axes (${left.toLocaleString('en-GB')} extreme ones left out)`
    : 'Least squares through the plotted samples'
}

function r2Text(r2: number): string {
  if (!Number.isFinite(r2)) return MISSING
  return r2 >= 0.999 && r2 < 1 ? r2.toFixed(4) : r2.toFixed(3)
}

export function XYResults({
  data,
  fits,
  fit,
  re,
  checklist = null,
}: {
  data: XYData
  fits: readonly XYFit[]
  fit: XYConfig['fit']
  /** Range and endurance per fit; null when its markers are off */
  re: readonly XYRange[] | null
  /** The test-validity checklist's summary, when the plot is a range-and-endurance fit or a trim curve */
  checklist?: XYChecklist | null
}) {
  const rows = useMemo(() => fitRows(data, fits), [data, fits])
  const means = useMemo(() => meanRows(data), [data])
  const showMeans = data.effective.source === 'points' && means.length > 0

  return (
    <div className="view-body xy-tables" id="xy-tables">
      {checklist && <XYChecklistSummary checklist={checklist} fitTarget={data.effective.fitTarget} />}
      {re && <RangeTable data={data} results={re} />}
      <section className="card xy-table-card" data-testid="xy-fit-table" aria-labelledby="xy-fit-title">
        <header className="card-header">
          <div className="xy-table-title">
            <h3 className="card-title" id="xy-fit-title">
              Fit results
            </h3>
            {rows.length > 0 && <span className="xy-table-sub">{fitSubtitle(rows)}</span>}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={rows.length === 0}
            onClick={() => void copyTable(fitTableTsv(data, rows), 'fit results')}
          >
            <CopyIcon size={14} /> Copy table
          </button>
        </header>
        {rows.length === 0 ? (
          <p className="xy-table-empty">
            {fit === 'none'
              ? 'No fit yet. Choose a fit under Fit to see the equation, R² and coefficients here.'
              : 'Nothing to fit: choose channels that have values.'}
          </p>
        ) : (
          <div className="xy-table-scroll">
            <table className="table xy-table">
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col">Equation</th>
                  <th scope="col" className="num">
                    R²
                  </th>
                  <th scope="col" className="num">
                    RMSE
                  </th>
                  <th scope="col" className="num">
                    n
                  </th>
                  <th scope="col">Coefficients ± standard error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <span className="xy-series-cell" title={r.yTitle}>
                        <SlotSwatch slot={r.slot} />
                        <span className="xy-ellipsis">{r.name}</span>
                      </span>
                    </td>
                    {r.problem ? (
                      <td colSpan={5} className="xy-problem">
                        {r.problem}
                      </td>
                    ) : (
                      <>
                        <td className="xy-equation">{r.equation}</td>
                        <td className="num">{r2Text(r.r2)}</td>
                        <td className="num">{formatNumber(r.rmse, 3)}</td>
                        <td className="num">{r.n.toLocaleString('en-GB')}</td>
                        <td>
                          <span className="xy-coefficients">
                            {r.coefficients.map((c) => (
                              <span key={c.power} className="xy-coefficient">
                                <span className="xy-coefficient-name">{c.name}</span>
                                <MeanSd mean={c.value} sd={c.se} />
                              </span>
                            ))}
                          </span>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showMeans && data.x && (
        <section className="card xy-table-card" aria-labelledby="xy-means-title">
          <header className="card-header">
            <div className="xy-table-title">
              <h3 className="card-title" id="xy-means-title">
                Test-point means
              </h3>
              <span className="xy-table-sub">Mean ± 1σ over each point's rows</span>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void copyTable(meansTableTsv(data, means), 'test-point means')}
            >
              <CopyIcon size={14} /> Copy table
            </button>
          </header>
          <div className="xy-table-scroll">
            <table className="table xy-table">
              <thead>
                <tr>
                  <th scope="col">Point</th>
                  <th scope="col">Group</th>
                  <th scope="col" className="num">
                    Rows
                  </th>
                  <th scope="col" className="num">
                    {channelTitle(data.x)}
                  </th>
                  {data.ys.map((y) => (
                    <th key={y.ch.id} scope="col" className="num">
                      {channelTitle(y.ch)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {means.map((m) => (
                  <tr key={m.point.id}>
                    <td className="xy-point-name">
                      <span className="xy-ellipsis" title={m.point.note ? `${m.point.name}\n${m.point.note}` : m.point.name}>
                        {m.point.name}
                      </span>
                    </td>
                    <td>
                      {m.group && (
                        <span className={`chip slot-${m.group.slot}`}>
                          <span className="chip-dot" aria-hidden="true" />
                          {m.group.name}
                        </span>
                      )}
                    </td>
                    <td className="num">{m.rows.toLocaleString('en-GB')}</td>
                    <td className="num">
                      <MeanSd mean={m.x.mean} sd={m.x.std} />
                    </td>
                    {m.ys.map((s, i) => (
                      <td key={data.ys[i].ch.id} className="num">
                        {s ? <MeanSd mean={s.mean} sd={s.std} /> : MISSING}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

/** A value with its unit for the range table ("72.41 kt"), '—' when missing. */
function withUnit(value: number, unit: string): string {
  if (!Number.isFinite(value)) return MISSING
  return unit ? `${formatNumber(value, 4)} ${unit}` : formatNumber(value, 4)
}

function rangeSubtitle(rows: readonly RangeRow[]): string {
  const through = rows[0]?.target === 'means' ? 'the test-point means' : 'the plotted samples'
  return `Max endurance: the fitted curve's minimum. Max range: where the tangent from the origin touches it. Fits through ${through}; for the weight and altitude flown.`
}

/** The tangent's slope unit: "hp/kt". */
function slopeUnit(row: RangeRow): string {
  if (row.yUnit && row.xUnit) return `${row.yUnit}/${row.xUnit}`
  return row.yUnit || (row.xUnit ? `1/${row.xUnit}` : '')
}

/**
 * Range and endurance per fit: the two speeds and the curve there, the tangent's slope, V_R/V_E (beside 3^¼, the
 * physical models' value), the fit, R² and n; extrapolation warnings and missing points under the table. Shown only
 * with a fit chosen (XYView), so an empty table means the fit could not be made.
 */
function RangeTable({ data, results }: { data: XYData; results: readonly XYRange[] }) {
  const rows = useMemo(() => rangeRows(data, results), [data, results])
  const notes = rows.flatMap((r) => r.notes.map((note) => ({ key: `${r.key}|${note}`, name: r.name, note })))
  return (
    <section className="card xy-table-card" data-testid="xy-re-table" aria-labelledby="xy-re-title">
      <header className="card-header">
        <div className="xy-table-title">
          <h3 className="card-title" id="xy-re-title">
            Range &amp; endurance
          </h3>
          {rows.length > 0 && <span className="xy-table-sub">{rangeSubtitle(rows)}</span>}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={rows.length === 0}
          onClick={() => void copyTable(rangeTableTsv(data, rows), 'range and endurance results')}
        >
          <CopyIcon size={14} /> Copy table
        </button>
      </header>
      {rows.length === 0 ? (
        <p className="xy-table-empty">No fit yet: the fit needs more points (see Fit results).</p>
      ) : (
        <>
          <div className="xy-table-scroll">
            <table className="table xy-table xy-re-table">
              <thead>
                <tr>
                  <th scope="col">Series and fit</th>
                  <th scope="col" className="num">
                    V<sub>E</sub> max endurance
                  </th>
                  <th scope="col" className="num">
                    y at V<sub>E</sub>
                  </th>
                  <th scope="col" className="num">
                    V<sub>R</sub> max range
                  </th>
                  <th scope="col" className="num">
                    y at V<sub>R</sub>
                  </th>
                  <th scope="col" className="num">
                    y/V at V<sub>R</sub>
                  </th>
                  <th scope="col" className="num">
                    V<sub>R</sub>/V<sub>E</sub>
                  </th>
                  <th scope="col" className="num">
                    R²
                  </th>
                  <th scope="col" className="num">
                    n
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="xy-re-series">
                      <span className="xy-series-cell" title={r.yTitle}>
                        <SlotSwatch slot={r.slot} />
                        <span className="xy-ellipsis">{r.name}</span>
                      </span>
                      <span className="xy-re-fit">
                        {fitKindName(r.kind)}: {r.equation}
                      </span>
                    </td>
                    <td className="num">
                      <PointValue text={withUnit(r.endurance?.v ?? NaN, r.xUnit)} extrapolated={r.endurance?.extrapolated} />
                    </td>
                    <td className="num">{withUnit(r.endurance?.y ?? NaN, r.yUnit)}</td>
                    <td className="num">
                      <PointValue text={withUnit(r.range?.v ?? NaN, r.xUnit)} extrapolated={r.range?.extrapolated} />
                    </td>
                    <td className="num">{withUnit(r.range?.y ?? NaN, r.yUnit)}</td>
                    <td className="num">{withUnit(r.slope, slopeUnit(r))}</td>
                    <td className="num">
                      {Number.isFinite(r.ratio) ? r.ratio.toFixed(3) : MISSING}
                      <span className="xy-re-aside">
                        {r.modelRatio === null ? 'polar: 3' : 'model: 3'}
                        <sup>¼</sup> = {PHYSICAL_RATIO.toFixed(3)}
                      </span>
                    </td>
                    <td className="num">{r2Text(r.r2)}</td>
                    <td className="num">{r.n ? r.n.toLocaleString('en-GB') : MISSING}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {notes.length > 0 && (
            <ul className="xy-re-notes" aria-label="Range and endurance notes">
              {notes.map(({ key, name, note }) => (
                <li key={key} className={note.includes('extrapolated') ? 'xy-re-warn' : 'xy-problem'}>
                  <AlertIcon size={12} />
                  <span>
                    {rows.length > 1 ? `${name}: ` : ''}
                    {note}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

/** A speed in the range table, marked when it is extrapolated (the note under the table says where it lies). */
function PointValue({ text, extrapolated }: { text: string; extrapolated?: boolean }) {
  return extrapolated ? (
    <span className="xy-re-warn" title="Extrapolated: outside the speeds of the points fitted">
      {text}
      <span className="xy-re-aside">extrapolated</span>
    </span>
  ) : (
    <>{text}</>
  )
}
