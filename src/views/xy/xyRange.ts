// Range and endurance on the X–Y plot (core/analysis/rangeEndurance.ts): for every fit its minimum (maximum endurance)
// and the tangent from the origin (maximum range), the construction colours and the label texts. The chart option,
// the results table and its TSV read these. Pure: no React, no DOM.

import {
  physicalRangeEndurance,
  polyRangeEndurance,
  type RangeEndurance,
  type REPoint,
} from '../../core/analysis/rangeEndurance'
import type { XYData, XYFit } from './xyModel'

/**
 * Categorical slots of the two constructions: maximum endurance in aqua (--series-3), maximum range in orange
 * (--series-2). With the data in the first slot (blue) the three pass the palette validator's colour-vision checks for
 * every pair, in light and dark; aqua's low contrast on white is relieved by the labels and the results table.
 */
export const ENDURANCE_SLOT = 2
export const RANGE_SLOT = 1

export type Construction = 'endurance' | 'range'

/** The colour slot of each construction; null = neutral ink (the chart's text colour). */
export type ConstructionSlots = Record<Construction, number | null>

/**
 * The constructions' colours: aqua and orange, unless the plotted data are drawn in either of them (a second
 * test-point group is orange, a channel kept slot 2): then both are drawn in neutral ink, told apart by their line
 * styles (dashed guides through the minimum; the solid tangent from the origin with a dash-dot guide at V_R) and their
 * labels. No fourth palette colour passes the validator's all-pairs checks beside blue, orange and aqua, so a free slot
 * would not be safe. The MATLAB export decides the same way at run time (xy.reSlot, xy.reInk).
 */
export function constructionSlots(used: Iterable<number>): ConstructionSlots {
  const taken = new Set(used)
  return taken.has(ENDURANCE_SLOT) || taken.has(RANGE_SLOT)
    ? { endurance: null, range: null }
    : { endurance: ENDURANCE_SLOT, range: RANGE_SLOT }
}

/** The colour slots the plot's data use: one per sample series (its means and fit share it). */
export function dataSlots(data: Pick<XYData, 'series'>): number[] {
  return data.series.map((s) => s.slot)
}

export interface XYRange {
  /** The fit's key: one result per fit */
  key: string
  fit: XYFit
  re: RangeEndurance
}

/**
 * Why the plot gives no range and endurance when the settings ask for test points and the file has none (the plot
 * then shows every row): a fit through a whole log mixes taxiing, climbs and turns.
 */
export const NEEDS_TEST_POINTS =
  'Save steady level test points first (Find steady points, or Time history → Select → Save test point, one per ' +
  'speed): range and endurance come from a fit through their means, not through every row of the log.'

/**
 * Maximum endurance and maximum range of every fit that exists (polynomial numerically, physical in closed form).
 * With `heldBack` (a reason) every fit gets no points and that note instead.
 */
export function rangeResults(fits: readonly XYFit[], heldBack = ''): XYRange[] {
  const out: XYRange[] = []
  for (const fit of fits) {
    const found = fit.fit ? polyRangeEndurance(fit.fit) : fit.physical ? physicalRangeEndurance(fit.physical) : null
    if (!found) continue
    const re: RangeEndurance = heldBack
      ? { ...found, endurance: null, range: null, enduranceNote: heldBack, rangeNote: heldBack, slope: NaN, ratio: NaN }
      : found
    out.push({ key: fit.key, fit, re })
  }
  return out
}

/** A value for a label: whole numbers from 20 up ("72"), else 3 significant figures ("15.6", "0.623"). */
export function labelNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  const text = magnitude >= 20 ? String(Math.round(value)) : String(Number(value.toPrecision(3)))
  return text.replace('-', '−')
}

export interface ConstructionLabel {
  /** Plain text, e.g. "Max endurance V_E = 72 kt" (tests, accessible descriptions) */
  text: string
  /** The text in three parts around the subscript letter, for drawing: "Max endurance V", "E", " = 72 kt" */
  lead: string
  sub: string
  tail: string
  /** The value alone, without the extrapolation note: " = 72 kt" */
  value: string
  /** The short lead, without the words: "V", or "Heavy: V" with several fits */
  short: string
  /** The point lies outside the fitted speeds: the text ends with " (extrapolated)" */
  extrapolated: boolean
}

/** The note a label ends with when its point lies outside the fitted speeds. */
export const EXTRAPOLATED = '(extrapolated)'

/**
 * "Max endurance V_E = 72 kt" / "Max range V_R = 95 kt", with " (extrapolated)" when the point lies outside the fitted
 * speeds, and the fit's name first when several fits are drawn ("Heavy: max range V_R = 97 kt").
 */
export function constructionLabel(kind: Construction, point: REPoint, xUnit: string, fitName?: string): ConstructionLabel {
  const words = kind === 'endurance' ? 'Max endurance V' : 'Max range V'
  const lead = fitName ? `${fitName}: ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words
  const sub = kind === 'endurance' ? 'E' : 'R'
  const value = ` = ${labelNumber(point.v)}${xUnit ? ` ${xUnit}` : ''}`
  const tail = `${value}${point.extrapolated ? ` ${EXTRAPOLATED}` : ''}`
  return {
    text: `${lead}_${sub}${tail}`,
    lead,
    sub,
    tail,
    value,
    short: fitName ? `${fitName}: V` : 'V',
    extrapolated: point.extrapolated,
  }
}

/** Legend names of the two constructions (chart legend, exported figure, MATLAB DisplayName). */
export const CONSTRUCTION_NAME: Record<Construction, string> = {
  endurance: 'Max endurance (minimum)',
  range: 'Max range (tangent from origin)',
}
