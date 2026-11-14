// The meaning of one header token on its own: the dictionary entry for (token, occurrence), a numbered entry derived
// from a sibling (engine 3 from engine 1), or a readable fallback for tokens the dictionary does not contain.

import type { ChannelMeta } from '../types'
import { digitPattern, entriesOf, isNumberedByOrder, renumberedMeta, repeatedMeta, type Entry } from './entries'
import { fallbackMeta } from './units'

/** Control characters (X-Plane 12 writes "sync_,butn" followed by a NUL byte) and padding spaces removed. */
export function cleanToken(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

/** pandas renames repeated columns "elev1,__deg.1": the base token and the occurrence that suffix stands for. */
export function pandasRepeat(token: string): { token: string; occurrence: number } | null {
  const match = /^(.*\S)\s*\.(\d{1,2})$/.exec(token)
  if (!match || !match[1].includes(',')) return null
  const base = match[1]
  if (!entriesOf(base) && !digitPattern(base)) return null
  return { token: base, occurrence: Number(match[2]) + 1 }
}

/** The entry's meaning as a fresh object (the tables stay untouched by callers). */
export function metaOf(entry: Entry): ChannelMeta {
  return { ...entry.meta }
}

/** Dictionary meaning of a cleaned token, or null when the dictionary has nothing for it. */
export function knownMeta(token: string, occurrence: number): ChannelMeta | null {
  const entries = entriesOf(token)
  if (entries) {
    const exact = entries.find((entry) => entry.occurrence === occurrence)
    if (exact) return metaOf(exact)
    const last = entries[entries.length - 1]
    if (occurrence < 1) return metaOf(entries[0])
    // Gear 4 of a token whose dictionary entries are gear 1–3.
    const groups = new Set(entries.map((entry) => entry.group))
    if (groups.size === 1 && isNumberedByOrder(last.group, token)) return renumberedMeta(entries[0], 1, occurrence)
    return repeatedMeta(last, occurrence)
  }
  const pattern = digitPattern(token)
  if (pattern) {
    const templates = entriesOf(pattern.template) ?? []
    const template = templates.find((entry) => entry.occurrence === occurrence) ?? templates[0]
    if (template) return renumberedMeta(template, pattern.from, pattern.to, pattern.position)
  }
  return null
}

/**
 * Meaning of a header token. `occurrence` is 1 for the first time a token appears in the header, 2 for its repeat...
 * Known X-Plane tokens get the dictionary entry for that occurrence (the order rows have when every row is ticked;
 * describeHeader resolves tokens that several rows write from their neighbours instead). Engines and tanks beyond the
 * dictionary's are derived from engine 1 / tank 1 ("N1__3,_pcnt" -> "N1, engine 3"). Unknown tokens get a readable
 * fallback with known: false: underscores removed, name/unit split ("ab_cd,__deg" -> label "ab cd", unit "deg"), unit
 * abbreviations normalised (kias -> kt, d/ss -> deg/s², ftMSL -> ft, lb-ft -> lb·ft ...). CSV headers like
 * "Airspeed (kt)", "alpha [deg]" or "time_s" get their unit split out, so describeChannel('Time (s)', 1).label === 'Time'.
 */
export function describeChannel(token: string, occurrence: number): ChannelMeta {
  const clean = cleanToken(token)
  const repeat = pandasRepeat(clean)
  const known = repeat ? knownMeta(repeat.token, repeat.occurrence) : knownMeta(clean, occurrence)
  return known ?? fallbackMeta(clean || token, occurrence)
}
