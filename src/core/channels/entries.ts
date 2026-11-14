// Runtime lookup tables, built once from the dictionary and the hand-curated overrides: entries by token
// and occurrence and by Data Output row, plus the numbered columns the dictionary covers only partly (it lists
// engines 1–2, tanks 1–3 and gears 1–3; a twin's engine-2 entry tells what engine 4 of a quad means).

import type { ChannelMeta } from '../types'
import { CHANNEL_ROWS } from './dictionary'
import { OVERRIDES } from './overrides'
import type { Confidence, ContextRule } from './schema'

/** Appended to the notes of every entry the research could only infer. */
export const LOW_CONFIDENCE_NOTE = 'Meaning inferred; not documented by Laminar.'

export interface Entry {
  readonly token: string
  /** The dictionary key: n-th time the token appears in a header with every row ticked in display order */
  readonly occurrence: number
  /** Data Output row (group id) */
  readonly group: string
  /** n-th time the token appears within its own row (left / right halves, gear 1, gear 2…) */
  readonly occInGroup: number
  /** Position within its row's entries (X-Plane 12 slot order, then older spellings) */
  readonly slot: number
  readonly confidence: Confidence
  readonly context?: ContextRule
  readonly meta: Readonly<ChannelMeta>
}

interface Tables {
  byKey: Map<string, Entry>
  byToken: Map<string, Entry[]>
  /** group -> token -> entries in occInGroup order */
  byGroup: Map<string, Map<string, Entry[]>>
  /** "group|token" of tokens whose n-th occurrence in the row is unit n (gear n, engine n) */
  numbered: Set<string>
}

let cache: Tables | null = null

const standaloneCache = new Map<number, RegExp>()

/** The number as a word of its own: the 1 of "engine 1." but not of "N1", "1st", "12.0.8" or "1.5". */
function standalone(n: number): RegExp {
  let re = standaloneCache.get(n)
  if (!re) {
    re = new RegExp(`(?<!\\w|\\d\\.)${n}(?!\\w|\\.\\d)`)
    standaloneCache.set(n, re)
  }
  return re
}

function joinNotes(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

function makeMeta(fields: {
  label: string
  short: string
  unit: string
  quantity: string
  group: string
  description: string
  sign: string
  notes: string
  confidence: Confidence
}): Readonly<ChannelMeta> {
  const meta: ChannelMeta = {
    label: fields.label,
    short: fields.short,
    unit: fields.unit,
    quantity: fields.quantity,
    group: fields.group,
    known: true,
  }
  if (fields.description) meta.description = fields.description
  if (fields.sign) meta.sign = fields.sign
  const notes = joinNotes(fields.notes, fields.confidence === 'l' ? LOW_CONFIDENCE_NOTE : '')
  if (notes) meta.notes = notes
  return meta
}

function build(): Tables {
  const byKey = new Map<string, Entry>()
  const byToken = new Map<string, Entry[]>()
  const byGroup = new Map<string, Map<string, Entry[]>>()
  const generatedNotes = new Map<Entry, string>()
  /** Entries per row so far: the next entry's slot */
  const slotCounter = new Map<string, number>()

  for (const row of CHANNEL_ROWS) {
    const [token, occurrence, group, label, short, unit, quantity, description, sign, notes, confidence, context] = row
    const fix = OVERRIDES[`${token}#${occurrence}`] ?? {}
    let tokens = byGroup.get(group)
    if (!tokens) {
      tokens = new Map()
      byGroup.set(group, tokens)
    }
    const inGroup = tokens.get(token) ?? []
    const slot = slotCounter.get(group) ?? 0
    slotCounter.set(group, slot + 1)
    const entry: Entry = {
      token,
      occurrence,
      group,
      occInGroup: inGroup.length + 1,
      slot,
      confidence,
      ...(context ? { context } : {}),
      meta: makeMeta({
        label: fix.label ?? label,
        short: fix.short ?? short,
        unit: fix.unit ?? unit,
        quantity: fix.quantity ?? quantity,
        group,
        description: fix.description ?? description,
        sign: fix.sign ?? sign,
        notes: fix.notes ?? notes,
        confidence,
      }),
    }
    inGroup.push(entry)
    tokens.set(token, inGroup)
    byKey.set(`${token}#${occurrence}`, entry)
    const list = byToken.get(token) ?? []
    list.push(entry)
    byToken.set(token, list)
    generatedNotes.set(entry, notes)
  }
  for (const list of byToken.values()) list.sort((a, b) => a.occurrence - b.occurrence)

  // Columns numbered by their order in the row: every entry's label carries its own number ("Gear 1 …", "Gear 2 …"),
  // or a single entry whose notes say the n-th occurrence is engine n.
  const numbered = new Set<string>()
  for (const [group, tokens] of byGroup) {
    for (const [token, list] of tokens) {
      const counted = list.every((entry, k) => standalone(k + 1).test(entry.meta.label))
      const single = list.length === 1 && /n-th occurrence is/.test(generatedNotes.get(list[0]) ?? '')
      if (counted && (list.length > 1 || single)) numbered.add(`${group}|${token}`)
    }
  }
  return { byKey, byToken, byGroup, numbered }
}

function tables(): Tables {
  cache ??= build()
  return cache
}

/** Every dictionary entry, in dictionary order. */
export function allEntries(): Entry[] {
  return [...tables().byKey.values()]
}

/** The entry for a token and its occurrence (the dictionary key), if any. */
export function entryFor(token: string, occurrence: number): Entry | undefined {
  return tables().byKey.get(`${token}#${occurrence}`)
}

/** Every entry of a token, by occurrence; undefined for tokens the dictionary does not contain. */
export function entriesOf(token: string): readonly Entry[] | undefined {
  return tables().byToken.get(token)
}

/** Entries of a token within one Data Output row, by occurrence within the row. */
export function slotsOf(group: string, token: string): readonly Entry[] | undefined {
  return tables().byGroup.get(group)?.get(token)
}

/** true when the n-th occurrence of `token` within `group` means unit n (gear rows, engine rows without a digit). */
export function isNumberedByOrder(group: string, token: string): boolean {
  return tables().numbered.has(`${group}|${token}`)
}

// ------------------------------------------------------------------ numbered columns beyond the dictionary

/** A token that differs from a dictionary token only in its unit number: "N1__3,_pcnt" is engine 3 of "N1__1,_pcnt". */
export interface DigitPattern {
  /** The dictionary token it is derived from */
  template: string
  /** Index of the unit digit in the token */
  position: number
  /** Number in the template token (1, or 2 when only the engine-2 token exists) */
  from: number
  /** Number in this token */
  to: number
}

const patternCache = new Map<string, DigitPattern | null>()

/**
 * For a token the dictionary does not contain: the dictionary token that has the same shape with digit 1 (or 2) in
 * place of one of its digits, when that entry's label carries the number ("N1, engine 1"). Engines 3+ of
 * "N1__3,_pcnt", "thrst,_4,lb", "FF__5,_lb/h"; tanks 4+ of "fuel4,___lb".
 */
export function digitPattern(token: string): DigitPattern | null {
  const cached = patternCache.get(token)
  if (cached !== undefined) return cached
  let found: DigitPattern | null = null
  const { byToken } = tables()
  if (!byToken.has(token)) {
    search: for (let p = token.length - 1; p >= 0; p -= 1) {
      const digit = token.charCodeAt(p) - 48
      if (digit < 0 || digit > 9) continue
      // A number of its own in the token: "fuel4", "_4,lb", not "fu14".
      if (/\d/.test(token[p - 1] ?? '') || /\d/.test(token[p + 1] ?? '')) continue
      for (const from of [1, 2]) {
        if (from === digit) continue
        const template = token.slice(0, p) + from + token.slice(p + 1)
        const entries = byToken.get(template)
        if (entries && entries.every((entry) => standalone(from).test(entry.meta.label))) {
          found = { template, position: p, from, to: digit }
          break search
        }
      }
    }
  }
  patternCache.set(token, found)
  return found
}

const UNIT_STEP = 1e-3
const COPY_STEP = 1e-6

/**
 * Where unit `to` of a digit-pattern token sits in its row: after the highest-numbered sibling the dictionary lists
 * (engine 3 after engine 2, tank 4 after tank 3), its k-th copy (left / right half) after its (k−1)-th.
 */
export function patternRank(group: string, pattern: DigitPattern, k: number): number {
  const prefix = pattern.template.slice(0, pattern.position)
  const suffix = pattern.template.slice(pattern.position + 1)
  let maxDigit = pattern.from
  let maxSlot = -1
  for (const [token, list] of tables().byGroup.get(group) ?? []) {
    if (token.length !== pattern.template.length || !token.startsWith(prefix) || !token.endsWith(suffix)) continue
    const digit = token.charCodeAt(pattern.position) - 48
    if (digit < 0 || digit > 9) continue
    maxDigit = Math.max(maxDigit, digit)
    for (const entry of list) maxSlot = Math.max(maxSlot, entry.slot)
  }
  return maxSlot + (pattern.to - maxDigit) * UNIT_STEP + k * COPY_STEP
}

/** Where copy k of a token numbered by order sits, beyond its last listed copy (gear 4 after gear 3). */
export function overflowRank(last: Entry, k: number): number {
  return last.slot + (k - last.occInGroup) * UNIT_STEP
}

/** The first standalone `from` in `text` replaced by `to`; in shorts also "L1" -> "L3" when there is none. */
function renumber(text: string, from: number, to: number, loose: boolean): string {
  const exact = standalone(from).exec(text)
  if (exact) return text.slice(0, exact.index) + to + text.slice(exact.index + String(from).length)
  if (!loose) return text
  const re = new RegExp(`(?<!\\d)${from}(?!\\d)`, 'g')
  let last = -1
  for (const match of text.matchAll(re)) last = match.index ?? -1
  return last < 0 ? text : text.slice(0, last) + to + text.slice(last + String(from).length)
}

/** "engine" in "N1, engine 1"; "tank" in "Fuel tank 1". */
function nounBefore(label: string, n: number): string {
  const match = new RegExp(`([A-Za-z][A-Za-z-]*)\\s+${n}(?!\\w|\\.\\d)`).exec(label)
  return match ? match[1].toLowerCase() : 'unit'
}

/**
 * The short name of unit `to` derived from the template's. A short without a number of its own ("δr" for rudder 1,
 * "δe left" for elevator 1) takes the form of the numbered sibling the dictionary lists for the same slot instead
 * ("δr 2" -> "δr 3", "δe2 right" -> "δe3 right"); without one, the number is appended ("δr 3").
 * `position`: index of the unit digit in the template token, when the unit number is part of the token.
 */
function renumberedShort(template: Entry, from: number, to: number, position: number | undefined): string {
  const short = renumber(template.meta.short, from, to, true)
  if (short !== template.meta.short) return short
  if (position !== undefined && template.token[position] === String(from)) {
    const { byToken } = tables()
    for (let digit = 1; digit <= 9; digit += 1) {
      if (digit === from) continue
      const siblings = byToken.get(template.token.slice(0, position) + digit + template.token.slice(position + 1)) ?? []
      const sameSlot = siblings.filter((entry) => entry.occInGroup === template.occInGroup)
      const sibling = sameSlot.find((entry) => entry.group === template.group) ?? sameSlot[0]
      if (!sibling) continue
      const numbered = renumber(sibling.meta.short, digit, to, true)
      if (numbered !== sibling.meta.short) return numbered
    }
  }
  return `${short} ${to}`
}

/**
 * The meaning of unit `to` derived from the entry of unit `from` ("N1, engine 1" -> "N1, engine 3"): same row, unit
 * and quantity, known, with a note saying it was matched by pattern. `position` is the index of the unit digit in the
 * token for digit patterns ("rudr3,__deg"); leave it out for columns numbered by their order (gear 4).
 */
export function renumberedMeta(template: Entry, from: number, to: number, position?: number): ChannelMeta {
  const { meta } = template
  const noun = nounBefore(meta.label, from)
  const derived: ChannelMeta = {
    label: renumber(meta.label, from, to, false),
    short: renumberedShort(template, from, to, position),
    unit: meta.unit,
    quantity: meta.quantity,
    group: meta.group,
    known: true,
  }
  if (meta.description) derived.description = renumber(meta.description, from, to, false)
  if (meta.sign) derived.sign = meta.sign
  derived.notes = joinNotes(
    `Pattern match: ${noun} ${to} (from the ${noun}-${from} entry).`,
    template.confidence === 'l' ? LOW_CONFIDENCE_NOTE : '',
  )
  return derived
}

/** A further occurrence of a token beyond the ones the dictionary lists: the last listed meaning, marked "(n)". */
export function repeatedMeta(last: Entry, occurrence: number): ChannelMeta {
  const { meta } = last
  return {
    ...meta,
    label: `${meta.label} (${occurrence})`,
    short: `${meta.short} (${occurrence})`,
    notes: joinNotes(`Occurrence ${occurrence} of this token; the dictionary lists ${last.occurrence}, so it is read as the last one.`, meta.notes),
  }
}
