// Help: how to record Data.txt in X-Plane 12 (and which rows to tick per test), how to use the app (mouse, keys,
// formulas, exports, the MATLAB workflow), and about (privacy, credits, the demo, trademarks).

import { InfoIcon, ShieldCheckIcon } from '@primer/octicons-react'
import { useRef, useState } from 'react'
import { Segmented } from '../components/Segmented'
import { loggingGuide, recordingSteps } from '../core/channels'
import { Modal } from '../ui/Modal'
import { GuideText } from './GuideText'
import { BEFORE_EVERY_RUN } from './helpContent'
import { commandKey } from './platform'
import type { HelpSection } from './shellModel'

const SECTIONS: { value: HelpSection; label: string }[] = [
  { value: 'record', label: 'Record data' },
  { value: 'use', label: 'Use the app' },
  { value: 'about', label: 'About' },
]

export function HelpDialog({ initial, onClose }: { initial: HelpSection; onClose: () => void }) {
  const [section, setSection] = useState<HelpSection>(initial)
  const topRef = useRef<HTMLDivElement>(null)

  return (
    <Modal title="Help" onClose={onClose} width={720} className="sh-help">
      <div ref={topRef} className="sh-help-tabs">
        <Segmented
          value={section}
          options={SECTIONS}
          ariaLabel="Help topics"
          onChange={(next) => {
            setSection(next)
            topRef.current?.closest('.modal-body')?.scrollTo({ top: 0 })
          }}
        />
      </div>
      <div className="sh-help-body">
        {section === 'record' && <RecordHelp />}
        {section === 'use' && <UseHelp />}
        {section === 'about' && <AboutHelp />}
      </div>
    </Modal>
  )
}

function RecordHelp() {
  const steps = recordingSteps()
  const recommendations = loggingGuide()
  return (
    <>
      <p className="sh-help-lead">
        X-Plane 12 writes every Data Output row you tick to a text file, <code>Data.txt</code>, while you fly. Open that file here.
      </p>

      <h3>Switch on Data.txt output</h3>
      <ol className="sh-help-steps">
        {steps.map((step, i) => (
          <li key={i}>
            <GuideText text={step} />
          </li>
        ))}
      </ol>

      <h3>Rows to tick for each test</h3>
      <p className="sh-help-note">
        <strong>Index</strong> is the row&apos;s number in the Data Output list; a dash means X-Plane 12 publishes no number, so
        find the row with the Search box.
      </p>
      <div className="sh-guide">
        {recommendations.map((rec, i) => (
          <details key={rec.title} className="sh-guide-item" open={i === 0}>
            <summary>
              <span className="sh-guide-title">{rec.title}</span>
              <span className="sh-guide-count">{rec.rows.length} rows</span>
            </summary>
            <p className="sh-guide-summary">
              <GuideText text={rec.summary} />
            </p>
            <div className="table-wrap">
              <table className="table sh-guide-table">
                <thead>
                  <tr>
                    <th className="num">Index</th>
                    <th>Row</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rec.rows.map((row) => (
                    <tr key={`${row.index ?? '-'}-${row.name}`}>
                      <td className="num mono">{row.index ?? '–'}</td>
                      <td className="sh-guide-row">{row.name}</td>
                      <td className="sh-guide-why">
                        <GuideText text={row.why} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>

      <div className="callout sh-help-callout">
        <InfoIcon size={16} />
        <div>
          <strong>Before every run</strong>
          <ul>
            {BEFORE_EVERY_RUN.map((tip) => (
              <li key={tip}>
                <GuideText text={tip} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}

function UseHelp() {
  const cmd = commandKey()
  return (
    <>
      <h3>Open a log</h3>
      <p>
        Drop <code>Data.txt</code> (or a CSV / TSV) anywhere on the page, or use <strong>Open file</strong>. Several files can be
        open at once: switch between them with the file menu next to the app name. Test points, panels, formulas and plot
        settings are saved in this browser for each file, so opening the same log again brings them back.
      </p>

      <h3>Time history: zoom, select, save test points</h3>
      <p>
        Choose <strong>Zoom</strong> or <strong>Select</strong> above the plots. In Zoom, scroll to zoom in and out, drag to
        pan, and double-click to show the whole log. In Select, drag across a steady stretch of flight (or type its start and
        end with <strong>Set window…</strong>), then <strong>save it as a test point</strong> in a colour-coded group. The
        zoom range and the selection show as chips on the right of the tab bar: <strong>×</strong> clears them.
      </p>

      <h3>Test points</h3>
      <p>
        The Test points tab lists every saved window with the mean ± σ of the channels you choose, and flags windows that were
        not steady. Group points (for example by CG position) to compare them in the X–Y plot.
      </p>

      <h3>X–Y plot</h3>
      <p>
        Plot any channel against another, through every sample, the zoom range or the test points (as means ± σ), with linear,
        quadratic or cubic fits and their R²: lift curve, drag polar, elevator to trim against C<sub>L</sub>.
      </p>

      <h3>Dynamic modes</h3>
      <p>
        Pick a channel and a window (the selection, the zoom range or a test point). A damped-oscillation fit gives the period,
        ω<sub>n</sub> and ζ of the phugoid, short period or dutch roll; a first-order fit gives the time constant of the roll
        subsidence or spiral.
      </p>

      <h3>Formulas</h3>
      <p>
        <strong>Channels → New formula</strong> makes a channel from others, row by row, e.g.{' '}
        <code>drag_lb * Vtrue_ktas * kt2ms * lb2n / 1000</code> for the power required in kW. Formulas are saved with the
        workspace and exported to MATLAB.
      </p>

      <h3>Exports</h3>
      <p>
        Figures as PNG or SVG in a white &quot;paper&quot; style, samples and test-point statistics as CSV, the workspace as a
        session file (<strong>Settings → Save session file</strong>) to move it to another computer.
      </p>

      <h3>MATLAB workflow</h3>
      <ol className="sh-help-steps">
        <li>
          Export <strong>MATLAB script: everything</strong> (Overview → Export). It is named after the log, e.g.{' '}
          <code>xpp_Data.m</code>. The plots&apos; own export menus write one plot each, with its part in the name (
          <code>xpp_Data_time.m</code>, <code>xpp_Data_xy.m</code>, <code>xpp_Data_modes.m</code>), so they never
          overwrite it.
        </li>
        <li>Save it in the same folder as the log it re-reads (or set its dataFile line to the log&apos;s full path).</li>
        <li>
          Call it from your <code>run_all.m</code> with <code>run(&apos;xpp_Data.m&apos;)</code>. It rebuilds the test-point
          table, the X–Y and time-history figures and the mode fit, and writes them to the <code>out</code> folder next to the
          script.
        </li>
      </ol>

      <h3>Keyboard</h3>
      <div className="table-wrap">
        <table className="table sh-keys">
          <tbody>
            <tr>
              <td>
                <span className="kbd">1</span> … <span className="kbd">6</span>
              </td>
              <td>Switch tabs (Overview … Channels)</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">{cmd}</span> + <span className="kbd">O</span>
              </td>
              <td>Open a file</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">?</span>
              </td>
              <td>This help</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">Z</span> / <span className="kbd">S</span>
              </td>
              <td>Time history: Zoom or Select mode</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">+</span> / <span className="kbd">−</span>
              </td>
              <td>Time history: zoom in or out</td>
            </tr>
            <tr>
              <td>
                <span className="kbd">Esc</span>
              </td>
              <td>Close a menu or dialog</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}

function AboutHelp() {
  return (
    <>
      <div className="callout callout-success sh-help-callout">
        <ShieldCheckIcon size={16} />
        <div>
          <strong>Your files never leave this computer.</strong> X-Plane Plotter is a static web page: the log is read by your
          browser and nothing is uploaded. There is no server and no account.
        </div>
      </div>

      <h3>Workspaces</h3>
      <p>
        Test points, groups, panels, formulas and plot settings are saved in this browser, keyed by the file&apos;s contents, so
        opening the same log again restores them. They stay on this computer: save a session file to move them, and use
        Recent files on the start page to forget one.
      </p>

      <h3>The demo flight</h3>
      <p>
        The demo is synthetic: a generic twin-engine airliner simulated in X-Plane&apos;s Data.txt format, with known mode
        parameters injected so you can check the fits. Use it to learn the app, never as flight-test evidence.
      </p>

      <h3>Purpose</h3>
      <p>
        Built for flight-test coursework: performance (including range and endurance), static stability from trim points,
        dynamic stability modes and propulsion-only control. Use it to explore and pick test points; make report figures with
        the exported MATLAB script.
      </p>

      <h3>Credits</h3>
      <ul className="sh-help-list">
        <li>
          Charts: <a href="https://echarts.apache.org/" target="_blank" rel="noreferrer">Apache ECharts</a> (Apache-2.0)
        </li>
        <li>
          Type: <a href="https://vercel.com/font" target="_blank" rel="noreferrer">Geist and Geist Mono</a> (SIL Open Font
          License)
        </li>
        <li>
          Icons: <a href="https://primer.style/octicons" target="_blank" rel="noreferrer">Primer Octicons</a> (MIT)
        </li>
      </ul>

      <p className="sh-help-note">
        X-Plane is a trademark of Laminar Research. This tool is independent and not affiliated with or endorsed by Laminar
        Research.
      </p>
    </>
  )
}
