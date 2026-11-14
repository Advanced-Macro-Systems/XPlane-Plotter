// The X–Y plot's tables: fit results (equation, R², RMSE, n, coefficients ± standard error) and, with test points, the
// mean ± σ of x and every Y channel per point. Both copy as TSV with plain numbers (paste into Excel or MATLAB).

import { CopyIcon } from '@primer/octicons-react'
import { useMemo } from 'react'
import { MISSING, formatNumber } from '../../charts/format'
import { channelTitle } from '../../core/channels'
import { copyText } from '../../core/export/download'
import type { XYConfig } from '../../core/types'
import { toast } from '../../store/app'
import { formatMeanSd } from '../points/pointsModel'
import { SlotSwatch } from './Glyphs'
import type { XYData, XYFit } from './xyModel'
import { fitRows, fitTableTsv, meanRows, meansTableTsv, type FitRow } from './xyTables'

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

export function XYResults({ data, fits, fit }: { data: XYData; fits: readonly XYFit[]; fit: XYConfig['fit'] }) {
  const rows = useMemo(() => fitRows(data, fits), [data, fits])
  const means = useMemo(() => meanRows(data), [data])
  const showMeans = data.effective.source === 'points' && means.length > 0

  return (
    <div className="view-body xy-tables" id="xy-tables">
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
              ? 'No fit yet. Choose Linear, Quadratic or Cubic under Fit to see the equation, R² and coefficients here.'
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
