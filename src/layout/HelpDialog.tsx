// Help: how to record Data.txt in X-Plane 12 (and which rows to tick per test), how to use the app (mouse, keys,
// formulas, exports, the MATLAB workflow), and about (privacy, credits, the demo, trademarks).

import { InfoIcon, ShieldCheckIcon } from '@primer/octicons-react'
import { useRef, useState } from 'react'
import { Segmented } from '../components/Segmented'
import { loggingGuide, recordingSteps } from '../core/channels/guide'
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
      <p>
        <strong>Find steady points…</strong> (Test points or Time history) finds every stretch of steady, level flight: the
        speed held within ± 2 kt (its scatter and its trend), the vertical speed within ± 100 fpm, wings level and still,
        the throttle (or thrust or power, whichever the log has) within ± 3 %, for at least 20 s, never across a sim reset or
        a gap, each window trimmed to the steady core of the hold: not the throttle still being set at its start, nor
        already pulled for the next point at its end (the speed follows the throttle seconds later). Change the tolerances
        (clear the throttle or bank field to leave it out), untick what you do not want and add the rest, named by speed
        (&quot;250 KIAS&quot;), in a new <strong>Speed points</strong> group or one of yours. Windows that are already test points
        are left out.
      </p>
      <p>
        <strong>Add from times…</strong> takes the times you wrote down, pasted from your notes or a spreadsheet: one window
        per line (&quot;150-180 250&quot;, &quot;150 180&quot;, &quot;210–240, 240 kt&quot;, or a single time for ± 10 s), with a header
        line if you like. Lines without a time (&quot;(not recorded) 140&quot;) are skipped. When the lines list the speed held,
        it finds the clock you read the times on (elapsed, real or sim time): the one where most windows&apos; mean speeds agree
        with the speeds listed. Windows far off their listed speed, that overlap another line or hold no data start unticked,
        with the reason. It offers to show Time history on that clock: elapsed time (sim time with resets and gaps closed up)
        and X-Plane&apos;s real time drift apart when the sim is paused or reloaded.
      </p>

      <h3>X–Y plot</h3>
      <p>
        Plot any channel against another, through every sample, the zoom range or the test points (as means ± σ), with linear,
        quadratic or cubic fits, or the power (A·V³ + B/V) and drag (A·V² + B/V²) models of the parabolic drag polar, and
        their R²: lift curve, drag polar, elevator to trim against C<sub>L</sub>.
      </p>

      <h3>Range and endurance</h3>
      <ol className="sh-help-steps">
        <li>
          Make one test point per speed: <strong>Find steady points…</strong> finds the holds for you (or{' '}
          <strong>Add from times…</strong> with the times you noted); by hand, <strong>Select</strong> a steady level stretch
          in Time history and <strong>Save test point</strong>.
        </li>
        <li>
          In X–Y plot choose the preset <strong>Range &amp; endurance — propeller</strong> (engine power against TAS) or{' '}
          <strong>— jet</strong> (thrust against TAS). It fits the physical model through the test-point means, turns on{' '}
          <strong>Range &amp; endurance markers</strong> and <strong>Axes from zero</strong>, and makes a twin&apos;s total
          power or thrust channel.
        </li>
        <li>
          The curve&apos;s minimum is the speed for maximum endurance, V<sub>E</sub>; the tangent from the origin touches it
          at the speed for maximum range, V<sub>R</sub>. Both are in the Range &amp; endurance table under the plot, flagged
          when they lie outside the test points; the MATLAB export draws the same figure and writes{' '}
          <code>out/range_endurance.txt</code>.
        </li>
      </ol>
      <p className="sh-help-note">
        Propellers: power is least at V<sub>E</sub>, power per speed (drag) at V<sub>R</sub>. Jets: thrust (drag) is least at
        V<sub>E</sub>, thrust per speed at V<sub>R</sub>. For the physical models V<sub>R</sub>/V<sub>E</sub> = 3<sup>¼</sup>.
        KIAS or KEAS at one altitude give the same points in those units. Results hold for the weight and altitude flown (not
        reduced to standard conditions).
      </p>

      <h3>Dynamic modes</h3>
      <p>
        Pick a channel and a window (the selection, the zoom range or a test point). A damped-oscillation fit gives the period,
        ω<sub>n</sub> and ζ of the phugoid, short period or dutch roll; a first-order fit gives the time constant of the roll
        subsidence or spiral.
      </p>

      <h3>Test validity checklists</h3>
      <p>
        The app checks whether each test was flown the way the course’s sources ask, check by check, with the value measured,
        the criterion and the source (document and page), each marked <strong>Pass</strong>, <strong>Warn</strong>,{' '}
        <strong>Fail</strong>, <strong>Not checkable</strong> (the log lacks a row: it names the Data Output row to tick) or{' '}
        <strong>Info</strong>. A <code>judgement</code> tag marks a threshold no source gives as a number (engineering
        judgement); where the sources differ the row says which one it follows. Questions the sources do not settle (are
        autopilot-held trim points accepted? lateral-directional static stability? is one CG enough?) are listed under{' '}
        <strong>Not settled by the sources — ask on EdDiscussion</strong>, never as pass or fail.
      </p>
      <ul className="sh-help-list">
        <li>
          <strong>Test points → Test validity checklist</strong>: choose <em>Performance — range &amp; endurance</em> or{' '}
          <em>Static stability — trim curve</em>. It judges the points the X–Y analysis uses (the visible points of the X–Y
          group filter): a badge per point (expand it for its checks; leave a point out of the fit), the set checks (C
          <sub>L</sub> range, trim variable, CG lines, point count, the brackets around V<sub>E</sub> and V<sub>R</sub>…) and
          the verdict: <em>Acceptable for analysis</em>, <em>Retest required</em>, <em>Cannot confirm</em> or{' '}
          <em>Fix the analysis</em>. When the throttle (or the trim) moved inside points, <strong>Re-cut … flagged
          points</strong> cuts each to its longest stretch where it stayed still (with Undo): Find steady points accepts the
          power within ± 3 %, so a window it finds can start while the throttle is still being trimmed (when that alone
          could leave enough usable points, the verdict says <em>Fix the analysis — re-cut …</em> rather than fly more).{' '}
          <strong>Fit the used points only</strong> makes the X–Y fit leave out what the verdict
          leaves out.
        </li>
        <li>
          <strong>Dynamic modes → Test validity</strong>: for the window and mode analysed, the trim before the input, the
          input found (shape, size, timing), autopilot, yaw damper and throttle off, controls fixed, record length and the fit.
        </li>
        <li>
          <strong>X–Y plot</strong>: with the range-and-endurance markers on, or a trim curve (elevator or stabiliser against C
          <sub>L</sub>), a one-line summary and <strong>Open checklist</strong>.
        </li>
        <li>
          Export → <strong>Checklist (CSV)</strong> (Test points) or <strong>Test validity checklist (CSV)</strong> (Dynamic
          modes); the MATLAB script writes the same results to <code>out/test_checks.csv</code> (one tab’s script:{' '}
          <code>out/test_checks_xy.csv</code> or <code>out/test_checks_modes.csv</code>).
        </li>
      </ul>
      <p className="sh-help-note">
        Sources: the course lectures (FD03–FD13, Flight Test Introduction and Flight Test 2), M. V. Cook, <em>Flight
        Dynamics Principles</em> (3rd ed.), the NATO flight test handbook RTO-AG-300 Vol. 14 (cited as “NATO AG-300 v14
        p.13-10”), the coursework brief and briefing slides, and the MIL-F-8785C background and user guide for the
        handling-qualities levels. The checks judge an X-Plane model at the conditions flown, not the real aircraft.
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
