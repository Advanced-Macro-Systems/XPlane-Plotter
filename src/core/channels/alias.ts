// Identifiers for channels inside formulas (core/analysis/expr.ts): "_Vind,_kias" -> "Vind_kias",
// "elev1,__deg" 2nd occurrence -> "elev1_deg_2", "p-alt,ftMSL" -> "p_alt_ftMSL", "__L/D,_aero" -> "L_D_aero".
// Formulas may also use the raw token in brackets: [_Vind,_kias] or [elev1,__deg#2].

import type { Channel, Dataset } from '../types'

/** A formula-safe identifier for a header token (+ occurrence). Deterministic; never empty. */
export function aliasForToken(token: string, occurrence = 1): string {
  let alias = token
    .split(',')
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('_')
    .replace(/_+/g, '_')
  if (!alias) alias = 'col'
  if (/^[0-9]/.test(alias)) alias = `c_${alias}`
  return occurrence > 1 ? `${alias}_${occurrence}` : alias
}

/** The identifier a formula uses for this channel (derived channels use their slug, without the "fx:" prefix). */
export function channelAlias(ch: Channel): string {
  if (ch.derived) return ch.id.replace(/^fx:/, '')
  return aliasForToken(ch.token, ch.occurrence)
}

/**
 * Name -> values lookup for formulas: accepts aliases ("Vind_kias"), channel ids ("elev1,__deg#2") and raw tokens
 * ("_Vind,_kias", first occurrence). When two channels would share an alias the first one wins.
 */
export function makeResolver(ds: Dataset): (name: string) => Float64Array | undefined {
  const table = new Map<string, Float64Array>()
  for (const ch of ds.channels) {
    const alias = channelAlias(ch)
    if (!table.has(alias)) table.set(alias, ch.values)
    if (!table.has(ch.id)) table.set(ch.id, ch.values)
    if (ch.token && !table.has(ch.token)) table.set(ch.token, ch.values)
  }
  return (name) => table.get(name.trim())
}
