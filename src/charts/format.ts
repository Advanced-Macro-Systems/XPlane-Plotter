// Number formatting for axes, tooltips and tables, and safe HTML for tooltips (channel names come from file headers:
// untrusted — always escape them).
// OWNER: charts agent. Public API below is a contract; keep these signatures.

/** U+2212, the typographic minus: as wide as "+" and the digits, so signed values line up. Used in display strings. */
export const MINUS = '−'

/** Shown for a missing value (NaN). */
export const MISSING = '—'

/** formatNumber switches to exponent form at or beyond these powers of ten. */
const HUGE_EXPONENT = 9
const TINY_EXPONENT = -4

/** Muted ink for secondary tooltip text. Tooltips are HTML in the page, so they can follow the live theme token. */
const MUTED_INK = 'var(--text-muted, #44546f)'

/** Engineering-friendly: 4 significant figures by default, thousands without exponent, tiny/huge as 1.23e-5. '—' for NaN. */
export function formatNumber(value: number, significant = 4): string {
  if (Number.isNaN(value)) return MISSING
  if (!Number.isFinite(value)) return infinity(value)
  if (value === 0) return '0' // also -0
  const digits = clampInt(significant, 1, 17, 4)
  // toExponential rounds to `digits` significant figures first, so 9999.7 reports exponent 4 (it shows as 10000).
  const [mantissa, exponentText] = value.toExponential(digits - 1).split('e')
  const exponent = Number(exponentText)
  if (exponent >= HUGE_EXPONENT || exponent < TINY_EXPONENT) {
    return displayMinus(`${stripZeros(mantissa)}e${exponent}`)
  }
  // From 10^(digits-1) up, every significant figure is left of the point: round to a whole number rather than replace
  // digits with zeros (123456.7 -> "123457", not "123500").
  const decimals = Math.max(0, digits - 1 - exponent)
  return displayMinus(noNegativeZero(stripZeros(value.toFixed(decimals))))
}

/** Fixed decimals for table columns ('—' for NaN) */
export function formatFixed(value: number, decimals: number): string {
  if (Number.isNaN(value)) return MISSING
  if (!Number.isFinite(value)) return infinity(value)
  return displayMinus(noNegativeZero(value.toFixed(clampInt(decimals, 0, 20, 0))))
}

/**
 * Short axis tick labels: plain digits with no thousands separators and no floating-point noise
 * (0.30000000000000004 -> "0.3"), true minus signs, millions and up as "1.5M" / "250G" when that stays exact and short,
 * and exponents only at extreme magnitudes ("2.5e−7"). '' for non-finite values.
 *
 * Thousands stay in full ("12000", not "12k"): ECharts formats one tick at a time without the axis span, and a per-value
 * "k" would mix styles on the many axes that cross 10 000 ("0, 5000, 10k, 15k" for thrust, altitude, weights).
 */
export function axisLabel(value: number): string {
  if (!Number.isFinite(value)) return ''
  // 12 significant figures is far more than any tick shows, and drops the binary noise of tick arithmetic.
  const clean = Number(value.toPrecision(12))
  if (clean === 0) return '0'
  const magnitude = Math.abs(clean)
  if (magnitude >= 1e15 || magnitude < 1e-6) return exponential(clean)
  if (magnitude >= 1e6) {
    const giga = magnitude >= 1e9
    const size = giga ? 1e9 : 1e6
    const suffix = giga ? 'G' : 'M'
    const scaled = Number((clean / size).toPrecision(12))
    // Only when exact and short: "1.25M" yes, "1.000002M" no (stays "1000002").
    if (significantFigures(scaled) <= 4) return displayMinus(`${scaled}${suffix}`)
  }
  return displayMinus(String(clean))
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

/**
 * One tooltip row: a short stroke of `color` (line key), the value in strong ink, then the escaped label.
 * `label` and `value` are plain text (both escaped here); `color` must be a CSS colour (anything else draws the key in
 * the text colour). Stack rows inside the tooltip that baseOption styles; tooltipHeader makes the first line.
 */
export function tooltipRow(color: string, label: string, value: string): string {
  return (
    '<div style="display:flex;align-items:center;gap:8px;line-height:20px;white-space:nowrap">' +
    `<span style="flex:none;width:14px;height:3px;border-radius:2px;background:${cssColor(color)}"></span>` +
    '<span style="min-width:4em;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">' +
    `${escapeHtml(value)}</span>` +
    `<span style="min-width:0;max-width:280px;overflow:hidden;text-overflow:ellipsis;color:${MUTED_INK}">` +
    `${escapeHtml(label)}</span>` +
    '</div>'
  )
}

/** A muted first tooltip line (e.g. the hovered time), escaped. */
export function tooltipHeader(text: string): string {
  return (
    `<div style="margin-bottom:4px;color:${MUTED_INK};font-variant-numeric:tabular-nums;white-space:nowrap">` +
    `${escapeHtml(text)}</div>`
  )
}

// ---------------------------------------------------------------------------------------------------------- helpers

function displayMinus(text: string): string {
  return text.replace(/-/g, MINUS)
}

function infinity(value: number): string {
  return value > 0 ? '∞' : `${MINUS}∞`
}

/** "1.2300" -> "1.23", "100.0" -> "100"; integers are left alone. */
function stripZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** Rounding a small negative number can print "-0" or "-0.00": that is just zero. */
function noNegativeZero(text: string): string {
  return /^-0(?:\.0*)?$/.test(text) ? text.slice(1) : text
}

function exponential(value: number): string {
  const [mantissa, exponent] = value.toExponential().split('e')
  return displayMinus(`${mantissa}e${Number(exponent)}`)
}

/** Significant figures of `value` written as a plain decimal ("1.25" -> 3, "250" -> 2). */
function significantFigures(value: number): number {
  return String(Math.abs(value)).replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Lets only colour-like text into a style attribute: no quotes, semicolons, colons or angle brackets. */
function cssColor(color: string): string {
  const trimmed = String(color).trim()
  return trimmed && /^[#\w\s(),.%+\-/]+$/.test(trimmed) ? trimmed : 'currentColor'
}
