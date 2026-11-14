// Searchable, grouped channel chooser (single or multiple). Used by every view: Time-history panels, X–Y axes, the
// mode channel, test-point columns. Groups follow the X-Plane Data Output rows (core/channels); constant channels are
// tucked away by default because X-Plane logs many (empty weights, unused load stations...).

import { CheckIcon, ChevronDownIcon, SearchIcon } from '@primer/octicons-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { channelTitle } from '../core/channels'
import { channelById } from '../core/dataset'
import type { Channel, Dataset } from '../core/types'
import { Dropdown } from '../ui/Dropdown'
import { groupChannels, matchesChannel } from './channelGroups'
import './channelPicker.css'

interface ChannelListProps {
  dataset: Dataset
  selected: readonly string[]
  multiple: boolean
  max?: number
  filter?: (ch: Channel) => boolean
  onPick: (id: string) => void
  /** Focus the search box when shown (inside a dropdown) */
  autoFocus?: boolean
  /** Extra content above the list (e.g. "None" option) */
  header?: ReactNode
  /** Max height of the scrolling list in px */
  maxHeight?: number
  /** Show constant channels initially */
  showConstantInitially?: boolean
  /** Accessible name of the list (default "Channels") */
  listLabel?: string
}

/** Options moved by PageUp / PageDown */
const PAGE_STEP = 8

/**
 * The list itself (search + grouped options); also usable inline, e.g. as a sidebar. One tab stop: the search box is a
 * combobox that drives the list (↑/↓, PageUp/PageDown, Home/End, Enter picks), so Tab moves past the list at once.
 */
export function ChannelList({
  dataset,
  selected,
  multiple,
  max,
  filter,
  onPick,
  autoFocus,
  header,
  maxHeight = 360,
  showConstantInitially = false,
  listLabel = 'Channels',
}: ChannelListProps) {
  const [query, setQuery] = useState('')
  const [showConstant, setShowConstant] = useState(showConstantInitially)
  const [active, setActive] = useState(0)
  /** The search box has the focus: the active option is the keyboard's position and gets the focus ring */
  const [typing, setTyping] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const candidates = useMemo(
    () => dataset.channels.filter((ch) => (!filter || filter(ch)) && (showConstant || !ch.stats.constant || selectedSet.has(ch.id))),
    [dataset, filter, showConstant, selectedSet],
  )
  const hiddenConstant = useMemo(
    () => (showConstant ? 0 : dataset.channels.filter((ch) => (!filter || filter(ch)) && ch.stats.constant && !selectedSet.has(ch.id)).length),
    [dataset, filter, showConstant, selectedSet],
  )
  const blocks = useMemo(() => groupChannels(candidates.filter((ch) => matchesChannel(ch, query))), [candidates, query])
  const flat = useMemo(() => blocks.flatMap((b) => b.channels), [blocks])
  const flatIndex = useMemo(() => new Map(flat.map((ch, i) => [ch.id, i])), [flat])
  const full = multiple && max !== undefined && selected.length >= max

  useEffect(() => {
    if (autoFocus) searchRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    // Keep the keyboard-active option in view.
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const optionId = (i: number) => `${listId}-o${i}`
  const move = (to: (i: number) => number) => setActive((i) => Math.max(0, Math.min(flat.length - 1, to(i))))

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move((i) => i + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move((i) => i - 1)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      move((i) => i + PAGE_STEP)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      move((i) => i - PAGE_STEP)
    } else if ((event.key === 'Home' || event.key === 'End') && !event.shiftKey) {
      event.preventDefault()
      move(() => (event.key === 'Home' ? 0 : flat.length - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const ch = flat[active]
      if (ch && !(full && !selectedSet.has(ch.id))) onPick(ch.id)
    }
  }

  return (
    <div className="cp">
      <div className="cp-search">
        <SearchIcon className="cp-search-icon" size={14} />
        <input
          ref={searchRef}
          className="input input-sm cp-search-input"
          type="search"
          role="combobox"
          placeholder={`Search ${candidates.length} channels…`}
          value={query}
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={flat[active] ? optionId(active) : undefined}
          aria-label="Search channels"
          title="Type to filter; ↑ ↓ to move through the list, Enter to pick"
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onKeyDown={onKeyDown}
          data-autofocus={autoFocus ? '' : undefined}
        />
      </div>
      {header}
      <div
        ref={listRef}
        id={listId}
        className="cp-list"
        role="listbox"
        aria-label={listLabel}
        aria-multiselectable={multiple}
        style={{ maxHeight }}
      >
        {blocks.length === 0 && <p className="cp-empty">No channels match “{query}”.</p>}
        {blocks.map((block) => (
          <div key={block.id} role="group" aria-label={block.name}>
            <p className="menu-heading cp-heading">{block.name}</p>
            {block.channels.map((ch) => {
              const i = flatIndex.get(ch.id) ?? -1
              const isSelected = selectedSet.has(ch.id)
              const disabled = full && !isSelected
              return (
                <button
                  key={ch.id}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  aria-disabled={disabled || undefined}
                  data-index={i}
                  className={`cp-option${i === active ? ` cp-option-active${typing ? ' cp-option-cursor' : ''}` : ''}`}
                  disabled={disabled}
                  title={disabled ? `At most ${max} channels` : (ch.meta.description ?? ch.meta.label)}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onPick(ch.id)}
                >
                  <span className="cp-check" aria-hidden="true">
                    {isSelected && <CheckIcon size={14} />}
                  </span>
                  <span className="cp-text">
                    <span className="cp-label">{ch.meta.label}</span>
                    <span className="cp-token mono">
                      {ch.derived ? `= ${ch.derived.expression}` : ch.id}
                      {ch.stats.constant && <span className="cp-flag">constant</span>}
                    </span>
                  </span>
                  {ch.meta.unit && <span className="cp-unit mono">{ch.meta.unit}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {(hiddenConstant > 0 || showConstant) && (
        <label className="check cp-constant">
          <input type="checkbox" checked={showConstant} onChange={(e) => setShowConstant(e.target.checked)} />
          Show constant channels{hiddenConstant > 0 ? ` (${hiddenConstant} hidden)` : ''}
        </label>
      )}
    </div>
  )
}

interface ChannelPickerProps {
  dataset: Dataset
  /** Selected ids (one id for single mode; [] for none) */
  value: readonly string[]
  onChange: (ids: string[]) => void
  multiple?: boolean
  /** Multiple mode: most channels that can be ticked */
  max?: number
  filter?: (ch: Channel) => boolean
  placeholder?: string
  /** Single mode: offer a "None" option */
  allowNone?: boolean
  /** Replaces the default button content */
  label?: ReactNode
  buttonClassName?: string
  align?: 'left' | 'right'
  width?: number
  ariaLabel: string
  title?: string
  disabled?: boolean
}

/** A button that opens the channel list in a dropdown. Single mode closes on pick; multiple mode toggles. */
export function ChannelPicker({
  dataset,
  value,
  onChange,
  multiple = false,
  max,
  filter,
  placeholder = 'Choose a channel',
  allowNone = false,
  label,
  buttonClassName = 'cp-button',
  align = 'left',
  width = 380,
  ariaLabel,
  title,
  disabled,
}: ChannelPickerProps) {
  const first = value[0] ? channelById(dataset, value[0]) : undefined
  const content =
    label ??
    (multiple ? (
      <span className="cp-button-text">
        {value.length ? `${value.length} channel${value.length === 1 ? '' : 's'}` : placeholder}
      </span>
    ) : (
      <span className="cp-button-text">
        {first ? channelTitle(first) : <span className="subtle">{placeholder}</span>}
      </span>
    ))

  return (
    <Dropdown
      label={
        <>
          {content}
          <ChevronDownIcon className="cp-chevron" size={16} />
        </>
      }
      ariaLabel={ariaLabel}
      title={title ?? (first && !multiple ? first.meta.label : undefined)}
      buttonClassName={buttonClassName}
      align={align}
      width={width}
      disabled={disabled}
      haspopup="dialog"
    >
      {(close) => (
        <ChannelList
          dataset={dataset}
          selected={value}
          multiple={multiple}
          max={max}
          filter={filter}
          autoFocus
          header={
            allowNone && !multiple ? (
              <button
                type="button"
                className="menu-item cp-none"
                onClick={() => {
                  onChange([])
                  close()
                }}
              >
                <span className="subtle">None</span>
              </button>
            ) : undefined
          }
          onPick={(id) => {
            if (multiple) {
              onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
            } else {
              onChange([id])
              close()
            }
          }}
        />
      )}
    </Dropdown>
  )
}
