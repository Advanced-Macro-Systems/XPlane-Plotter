// Pure logic of the formula editor: live validation of an expression (syntax first, then evaluation for the preview),
// where the caret is, the word being typed, completions and inserting them, which formulas depend on which, and the
// id a save will give. No React here (unit-tested in node).

import { channelAlias, makeResolver } from '../../core/channels/alias'
import { slugify, withDerived } from '../../core/analysis/derived'
import { ExprError, compileExpression, exprHelp, type ExprHelpEntry } from '../../core/analysis/expr'
import { computeStats } from '../../core/dataset'
import type { Channel, ChannelStats, Dataset, DerivedDef } from '../../core/types'

/** Id of the formula being edited while it is previewed (never saved). */
export const PREVIEW_ID = 'fx:__xpp_preview__'

export type FormulaCheck =
  | { status: 'empty' }
  | {
      status: 'error'
      message: string
      /** 0-based character the error refers to, when known */
      position: number | null
      phase: 'syntax' | 'evaluate'
    }
  | { status: 'ok'; values: Float64Array; stats: ChannelStats; refs: string[] }

/**
 * The formulas a formula can refer to: those before it (all of them for a new formula). `editingId` is the formula
 * being edited, if any.
 */
export function formulasBefore(defs: readonly DerivedDef[], editingId: string | null): DerivedDef[] {
  if (!editingId) return [...defs]
  const index = defs.findIndex((d) => d.id === editingId)
  return index < 0 ? [...defs] : defs.slice(0, index)
}

/**
 * Checks an expression the way saving would: compileExpression for syntax errors and unknown functions (with the
 * caret position), then evaluation against the file channels plus the earlier formulas (`base`, i.e.
 * withDerived(ds, defsBefore).dataset) for the preview. Evaluation errors are worded by withDerived, which adds
 * "Did you mean <alias>?" for a misspelt channel.
 */
export function checkFormula(
  ds: Dataset,
  defsBefore: readonly DerivedDef[],
  expression: string,
  base: Dataset = withDerived(ds, defsBefore).dataset,
): FormulaCheck {
  if (!expression.trim()) return { status: 'empty' }
  let compiled: ReturnType<typeof compileExpression>
  try {
    compiled = compileExpression(expression)
  } catch (error) {
    if (error instanceof ExprError) {
      return { status: 'error', message: error.message, position: error.position, phase: 'syntax' }
    }
    throw error
  }
  try {
    const values = compiled.evaluate({ rowCount: ds.rowCount, time: ds.elapsed, resolve: makeResolver(base) })
    return { status: 'ok', values, stats: computeStats(values), refs: compiled.refs }
  } catch (error) {
    const trial = withDerived(ds, [...defsBefore, { id: PREVIEW_ID, name: 'Preview', unit: '', expression }])
    const message =
      trial.errors.find((e) => e.id === PREVIEW_ID)?.message ?? (error instanceof Error ? error.message : String(error))
    return {
      status: 'error',
      message,
      position: error instanceof ExprError ? error.position : null,
      phase: 'evaluate',
    }
  }
}

// ------------------------------------------------------------------------------------------------ caret and words

export interface CaretLocation {
  /** 1-based */
  line: number
  /** 0-based column within the line */
  column: number
  lineText: string
}

/** Line and column of a character position (clamped into the text). */
export function caretLocation(text: string, position: number): CaretLocation {
  const at = Math.max(0, Math.min(text.length, position))
  const before = text.slice(0, at)
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEnd = text.indexOf('\n', at)
  return {
    line: before.split('\n').length,
    column: at - lineStart,
    lineText: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd),
  }
}

export interface WordAtCaret {
  /** The identifier being typed (letters, digits, _), from its start up to the caret */
  prefix: string
  /** Where the identifier starts and ends (the end may be past the caret) */
  start: number
  end: number
}

const IDENT_CHAR = /[A-Za-z0-9_]/

/** The identifier around the caret; an empty prefix when the caret is not right after one (or in a number). */
export function wordAtCaret(text: string, caret: number): WordAtCaret {
  const at = Math.max(0, Math.min(text.length, caret))
  let start = at
  while (start > 0 && IDENT_CHAR.test(text[start - 1])) start -= 1
  let end = at
  while (end < text.length && IDENT_CHAR.test(text[end])) end += 1
  // Inside a [raw token] (closed after the caret, or not yet) or a number ("1e3"), there is no identifier to complete.
  const openBracket = at > 0 ? text.lastIndexOf('[', at - 1) : -1
  const closeBracket = openBracket >= 0 ? text.indexOf(']', openBracket) : -1
  const inBracket = openBracket >= 0 && (closeBracket < 0 || closeBracket >= at)
  if (inBracket || (start < at && /[0-9]/.test(text[start]))) return { prefix: '', start: at, end: at }
  return { prefix: text.slice(start, at), start, end }
}

export interface Insertion {
  text: string
  /** Caret position after inserting */
  caret: number
}

/**
 * Inserts `insert` at the caret, replacing the identifier being typed there (so "Vtr|" + "Vtrue_ktas" gives
 * "Vtrue_ktas|"). `caretOffset` places the caret inside the inserted text (e.g. between the parentheses of "sqrt()").
 */
export function insertCompletion(text: string, caret: number, insert: string, caretOffset = insert.length): Insertion {
  const word = wordAtCaret(text, caret)
  const at = Math.max(0, Math.min(text.length, caret))
  const from = word.prefix ? word.start : at
  const to = word.prefix ? word.end : at
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + caretOffset }
}

// ------------------------------------------------------------------------------------------------ completions

export interface AliasEntry {
  alias: string
  id: string
  label: string
  unit: string
  constant: boolean
  formula: boolean
}

/** The names a formula can use for each channel (file channels and earlier formulas). */
export function aliasEntries(channels: readonly Channel[]): AliasEntry[] {
  const seen = new Set<string>()
  const out: AliasEntry[] = []
  for (const ch of channels) {
    const alias = channelAlias(ch)
    // Two channels can share an alias: formulas resolve it to the first, so only that one is offered.
    if (seen.has(alias)) continue
    seen.add(alias)
    out.push({ alias, id: ch.id, label: ch.meta.label, unit: ch.meta.unit, constant: ch.stats.constant, formula: !!ch.derived })
  }
  return out
}

/**
 * Entries matching what is typed: names starting with it first, then names or labels containing it; varying channels
 * before constant ones. Everything (in file order, varying first) when nothing is typed. At most `limit`.
 */
export function suggestAliases(entries: readonly AliasEntry[], prefix: string, limit = 120): AliasEntry[] {
  const q = prefix.toLowerCase()
  const rank = (e: AliasEntry): number => {
    if (!q) return 0
    const alias = e.alias.toLowerCase()
    if (alias.startsWith(q)) return 0
    if (alias.includes(q)) return 1
    if (e.label.toLowerCase().includes(q)) return 2
    return -1
  }
  return entries
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || Number(a.entry.constant) - Number(b.entry.constant) || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.entry)
}

/** Functions and constants of the formula language whose names start with (or, failing that, contain) the prefix. */
export function suggestHelp(entries: readonly ExprHelpEntry[], prefix: string): ExprHelpEntry[] {
  const q = prefix.toLowerCase()
  if (!q) return [...entries]
  const starts = entries.filter((e) => e.name.toLowerCase().startsWith(q))
  return starts.length ? starts : entries.filter((e) => e.name.toLowerCase().includes(q))
}

export const FORMULA_HELP = exprHelp()

// ------------------------------------------------------------------------------------------------ saving

/**
 * The slug saveDerived builds the id from: an edited formula keeps its id while its name is unchanged, or always when
 * `locked` (other formulas use it by that name); a preset keeps its preset id; otherwise the name, slugified.
 */
export function formulaSlug(name: string, editing: DerivedDef | null, presetId: string | null, locked = false): string {
  if (editing && (locked || name.trim() === editing.name)) return editing.id.replace(/^fx:/, '')
  if (presetId) return presetId
  return slugify(name)
}

/**
 * The channel id saveDerived will give a formula saved with `slug`: "fx:<slug>", or "fx:<slug>_2", "_3"... when another
 * channel has it (the formula being replaced, `replaceId`, does not count).
 */
export function predictFormulaId(ds: Pick<Dataset, 'channels'>, slug: string, replaceId: string | null): string {
  const taken = new Set(ds.channels.map((c) => c.id))
  if (replaceId) taken.delete(replaceId)
  let id = `fx:${slug}`
  for (let n = 2; taken.has(id); n += 1) id = `fx:${slug}_${n}`
  return id
}

/** The names a formula can be referred to by in another formula: its alias (slug) and, in brackets, its id. */
function namesOf(def: DerivedDef): string[] {
  return [def.id.replace(/^fx:/, ''), def.id]
}

/** References of an expression ([] when it does not parse). */
function referencesOf(expression: string): string[] {
  try {
    return compileExpression(expression).refs
  } catch {
    return []
  }
}

/**
 * The formulas that use `id`, directly or through another formula (in workspace order). Removing or renaming `id`
 * breaks them: the store drops formulas that no longer evaluate.
 */
export function formulaDependents(defs: readonly DerivedDef[], id: string): DerivedDef[] {
  const index = defs.findIndex((d) => d.id === id)
  if (index < 0) return []
  const broken = new Set(namesOf(defs[index]))
  const out: DerivedDef[] = []
  // Formulas only see earlier ones, so one pass in order collects every chain.
  for (const def of defs.slice(index + 1)) {
    if (!referencesOf(def.expression).some((ref) => broken.has(ref))) continue
    out.push(def)
    for (const name of namesOf(def)) broken.add(name)
  }
  return out
}
