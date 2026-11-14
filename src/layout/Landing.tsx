// The first screen (no file open): what the app does, a big drop zone with "Open file" and the demo, the files opened
// before on this computer (opening one again brings its test points back), and how to record a log in X-Plane 12.

import {
  BeakerIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  HistoryIcon,
  ShieldCheckIcon,
  UploadIcon,
  XIcon,
} from '@primer/octicons-react'
import { useState } from 'react'
import { forgetRecent, readRecent, type RecentFile } from '../store/app'
import { showDemo } from './fileActions'
import { openFilePicker } from './filePicker'
import { GuideText } from './GuideText'
import { landingSteps } from './helpContent'
import { commandKey } from './platform'
import { recentSummary, recentWhen, type HelpSection } from './shellModel'

export function Landing({ onHelp }: { onHelp: (section: HelpSection) => void }) {
  const record = landingSteps()

  return (
    <div className="sh-landing" data-testid="landing">
      <div className="sh-landing-inner">
        <section className="sh-hero" aria-labelledby="sh-hero-title">
          <p className="eyebrow">Flight-test analysis for X-Plane 12</p>
          <h1 id="sh-hero-title" className="sh-hero-title">
            Plot your <span className="sh-nowrap">X-Plane</span> <span className="sh-hero-accent">flight logs</span>
          </h1>
          <p className="sh-hero-sub">
            Time histories, steady test points, X–Y fits and dynamic modes, then a MATLAB script that rebuilds every figure for
            your report.
          </p>

          <div
            className="sh-drop"
            onClick={(event) => {
              // A click on the zone itself (not on its buttons) also opens the file chooser.
              if (event.target === event.currentTarget) openFilePicker()
            }}
          >
            <span className="sh-drop-icon" aria-hidden="true">
              <UploadIcon size={24} />
            </span>
            <p className="sh-drop-title">Drop an X-Plane Data.txt here</p>
            <p className="sh-drop-sub">Data.txt, CSV or TSV · any Data Output rows · large logs welcome</p>
            <div className="sh-drop-actions">
              <button type="button" className="btn btn-primary sh-btn-lg" onClick={openFilePicker} title={`${commandKey()}+O`}>
                <UploadIcon size={16} />
                Open file
              </button>
              <button type="button" className="btn btn-outline sh-btn-lg" data-testid="demo-button" onClick={showDemo}>
                <BeakerIcon size={16} />
                Try the demo flight
              </button>
            </div>
            <p className="sh-privacy">
              <ShieldCheckIcon size={16} />
              Read by your browser — never uploaded
            </p>
          </div>

          <RecentFiles />
        </section>

        <ol className="sh-steps" aria-label="How it works">
          <li className="sh-step sh-step-record">
            <span className="sh-step-num" aria-hidden="true">
              1
            </span>
            <h2 className="sh-step-title">Record in X-Plane 12</h2>
            <ul className="sh-step-list">
              {record.steps.map((step, i) => (
                <li key={i}>
                  <GuideText text={step} />
                </li>
              ))}
            </ul>
            <DataOutputSketch />
            <button type="button" className="sh-link sh-step-link" onClick={() => onHelp('record')}>
              {record.more > 0 ? `${record.more} more steps, and the rows to tick for each test` : 'Which rows to tick for each test'}
              <ChevronRightIcon size={16} />
            </button>
          </li>
          <li className="sh-step">
            <span className="sh-step-num" aria-hidden="true">
              2
            </span>
            <h2 className="sh-step-title">Drop the log</h2>
            <p className="sh-step-text">
              Data.txt straight from X-Plane, or any CSV or TSV with a header row. Every column is read, whatever rows you
              ticked, and a 60 MB log opens in seconds.
            </p>
            <p className="sh-step-text">Sim resets and recording gaps are found and marked for you.</p>
          </li>
          <li className="sh-step">
            <span className="sh-step-num" aria-hidden="true">
              3
            </span>
            <h2 className="sh-step-title">Explore and export</h2>
            <p className="sh-step-text">
              Stacked time histories, X–Y plots with linear to cubic fits, test points with mean ± σ, and fits of the phugoid,
              short period, dutch roll and roll subsidence.
            </p>
            <p className="sh-step-text">Export PNG, SVG, CSV, or a MATLAB script for your run_all.m.</p>
          </li>
        </ol>

        <footer className="sh-landing-foot">
          <button type="button" className="sh-link" onClick={() => onHelp('use')}>
            How to use the app
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="sh-link" onClick={() => onHelp('about')}>
            About and privacy
          </button>
          <span aria-hidden="true">·</span>
          <span>X-Plane is a trademark of Laminar Research. This tool is not affiliated with it.</span>
        </footer>
      </div>
    </div>
  )
}

/** Core rows from the recording guide, with their X-Plane 12 Data Output index and label. */
const SKETCH_ROWS: readonly [index: number, name: string][] = [
  [1, 'Times'],
  [3, 'Speeds'],
  [17, 'Pitch, roll, & headings'],
]
/** The four checkboxes of every Data Output row, in X-Plane's order; the third writes Data.txt. */
const SKETCH_BOXES = ['Cockpit', 'Graph', 'Disk', 'UDP'] as const
const DISK = 2

/**
 * A small schematic of X-Plane 12's Data Output list (index, row name, then Show in Cockpit, Data Graph Window,
 * Disk (data.txt File) and Network via UDP), with the Disk box ticked. Decorative: the steps above say it in words.
 */
function DataOutputSketch() {
  return (
    <div className="sh-xp" aria-hidden="true">
      <div className="sh-xp-row sh-xp-head">
        <span />
        <span>Data Output</span>
        {SKETCH_BOXES.map((name, i) => (
          <span key={name} className={i === DISK ? 'sh-xp-on' : undefined}>
            {name}
          </span>
        ))}
      </div>
      {SKETCH_ROWS.map(([index, name]) => (
        <div key={index} className="sh-xp-row">
          <span className="sh-xp-index">{index}</span>
          <span className="sh-xp-name">{name}</span>
          {SKETCH_BOXES.map((box, i) => (
            <span key={box} className={`sh-xp-box${i === DISK ? ' sh-xp-box-on' : ''}`}>
              {i === DISK && <CheckIcon size={12} />}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Files opened before in this browser. A browser cannot reopen a file by name, so a click asks for it again. */
function RecentFiles() {
  const [recent, setRecent] = useState<RecentFile[]>(readRecent)
  const [confirming, setConfirming] = useState<string | null>(null)
  if (!recent.length) return null
  const now = new Date()

  const forget = (signature: string) => {
    forgetRecent(signature)
    setRecent(readRecent())
    setConfirming(null)
  }

  return (
    <section className="sh-recent" aria-labelledby="sh-recent-title">
      <div className="sh-recent-head">
        <h2 id="sh-recent-title" className="sh-section-title">
          <HistoryIcon size={16} />
          Recent files
        </h2>
        <p className="sh-recent-note">Open the same file again to restore its test points.</p>
      </div>
      <ul className="sh-recent-list">
        {recent.map((file) => (
          <li key={file.signature} className="sh-recent-item">
            {confirming === file.signature ? (
              <div className="sh-recent-confirm" role="group" aria-label={`Forget ${file.name}?`}>
                <p className="sh-recent-confirm-text">
                  Forget <strong>{file.name}</strong>
                  {file.points > 0 ? ` and its ${file.points === 1 ? 'test point' : `${file.points} test points`}` : ''}? This
                  cannot be undone.
                </p>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => forget(file.signature)}>
                  Forget
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)}>
                  Keep
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="sh-recent-open"
                  title={`Open ${file.name} again to restore its workspace`}
                  onClick={openFilePicker}
                >
                  <FileIcon className="sh-recent-icon" size={16} />
                  <span className="sh-recent-text">
                    <span className="sh-recent-name">{file.name}</span>
                    <span className="sh-recent-meta">{recentSummary(file)}</span>
                  </span>
                  <span className="sh-recent-when">{recentWhen(file.savedAt, now)}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm sh-recent-forget"
                  aria-label={`Forget ${file.name}`}
                  title="Forget this file and its saved workspace"
                  onClick={() => (file.points > 0 ? setConfirming(file.signature) : forget(file.signature))}
                >
                  <XIcon size={16} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
