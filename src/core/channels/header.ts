// Meanings for a whole header at once. X-Plane writes every ticked Data Output row as one contiguous block of its
// tokens, so a header is read as a sequence of row blocks: a token that several rows write ("_side,___lb" for aero,
// gear and engine forces; "____P,deg/s" for body rates and the motion platform; "_wind,__dir" for three METAR layers
// and the local wind…) takes its meaning from the block it sits in, not from how often it occurred before.

import type { ChannelMeta } from '../types'
import { cleanToken, describeChannel, metaOf, pandasRepeat } from './describe'
import {
  digitPattern,
  entriesOf,
  isNumberedByOrder,
  overflowRank,
  patternRank,
  renumberedMeta,
  slotsOf,
  type DigitPattern,
  type Entry,
} from './entries'
import { groupPosition, groupTag } from './groups'
import type { ContextRule } from './schema'

interface Column {
  /** Token for lookups: control characters and a pandas ".1" suffix removed */
  token: string
  /** Occurrence of the raw header text (as Dataset channel ids count it); used for the fallback */
  rawOccurrence: number
  /** Occurrence of `token` in the header */
  occurrence: number
  /** Dictionary token whose entries apply: the token itself, or the engine-1 token of "N1__3,_pcnt" */
  lookup: string
  pattern: DigitPattern | null
  /** Rows (group ids) this token can belong to; empty for unknown tokens */
  groups: readonly string[]
}

/** One column placed in a row block: the entry of its slot (or the template of a numbered unit). */
interface Placed {
  column: number
  entry: Entry
  /** Occurrence of the token within the block */
  k: number
}

interface Block {
  group: string
  placed: Placed[]
  /** First column after the block (trailing unknown columns are not part of it) */
  end: number
}

function readColumns(tokens: readonly string[]): Column[] {
  const rawCounts = new Map<string, number>()
  const counts = new Map<string, number>()
  return tokens.map((raw) => {
    const rawOccurrence = (rawCounts.get(raw) ?? 0) + 1
    rawCounts.set(raw, rawOccurrence)
    const clean = cleanToken(raw)
    const token = pandasRepeat(clean)?.token ?? clean
    const occurrence = (counts.get(token) ?? 0) + 1
    counts.set(token, occurrence)
    let lookup = token
    let pattern: DigitPattern | null = null
    let entries = entriesOf(token)
    if (!entries) {
      pattern = digitPattern(token)
      if (pattern) {
        lookup = pattern.template
        entries = entriesOf(lookup)
      }
    }
    const groups = entries ? [...new Set(entries.map((entry) => entry.group))] : []
    return { token, rawOccurrence, occurrence, lookup, pattern, groups }
  })
}

/**
 * The longest block of `group` starting at `start`: tokens of that row in the row's slot order, each at most as
 * often as the row has it (numbered units beyond the dictionary follow their highest-numbered sibling).
 */
function extend(columns: readonly Column[], group: string, start: number): Block {
  const counts = new Map<string, number>()
  const placed: Placed[] = []
  let lastRank = -Infinity
  for (let j = start; j < columns.length; j += 1) {
    const column = columns[j]
    if (!column.groups.length) continue // an unknown column inside a row: skip it, the row may go on
    if (!column.groups.includes(group)) break
    const slots = slotsOf(group, column.lookup)
    if (!slots?.length) break
    const k = (counts.get(column.token) ?? 0) + 1
    let rank: number
    if (column.pattern) {
      if (k > slots.length) break
      rank = patternRank(group, column.pattern, k)
    } else if (k <= slots.length) {
      rank = slots[k - 1].slot
    } else if (isNumberedByOrder(group, column.lookup)) {
      rank = overflowRank(slots[slots.length - 1], k)
    } else {
      break
    }
    // The next row's tokens can belong to this row too (its P, Q, R before the motion platform's): a step back in
    // slot order starts a new block.
    if (rank <= lastRank) break
    lastRank = rank
    counts.set(column.token, k)
    placed.push({ column: j, entry: slots[Math.min(k, slots.length) - 1], k })
  }
  const last = placed[placed.length - 1]
  return { group, placed, end: last ? last.column + 1 : start + 1 }
}

/** +1 per condition of the rule that the neighbours satisfy, −1 per condition they break. */
function ruleScore(rule: ContextRule, column: number, block: Block, columns: readonly Column[], blockStart: number): number {
  const tokenAt = (j: number) => columns[j]?.token
  const precededBy = (seq: readonly string[]) => seq.every((t, i) => tokenAt(column - seq.length + i) === t)
  let score = 0
  if (rule.after) score += precededBy(rule.after) ? 1 : -1
  if (rule.before) score += rule.before.every((t, i) => tokenAt(column + 1 + i) === t) ? 1 : -1
  if (rule.notAfter) score += precededBy(rule.notAfter) ? -1 : 1
  if (rule.block) {
    const { nth, marker } = rule.block
    const inBlock = block.placed.some((p) => columns[p.column].token === marker)
    let before = 0
    for (let j = 0; j < blockStart; j += 1) if (columns[j].token === marker) before += 1
    score += inBlock && before + 1 === nth ? 1 : -1
  }
  if (rule.nthInFile) score += columns[column].occurrence === rule.nthInFile ? 1 : -1
  return score
}

/** [run length, context rules, row not used yet, dictionary occurrences agree, row order kept, -display position] */
function blockScore(
  block: Block,
  columns: readonly Column[],
  start: number,
  used: ReadonlySet<string>,
  previousPosition: number,
): number[] {
  let rules = 0
  let agree = 0
  for (const p of block.placed) {
    if (p.entry.context) rules += ruleScore(p.entry.context, p.column, block, columns, start)
    if (p.entry.occurrence === columns[p.column].occurrence) agree += 1
  }
  const position = groupPosition(block.group)
  return [block.placed.length, rules, used.has(block.group) ? 0 : 1, agree, position > previousPosition ? 1 : 0, -position]
}

function better(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

function placedMeta(p: Placed, column: Column): ChannelMeta {
  if (column.pattern) return renumberedMeta(p.entry, column.pattern.from, column.pattern.to, column.pattern.position)
  if (p.k > p.entry.occInGroup) {
    // Gear 4 of a row whose entries stop at gear 3: derived from gear 1.
    const first = slotsOf(p.entry.group, column.lookup)?.[0] ?? p.entry
    return renumberedMeta(first, 1, p.k)
  }
  return metaOf(p.entry)
}

/** Later columns that repeat an earlier short (or label) get their row's tag, else " (2)", " (3)"… */
function makeUnique(metas: ChannelMeta[], key: 'short' | 'label', groups: readonly (string | null)[]): void {
  const firstGroup = new Map<string, string | null>()
  const taken = new Set<string>()
  metas.forEach((meta, i) => {
    const name = meta[key]
    if (!taken.has(name)) {
      taken.add(name)
      firstGroup.set(name, groups[i])
      return
    }
    const tag = groups[i] ? groupTag(groups[i]) : undefined
    let next = tag && groups[i] !== firstGroup.get(name) ? `${name} (${tag})` : ''
    for (let n = 2; !next || taken.has(next); n += 1) next = `${name} (${n})`
    meta[key] = next
    taken.add(next)
  })
}

/**
 * Meanings of every column of a header, in order. The header is read as X-Plane writes it: one contiguous block per
 * ticked Data Output row. Each block is matched to the row whose tokens it holds (the longest match wins; ties go to
 * the row whose context rules the neighbours satisfy, then to a row not used yet, then to the dictionary's occurrence
 * order and X-Plane's row order). Each column then takes the entry of its slot in that row, so a token that several
 * rows write gets the meaning of its own row. Unknown columns between or inside rows are skipped; they and anything
 * that matches no row fall back to describeChannel. Short names are made unique within the header.
 */
export function describeHeader(tokens: readonly string[]): ChannelMeta[] {
  const columns = readColumns(tokens)
  const metas: (ChannelMeta | null)[] = new Array<ChannelMeta | null>(columns.length).fill(null)
  const groups: (string | null)[] = new Array<string | null>(columns.length).fill(null)
  const used = new Set<string>()
  let previousPosition = -1

  let i = 0
  while (i < columns.length) {
    const column = columns[i]
    if (!column.groups.length) {
      i += 1
      continue
    }
    let best: Block | null = null
    let bestScore: number[] = []
    for (const group of column.groups) {
      const block = extend(columns, group, i)
      if (!block.placed.length) continue
      const score = blockScore(block, columns, i, used, previousPosition)
      if (!best || better(score, bestScore)) {
        best = block
        bestScore = score
      }
    }
    if (!best) {
      i += 1
      continue
    }
    for (const p of best.placed) {
      metas[p.column] = placedMeta(p, columns[p.column])
      groups[p.column] = best.group
    }
    used.add(best.group)
    previousPosition = groupPosition(best.group)
    i = best.end
  }

  const result = metas.map((meta, c) => meta ?? describeChannel(tokens[c], columns[c].rawOccurrence))
  makeUnique(result, 'short', groups)
  makeUnique(result, 'label', groups)
  return result
}
