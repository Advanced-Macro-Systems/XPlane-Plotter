// Citations and "not checkable" lines for the checklists. The registry writes citations as short keys (the spec's
// form: "NATO 13-10", "FD12b p.28", "B p.7", "MIL p.40", "EJ") and this module turns them into the short forms the UI
// and the exports show. Row references ({25}) are expanded with the Data Output row's X-Plane 12 name from the
// dictionary's row list; an index not confirmed for X-Plane 12 gets a star and "find by name".

import { GROUP_ROWS } from '../channels/groupRows'

/**
 * The display form of a citation key:
 * - "NATO 13-10" -> "NATO AG-300 v14 p.13-10" (RTO-AG-300 Vol. 14, printed chapter-page)
 * - "MIL p.40" -> "MIL-F-8785C guide p.40" (AFWAL-TR-81-3109, the background and user guide)
 * - "B p.7" -> "Brief p.7"; "BS slide 20" -> "Briefing slides s.20"
 * - "FD10 slide 25" -> "FD10 s.25"; "FD12b p.28", "Cook p.47" unchanged
 * - "App src/core/time.ts" -> "App time.ts" (this app's own definition)
 * Returns null for "EJ" (engineering judgement is a tag, not a citation).
 */
export function formatCitation(key: string): string | null {
  const text = key.trim()
  if (!text || text === 'EJ') return null
  let m = /^NATO\s+(.+)$/.exec(text)
  if (m) return `NATO AG-300 v14 p.${m[1]}`
  m = /^MIL\s+(pp?\.\s*.+)$/.exec(text)
  if (m) return `MIL-F-8785C guide ${m[1].replace(/\s+/g, '')}`
  m = /^B\s+(pp?\.\s*.+)$/.exec(text)
  if (m) return `Brief ${m[1].replace(/\s+/g, '')}`
  m = /^BS\s+slides?\s+(.+)$/.exec(text)
  if (m) return `Briefing slides s.${m[1]}`
  m = /^(FD\d+[a-z]?)\s+slides?\s+(.+)$/.exec(text)
  if (m) return `${m[1]} s.${m[2]}`
  m = /^App\s+(.+)$/.exec(text)
  if (m) {
    const file = m[1].split(/\s+/)[0].split('/').pop() ?? m[1]
    return `App ${file.replace(/\(.*$/, '')}`
  }
  return text
}

/** Every citation key formatted, without "EJ", repeats removed. */
export function formatCitations(keys: readonly string[]): string[] {
  const out: string[] = []
  for (const key of keys) {
    const text = formatCitation(key)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/** "25* (Throttle (commanded))": a Data Output row by its X-Plane 12 index, starred when the index is not confirmed. */
export function rowName(index: number): { text: string; confirmed: boolean } {
  const row = GROUP_ROWS.find((r) => r[1] === index)
  if (!row) return { text: String(index), confirmed: true }
  const confirmed = row[4] === 1
  return { text: `${index}${confirmed ? '' : '*'} (${row[2]})`, confirmed }
}

/**
 * A "not checkable" line from a template: "{25}" becomes "25* (Throttle (commanded))", and when any row index is not
 * confirmed for X-Plane 12 the line ends with "(* find by name)".
 */
export function expandRows(template: string): string {
  let starred = false
  const text = template.replace(/\{(\d+)\}/g, (_, n: string) => {
    const row = rowName(Number(n))
    if (!row.confirmed) starred = true
    return row.text
  })
  return starred ? `${text} (* find by name)` : text
}

/** The standard wording: "Not checkable — log row 63 (Weight and balance)". */
export function notCheckableText(needs: string): string {
  const text = expandRows(needs)
  return /^(Not checkable|Needs)\b/.test(text) ? text : `Not checkable — log ${text}`
}
