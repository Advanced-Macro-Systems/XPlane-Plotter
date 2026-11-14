// Channels: the whole file as a table — group, names, token, unit, statistics, flags and a sparkline per channel — with
// search, filters, sorting and actions per row (plot it, use it in X–Y, analyse a mode), and the formula channels above
// it with their editor (FormulaDialog.tsx). Pure logic lives in channelsTable.ts and formulaCheck.ts; the sparklines are
// small canvases drawn lazily (components/Sparkline.tsx), so 200+ rows stay light.

import {
  GraphIcon,
  InfoIcon,
  KebabHorizontalIcon,
  PencilIcon,
  PlusIcon,
  PulseIcon,
  SearchIcon,
  TrashIcon,
  TriangleDownIcon,
  TriangleUpIcon,
} from '@primer/octicons-react'
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ExportMenu, type ExportItem } from '../../components/ExportMenu'
import { useSettled } from '../../components/hooks'
import { Sparkline } from '../../components/Sparkline'
import { availablePresets, type DerivedPreset } from '../../core/analysis/derived'
import { channelTitle } from '../../core/channels'
import { channelAlias } from '../../core/channels/alias'
import { channelById } from '../../core/dataset'
import { copyText, downloadText, safeFilename } from '../../core/export/download'
import type { Dataset, DerivedDef, Workspace } from '../../core/types'
import {
  addPanel,
  clearChannelsRequest,
  getWorkspace,
  removeDerived,
  saveDerived,
  setModes,
  setTab,
  setXY,
  toast,
  useActiveDataset,
  useApp,
  useWorkspace,
} from '../../store/app'
import { MAX_SERIES } from '../../store/defaults'
import {
  ALL_GROUPS,
  FILE_ORDER,
  channelCounts,
  channelHelp,
  channelRows,
  channelsTableText,
  countsText,
  filterRows,
  groupOptions,
  nextSort,
  sortRows,
  statText,
  statTitle,
  type ChannelFilter,
  type ChannelRow,
  type SortKey,
  type SortState,
} from './channelsTable'
import { FormulaDialog } from './FormulaDialog'
import './channels.css'

export function ChannelsView() {
  const ds = useActiveDataset()
  const ws = useWorkspace()
  return (
    <div className="view" data-testid="view-channels">
      {ds && ws && <ChannelsWorkspace ds={ds} ws={ws} />}
    </div>
  )
}

const DEFAULT_FILTER: ChannelFilter = { query: '', group: ALL_GROUPS, hideConstant: false, onlyUnknown: false }

/** Search, filters and sort per dataset, so they are still there after a trip to another tab. */
const remembered = new Map<string, { filter: ChannelFilter; sort: SortState }>()

/**
 * Filters and sort on opening the tab: what another view asked for with openChannels (one group, or the constant
 * channels first), else what was left here last time.
 */
function startState(datasetId: string): { filter: ChannelFilter; sort: SortState } {
  const request = useApp.getState().channelsRequest
  if (request) {
    return {
      filter: { ...DEFAULT_FILTER, group: request.group ?? ALL_GROUPS },
      sort: request.constant ? { key: 'flags', dir: 'desc' } : FILE_ORDER,
    }
  }
  return remembered.get(datasetId) ?? { filter: DEFAULT_FILTER, sort: FILE_ORDER }
}

type DialogState = { kind: 'new'; preset: DerivedPreset | null } | { kind: 'edit'; def: DerivedDef }

interface MenuState {
  id: string
  anchor: HTMLElement
}

const count = (n: number) => n.toLocaleString('en-GB')

function ChannelsWorkspace({ ds, ws }: { ds: Dataset; ws: Workspace }) {
  const [start] = useState(() => startState(ds.id))
  const [filter, setFilter] = useState<ChannelFilter>(start.filter)
  const [sort, setSort] = useState<SortState>(start.sort)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  // The request (if any) is in the state above now.
  useEffect(() => clearChannelsRequest(), [])

  useEffect(() => {
    remembered.set(ds.id, { filter, sort })
  }, [ds.id, filter, sort])

  const rows = useMemo(() => channelRows(ds), [ds])
  const counts = useMemo(() => channelCounts(rows), [rows])
  const groups = useMemo(() => groupOptions(rows), [rows])
  const query = useDeferredValue(filter.query)
  // A group that is no longer present (its last formula deleted) means every group.
  const group = groups.some((g) => g.id === filter.group) ? filter.group : ALL_GROUPS
  const { hideConstant, onlyUnknown } = filter
  const shown = useMemo(
    () => sortRows(filterRows(rows, { query, group, hideConstant, onlyUnknown }), sort),
    [rows, query, group, hideConstant, onlyUnknown, sort],
  )
  const filtered = shown.length !== rows.length
  // The counts describe the rows shown; spoken once typing pauses, not on every key.
  const shownText = useMemo(() => countsText(channelCounts(shown), rows.length), [shown, rows.length])
  const spokenText = useSettled(shownText, 700)
  const patch = (next: Partial<ChannelFilter>) => setFilter((f) => ({ ...f, ...next }))

  const openMenu = useCallback((id: string, anchor: HTMLElement) => {
    setMenu((current) => (current?.id === id ? null : { id, anchor }))
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const stem = safeFilename(ds.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), 'channels')
  const exportItems: ExportItem[] = [
    {
      section: 'Table',
      label: 'CSV file',
      hint: `${filtered ? `The ${count(shown.length)} channels shown` : 'Every channel'}, with statistics`,
      disabled: shown.length === 0,
      onSelect: () => downloadText(`${stem}_channels.csv`, channelsTableText(shown, ','), 'text/csv'),
    },
    {
      label: 'Copy as text',
      hint: 'Tab-separated, to paste into a spreadsheet',
      disabled: shown.length === 0,
      onSelect: async () => {
        const copied = await copyText(channelsTableText(shown, '\t'))
        if (copied) toast(`Copied ${count(shown.length)} rows: paste them into a spreadsheet.`, 'success')
        else toast('Could not copy: the clipboard is not available here.', 'error')
      },
    },
  ]

  const onSaved = (id: string, name: string) => {
    const edited = dialog?.kind === 'edit'
    setDialog(null)
    if (edited) {
      toast(`Updated “${name}”.`, 'success')
      return
    }
    toast(`Saved “${name}”. It is now a channel you can plot, under Formulas in every channel list.`, 'success', {
      label: 'Plot it',
      run: () => {
        addPanel([id])
        setTab('time')
      },
    })
  }

  return (
    <>
      <div className="view-toolbar ch-toolbar">
        <div className="ch-search">
          <SearchIcon className="ch-search-icon" size={14} />
          <input
            className="input input-sm ch-search-input"
            type="search"
            value={filter.query}
            placeholder={`Search ${count(rows.length)} channels…`}
            aria-label="Search channels"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => patch({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter.query) {
                e.preventDefault()
                patch({ query: '' })
              }
            }}
          />
        </div>
        <select
          className="select select-sm ch-group-select"
          aria-label="Data Output group"
          value={group}
          onChange={(e) => patch({ group: e.target.value })}
        >
          <option value={ALL_GROUPS}>All groups ({count(rows.length)})</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({count(g.count)})
            </option>
          ))}
        </select>
        <label className="check ch-toggle" title="Hide channels whose every value is the same (unused stations, fixed weights…)">
          <input type="checkbox" checked={hideConstant} onChange={(e) => patch({ hideConstant: e.target.checked })} />
          Hide constant
        </label>
        <label
          className="check ch-toggle"
          title={
            counts.unknown === 0 && !onlyUnknown
              ? 'The channel dictionary knows every column of this file'
              : 'Only columns the channel dictionary does not know (named from their header)'
          }
        >
          <input
            type="checkbox"
            checked={onlyUnknown}
            disabled={counts.unknown === 0 && !onlyUnknown}
            onChange={(e) => patch({ onlyUnknown: e.target.checked })}
          />
          Only unknown
        </label>
        <span className="view-toolbar-spacer" />
        <span className="ch-counts num" aria-hidden="true">
          {shownText}
        </span>
        <span className="sr-only" role="status">
          {spokenText}
        </span>
        <ExportMenu items={exportItems} label="Export table" />
      </div>

      <div className="ch-body">
        <FormulasSection
          ds={ds}
          ws={ws}
          onNew={(preset) => setDialog({ kind: 'new', preset })}
          onEdit={(def) => setDialog({ kind: 'edit', def })}
        />
        <div className="ch-frame">
          <table className="table ch-table" data-testid="channels-table" aria-label="Channels in this file">
            <colgroup>
              {COLUMNS.map((column) => (
                <col key={column.key} className={column.className} />
              ))}
              <col className="ch-c-spark" />
              <col className="ch-c-menu" />
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <SortHeader key={column.key} column={column} sort={sort} onSort={(key) => setSort((s) => nextSort(s, key))} />
                ))}
                <th className="ch-c-spark" title="The whole channel against elapsed time">
                  Trend
                </th>
                <th className="ch-c-menu">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <ChannelTableRow
                  key={row.ch.id}
                  row={row}
                  elapsed={ds.elapsed}
                  rowCount={ds.rowCount}
                  menuOpen={menu?.id === row.ch.id}
                  onMenu={openMenu}
                />
              ))}
            </tbody>
          </table>
          {shown.length === 0 && (
            <div className="ch-none">
              <p>
                {query ? `No channel matches “${query}”` : 'No channels match these filters'}
                {query && (group !== ALL_GROUPS || hideConstant || onlyUnknown) ? ' with the filters set.' : '.'}
              </p>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setFilter(DEFAULT_FILTER)}>
                Clear search and filters
              </button>
            </div>
          )}
        </div>
      </div>

      {menu && (
        <RowMenu
          ds={ds}
          ws={ws}
          channelId={menu.id}
          anchor={menu.anchor}
          onClose={closeMenu}
          onEditFormula={(def) => setDialog({ kind: 'edit', def })}
        />
      )}
      {dialog && (
        <FormulaDialog
          ds={ds}
          ws={ws}
          editing={dialog.kind === 'edit' ? dialog.def : null}
          preset={dialog.kind === 'new' ? dialog.preset : null}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      )}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ table

interface Column {
  key: SortKey
  label: string
  /** Header tooltip */
  title?: string
  num?: boolean
  className: string
}

const COLUMNS: readonly Column[] = [
  { key: 'group', label: 'Group', title: 'The X-Plane Data Output group', className: 'ch-c-group' },
  { key: 'label', label: 'Channel', className: 'ch-c-label' },
  { key: 'short', label: 'Short', className: 'ch-c-short' },
  { key: 'id', label: 'Token', title: 'The column header in the file (the channel id)', className: 'ch-c-id' },
  { key: 'unit', label: 'Unit', className: 'ch-c-unit' },
  { key: 'min', label: 'Min', num: true, className: 'ch-c-num' },
  { key: 'mean', label: 'Mean', num: true, className: 'ch-c-num' },
  { key: 'max', label: 'Max', num: true, className: 'ch-c-num' },
  { key: 'std', label: 'σ', title: 'Standard deviation', num: true, className: 'ch-c-num' },
  { key: 'finite', label: 'Values', title: 'Rows with a value', num: true, className: 'ch-c-count' },
  { key: 'flags', label: 'Flags', title: 'Formula, unknown to the dictionary, constant', className: 'ch-c-flags' },
]

function SortHeader({ column, sort, onSort }: { column: Column; sort: SortState; onSort: (key: SortKey) => void }) {
  const active = sort.key === column.key
  const Icon = active && sort.dir === 'desc' ? TriangleDownIcon : TriangleUpIcon
  const next = !active ? 'ascending' : sort.dir === 'asc' ? 'descending' : 'in file order'
  return (
    <th
      className={`${column.className}${column.num ? ' num' : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      title={column.title}
    >
      <button
        type="button"
        className="ch-sort"
        onClick={() => onSort(column.key)}
        aria-label={`${column.title ?? column.label}: sort ${next}`}
      >
        <span>{column.label}</span>
        <Icon className="ch-sort-icon" size={14} />
      </button>
    </th>
  )
}


const ChannelTableRow = memo(function ChannelTableRow({
  row,
  elapsed,
  rowCount,
  menuOpen,
  onMenu,
}: {
  row: ChannelRow
  elapsed: Float64Array
  rowCount: number
  menuOpen: boolean
  onMenu: (id: string, anchor: HTMLElement) => void
}) {
  const { ch } = row
  const { stats, meta } = ch
  const explained = !!(meta.description || meta.sign || meta.notes || ch.derived)
  const partial = stats.finite > 0 && stats.finite < rowCount
  return (
    <tr data-testid="channels-row">
      <td className="ch-c-group">
        <span className="chip chip-plain ch-group" title={row.group.name}>
          <span>{row.group.name}</span>
        </span>
      </td>
      <td className="ch-c-label" title={channelHelp(ch)}>
        <span className="ch-label-cell">
          <span className="ch-label">{meta.label}</span>
          {explained && <InfoIcon className="ch-help-icon" size={12} aria-hidden="true" />}
        </span>
      </td>
      <td className="ch-c-short" title={meta.short}>
        {meta.short}
      </td>
      <td className="ch-c-id" title={`${ch.id}\nIn formulas: ${channelAlias(ch)}`}>
        <code className="ch-token">{ch.id}</code>
      </td>
      <td className="ch-c-unit ch-unit">{meta.unit}</td>
      <td className="num" title={statTitle(stats.min)}>
        {statText(stats.min)}
      </td>
      <td className="num" title={statTitle(stats.mean)}>
        {statText(stats.mean)}
      </td>
      <td className="num" title={statTitle(stats.max)}>
        {statText(stats.max)}
      </td>
      <td className="num" title={statTitle(stats.std)}>
        {statText(stats.std)}
      </td>
      <td
        className={`num${partial ? ' ch-partial' : ''}`}
        title={stats.finite < rowCount ? `${count(stats.finite)} of ${count(rowCount)} rows have a value` : 'Every row has a value'}
      >
        {count(stats.finite)}
      </td>
      <td className="ch-c-flags">
        <span className="ch-flags">
          {row.formula && <span className="badge badge-info">formula</span>}
          {row.unknown && (
            <span
              className="badge badge-warning"
              title="The channel dictionary does not know this column: its name comes from the header"
            >
              unknown
            </span>
          )}
          {row.constant && (
            <span className="badge ch-flag-constant" title={stats.finite ? 'Every value is the same' : 'No values at all'}>
              {stats.finite ? 'constant' : 'empty'}
            </span>
          )}
        </span>
      </td>
      <td className="ch-c-spark">
        <Sparkline x={elapsed} y={ch.values} width={104} height={24} />
      </td>
      <td className="ch-c-menu">
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-xs ch-menu-button"
          aria-label={`Actions for ${meta.label}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => onMenu(ch.id, e.currentTarget)}
        >
          <KebabHorizontalIcon size={16} />
        </button>
      </td>
    </tr>
  )
})

// ------------------------------------------------------------------------------------------------ row actions menu

/**
 * The actions of one row, in a menu fixed to the screen next to the row's button (a dropdown inside the table's
 * scrolling frame would be clipped by it). Closes on a click elsewhere, Escape or Tab, or when its row scrolls away.
 */
function RowMenu({
  ds,
  ws,
  channelId,
  anchor,
  onClose,
  onEditFormula,
}: {
  ds: Dataset
  ws: Workspace
  channelId: string
  anchor: HTMLElement
  onClose: () => void
  onEditFormula: (def: DerivedDef) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const ch = channelById(ds, channelId)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    placeMenu(menu, anchor)
    menu.setAttribute('data-placed', '')
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [anchor])

  useEffect(() => {
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        anchor.focus()
        onClose()
      } else if (event.key === 'Tab') {
        // Leave the menu where it was opened (it sits at the end of the page), so Tab carries on from the row.
        event.preventDefault()
        anchor.focus()
        onClose()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const list = items()
        if (!list.length) return
        const at = list.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length
        list[next].focus()
      }
    }
    // The menu follows its button while the table scrolls, and closes once the button is out of sight.
    const follow = (event: Event) => {
      const menu = ref.current
      // A resize event's target is the window, not a node.
      if (!menu || (event.target instanceof Node && menu.contains(event.target))) return
      if (!placeMenu(menu, anchor)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [anchor, onClose])

  if (!ch) return null
  const title = channelTitle(ch)
  const alias = channelAlias(ch)
  const ys = ws.xy.ys
  const onY = ys.includes(ch.id)
  const yFull = ys.length >= MAX_SERIES
  const def = ch.derived ? ws.derived.find((d) => d.id === ch.id) : undefined

  const run = (action: () => void) => () => {
    onClose()
    action()
  }

  return createPortal(
    <div ref={ref} className="dropdown-menu ch-menu" role="menu" aria-label={`Actions for ${title}`}>
      <p className="menu-heading ch-menu-heading" title={title}>
        {title}
      </p>
      <MenuItem
        icon={<GraphIcon size={16} />}
        label="Plot in Time history"
        hint="A new panel with this channel"
        onSelect={run(() => {
          addPanel([ch.id])
          setTab('time')
        })}
      />
      <MenuItem
        icon={<AxisIcon axis="x" />}
        label="Use as X"
        hint={ws.xy.x === ch.id ? 'Already the X–Y plot’s X axis' : 'The X–Y plot’s horizontal axis'}
        onSelect={run(() => {
          setXY({ x: ch.id })
          setTab('xy')
        })}
      />
      <MenuItem
        icon={<AxisIcon axis="y" />}
        label="Add to Y"
        hint={
          onY
            ? 'Already on the X–Y plot’s Y axis'
            : yFull
              ? `The Y axis has ${MAX_SERIES} channels, the most`
              : `The X–Y plot’s Y axis (${ys.length} of ${MAX_SERIES})`
        }
        disabled={onY || yFull}
        onSelect={run(() => {
          setXY({ ys: [...ys, ch.id] })
          toast(`Added ${title} to the X–Y plot’s Y axis.`, 'success', { label: 'Open X–Y plot', run: () => setTab('xy') })
        })}
      />
      <MenuItem
        icon={<PulseIcon size={16} />}
        label="Analyse mode"
        hint="Fit a dynamic mode to this channel"
        onSelect={run(() => {
          setModes({ channelId: ch.id })
          setTab('modes')
        })}
      />
      <div className="menu-divider" />
      <MenuItem
        icon={<span className="ch-menu-fx">fx</span>}
        label="Copy formula name"
        hint={alias}
        onSelect={run(() => {
          void copyText(alias).then((copied) => {
            if (copied) toast(`Copied ${alias}: use it in a formula.`, 'success')
            else toast('Could not copy: the clipboard is not available here.', 'error')
          })
        })}
      />
      {def && (
        <MenuItem
          icon={<PencilIcon size={16} />}
          label="Edit formula"
          hint={def.expression}
          onSelect={run(() => onEditFormula(def))}
        />
      )}
    </div>,
    document.body,
  )
}

/**
 * Puts the menu under its button (above it when there is no room below), inside the window. Returns false, leaving the
 * menu where it is, when the button has scrolled out of the table's frame or the window.
 */
function placeMenu(menu: HTMLElement, anchor: HTMLElement): boolean {
  const box = anchor.getBoundingClientRect()
  const frame = anchor.closest('.ch-frame')?.getBoundingClientRect()
  const visible =
    box.bottom > Math.max(0, frame?.top ?? 0) &&
    box.top < Math.min(window.innerHeight, frame?.bottom ?? Infinity) &&
    box.right > Math.max(0, frame?.left ?? 0) &&
    box.left < Math.min(window.innerWidth, frame?.right ?? Infinity)
  if (!visible) return false
  const below = box.bottom + 4
  const top = below + menu.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, box.top - menu.offsetHeight - 4)
  const left = Math.max(8, Math.min(box.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))
  menu.style.top = `${top}px`
  menu.style.left = `${left}px`
  return true
}

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: ReactNode
  label: string
  hint?: string
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" role="menuitem" className="menu-item ch-menu-row" disabled={disabled} onClick={onSelect}>
      <span className="ch-menu-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ch-menu-text">
        <span>{label}</span>
        {hint && <small title={hint}>{hint}</small>}
      </span>
    </button>
  )
}

/** A tiny axis glyph with the axis letter (no octicon says "X axis"). */
function AxisIcon({ axis }: { axis: 'x' | 'y' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 2.5v11h11" strokeLinecap="round" strokeLinejoin="round" />
      {axis === 'x' ? (
        <path d="M7 5.5l4 4m0-4l-4 4" strokeLinecap="round" />
      ) : (
        <path d="M7 4.5l2 2.5 2-2.5M9 7v3.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

// ------------------------------------------------------------------------------------------------ formulas

const SHOWN_PRESETS = 6

function FormulasSection({
  ds,
  ws,
  onNew,
  onEdit,
}: {
  ds: Dataset
  ws: Workspace
  onNew: (preset: DerivedPreset | null) => void
  onEdit: (def: DerivedDef) => void
}) {
  const presets = useMemo(() => availablePresets(ds), [ds])
  const defs = ws.derived
  const activeId = useApp((s) => s.activeId)

  const remove = (def: DerivedDef) => {
    const before = ws.derived
    removeDerived(def.id)
    const after = getWorkspace()?.derived ?? []
    // Formulas that used it no longer evaluate, so the store drops them too: say so, and undo restores them all.
    const removed = before.filter((d) => !after.some((a) => a.id === d.id))
    const others = removed.filter((d) => d.id !== def.id)
    const names = others.map((d) => `“${d.name}”`).join(', ')
    const message = others.length
      ? `Deleted “${def.name}” and ${others.length === 1 ? 'the formula' : `${others.length} formulas`} that used it (${names}).`
      : `Deleted “${def.name}”.`
    toast(message, 'info', {
      label: 'Undo',
      run: () => {
        if (useApp.getState().activeId !== activeId) {
          toast('Switch back to that file to undo.', 'error')
          return
        }
        for (const d of removed) {
          saveDerived({ name: d.name, unit: d.unit, expression: d.expression }, d.id.replace(/^fx:/, ''))
        }
      },
    })
  }

  return (
    <section className="card ch-formulas" aria-labelledby="ch-formulas-title">
      <div className="ch-formulas-head">
        <div className="ch-formulas-heading">
          <h2 className="ch-formulas-title" id="ch-formulas-title">
            Formulas
            {defs.length > 0 && <span className="badge badge-count">{defs.length}</span>}
          </h2>
          <p className="ch-formulas-text">
            {defs.length > 0
              ? 'Channels computed row by row from the others. They are saved with this file and listed under Formulas in every channel list.'
              : 'Compute new channels from the ones in this file: dynamic pressure, CL, power required, specific excess power… They are saved with this file and plot like any other channel.'}
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" data-testid="formula-new" onClick={() => onNew(null)}>
          <PlusIcon size={16} />
          New formula
        </button>
      </div>
      {defs.length === 0 && presets.length > 0 && (
        <div className="ch-presets">
          <span className="ch-presets-label">Start from</span>
          {presets.slice(0, SHOWN_PRESETS).map((preset) => (
            <button key={preset.id} type="button" className="ch-pill" title={preset.description} onClick={() => onNew(preset)}>
              {preset.name}
            </button>
          ))}
          {presets.length > SHOWN_PRESETS && (
            <button type="button" className="ch-pill ch-pill-quiet" onClick={() => onNew(null)}>
              {presets.length - SHOWN_PRESETS} more…
            </button>
          )}
        </div>
      )}
      {defs.length > 0 && (
        <ul className="ch-formula-list">
          {defs.map((def) => {
            const ch = channelById(ds, def.id)
            return (
              <li key={def.id} className="ch-formula">
                <div className="ch-formula-head">
                  <span className="ch-formula-name">
                    <span title={def.name}>{def.name}</span>
                    {def.unit && <span className="ch-formula-unit">{def.unit}</span>}
                  </span>
                  <code className="ch-formula-alias" title="Its name inside other formulas">
                    {def.id.replace(/^fx:/, '')}
                  </code>
                </div>
                <code className="ch-expression" title={def.expression}>
                  {def.expression}
                </code>
                {ch ? <Sparkline x={ds.elapsed} y={ch.values} width={96} height={22} /> : <span />}
                <div className="ch-formula-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={`Edit ${def.name}`}
                    title="Edit"
                    onClick={() => onEdit(def)}
                  >
                    <PencilIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label={`Delete ${def.name}`}
                    title="Delete"
                    onClick={() => remove(def)}
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
