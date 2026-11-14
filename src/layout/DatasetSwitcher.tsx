// The open file, as a button in the header: its menu lists every open file (switch to it, or close it), then
// "Open file…" and "Load demo flight".

import { BeakerIcon, CheckIcon, ChevronDownIcon, FileIcon, UploadIcon, XIcon } from '@primer/octicons-react'
import { DEMO_FILE_NAME } from '../core/demo/generateDemo'
import { closeDataset, setActive, useApp } from '../store/app'
import { Dropdown } from '../ui/Dropdown'
import { showDemo } from './fileActions'
import { openFilePicker } from './filePicker'
import { commandKey } from './platform'
import { datasetSummary, formatBytes } from './shellModel'

export function DatasetSwitcher() {
  const datasets = useApp((s) => s.datasets)
  const activeId = useApp((s) => s.activeId)
  const active = datasets.find((d) => d.id === activeId) ?? datasets.at(-1)
  if (!active) return null
  const demoOpen = datasets.some((d) => d.name === DEMO_FILE_NAME)

  return (
    <div className="sh-switcher" data-testid="dataset-switcher">
      <Dropdown
        label={
          <>
            <FileIcon className="sh-ds-icon" size={16} />
            <span className="sh-ds-name">{active.name}</span>
            <span className="sh-ds-meta">{datasetSummary(active)}</span>
            <ChevronDownIcon className="sh-ds-chevron" size={16} />
          </>
        }
        ariaLabel={`${active.name}, ${datasetSummary(active)}. Switch or open files`}
        title={active.name}
        buttonClassName="sh-ds-button"
        align="left"
        width={400}
      >
        {(close) => (
          <div className="sh-ds-menu">
            <p className="menu-heading">Open files</p>
            {datasets.map((ds) => {
              const current = ds.id === active.id
              return (
                <div key={ds.id} className={`sh-ds-row${current ? ' sh-ds-row-current' : ''}`}>
                  <button
                    type="button"
                    className="menu-item sh-ds-pick"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => {
                      setActive(ds.id)
                      close()
                    }}
                  >
                    <span className="sh-ds-check" aria-hidden="true">
                      {current && <CheckIcon size={16} />}
                    </span>
                    <span className="sh-ds-text">
                      <span className="sh-ds-row-name">{ds.name}</span>
                      <small>
                        {datasetSummary(ds)} · {formatBytes(ds.sizeBytes)}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm sh-ds-close"
                    aria-label={`Close ${ds.name}`}
                    title={ds.name === DEMO_FILE_NAME ? 'Close the demo' : 'Close this file (its test points stay saved in this browser)'}
                    onClick={() => {
                      if (datasets.length === 1) close()
                      closeDataset(ds.id)
                    }}
                  >
                    <XIcon size={16} />
                  </button>
                </div>
              )
            })}
            <div className="menu-divider" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close()
                openFilePicker()
              }}
            >
              <UploadIcon size={16} />
              <span>Open file…</span>
              <span className="menu-item-hint">{commandKey()}+O</span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close()
                showDemo()
              }}
            >
              <BeakerIcon size={16} />
              <span>{demoOpen ? 'Show the demo flight' : 'Load demo flight'}</span>
            </button>
          </div>
        )}
      </Dropdown>
    </div>
  )
}
