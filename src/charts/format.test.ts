import { describe, expect, it } from 'vitest'
import {
  MINUS,
  MISSING,
  axisLabel,
  escapeHtml,
  formatFixed,
  formatNumber,
  tooltipHeader,
  tooltipRow,
} from './format'

describe('formatNumber', () => {
  it('shows missing and infinite values', () => {
    expect(formatNumber(Number.NaN)).toBe(MISSING)
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('∞')
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe(`${MINUS}∞`)
  })

  it('never shows a negative zero', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(-0)).toBe('0')
  })

  it('rounds to 4 significant figures and drops trailing zeros', () => {
    expect(formatNumber(123.456)).toBe('123.5')
    expect(formatNumber(3.14159)).toBe('3.142')
    expect(formatNumber(0.0123456)).toBe('0.01235')
    expect(formatNumber(2.5)).toBe('2.5')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(0.0001)).toBe('0.0001')
  })

  it('keeps every integer digit of large values, without separators or exponent', () => {
    expect(formatNumber(1234.5678)).toBe('1235')
    expect(formatNumber(174213.6)).toBe('174214')
    expect(formatNumber(500700000)).toBe('500700000')
  })

  it('carries rounding into the next power of ten', () => {
    expect(formatNumber(9999.7)).toBe('10000')
    expect(formatNumber(99.996)).toBe('100')
  })

  it('uses exponents for tiny and huge magnitudes', () => {
    expect(formatNumber(1.5e-5)).toBe(`1.5e${MINUS}5`)
    expect(formatNumber(-2.5e-7)).toBe(`${MINUS}2.5e${MINUS}7`)
    expect(formatNumber(1.23456e9)).toBe('1.235e9')
    expect(formatNumber(4e12)).toBe('4e12')
  })

  it('uses the typographic minus sign', () => {
    expect(formatNumber(-1234.5)).toBe(`${MINUS}1235`)
    expect(formatNumber(-0.5)).toBe(`${MINUS}0.5`)
    expect(formatNumber(-42)).not.toContain('-')
  })

  it('honours the significant-figure count and clamps nonsense', () => {
    expect(formatNumber(3.14159, 6)).toBe('3.14159')
    expect(formatNumber(12.34, 2)).toBe('12')
    expect(formatNumber(1.23456, 0)).toBe('1')
    expect(formatNumber(2, Number.NaN)).toBe('2')
  })
})

describe('formatFixed', () => {
  it('shows a fixed number of decimals', () => {
    expect(formatFixed(3.14159, 2)).toBe('3.14')
    expect(formatFixed(2, 3)).toBe('2.000')
    expect(formatFixed(1234.25, 1)).toBe('1234.3')
  })

  it('avoids "-0" and uses the typographic minus', () => {
    expect(formatFixed(-0.001, 2)).toBe('0.00')
    expect(formatFixed(-0.4, 0)).toBe('0')
    expect(formatFixed(-0, 1)).toBe('0.0')
    expect(formatFixed(-2.5, 1)).toBe(`${MINUS}2.5`)
  })

  it('shows missing and infinite values, and clamps the decimals', () => {
    expect(formatFixed(Number.NaN, 2)).toBe(MISSING)
    expect(formatFixed(Number.NEGATIVE_INFINITY, 2)).toBe(`${MINUS}∞`)
    expect(formatFixed(5, -1)).toBe('5')
    expect(formatFixed(1 / 3, 50)).toBe((1 / 3).toFixed(20))
  })
})

describe('axisLabel', () => {
  it('removes floating-point noise', () => {
    expect(axisLabel(0.30000000000000004)).toBe('0.3')
    expect(axisLabel(0.1 * 3)).toBe('0.3')
    expect(axisLabel(2.9999999999999996)).toBe('3')
    expect(axisLabel(0.7999999999999999)).toBe('0.8')
  })

  it('writes thousands in full, without separators', () => {
    expect(axisLabel(5000)).toBe('5000')
    expect(axisLabel(12000)).toBe('12000')
    expect(axisLabel(154320)).toBe('154320')
    expect(axisLabel(-20000)).toBe(`${MINUS}20000`)
  })

  it('shortens millions and up only when exact and short', () => {
    expect(axisLabel(1500000)).toBe('1.5M')
    expect(axisLabel(2e6)).toBe('2M')
    expect(axisLabel(-1.25e6)).toBe(`${MINUS}1.25M`)
    expect(axisLabel(5e8)).toBe('500M')
    expect(axisLabel(2.5e9)).toBe('2.5G')
    expect(axisLabel(1234567)).toBe('1234567')
    expect(axisLabel(1000002)).toBe('1000002')
  })

  it('keeps small decimals plain and uses exponents only at the extremes', () => {
    expect(axisLabel(0.00025)).toBe('0.00025')
    expect(axisLabel(0.000001)).toBe('0.000001')
    expect(axisLabel(2.5e-7)).toBe(`2.5e${MINUS}7`)
    expect(axisLabel(1e15)).toBe('1e15')
    expect(axisLabel(-1.5e20)).toBe(`${MINUS}1.5e20`)
  })

  it('handles zero, signs and non-finite values', () => {
    expect(axisLabel(0)).toBe('0')
    expect(axisLabel(-0)).toBe('0')
    expect(axisLabel(-15)).toBe(`${MINUS}15`)
    expect(axisLabel(123.456)).toBe('123.456')
    expect(axisLabel(Number.NaN)).toBe('')
    expect(axisLabel(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    )
  })

  it('leaves ordinary header text alone, and escapes entities again (it is text)', () => {
    expect(escapeHtml('_Vind,_kias')).toBe('_Vind,_kias')
    expect(escapeHtml('wing1,_lift #2')).toBe('wing1,_lift #2')
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })
})

describe('tooltipRow', () => {
  it('puts a line key, then the value, then the escaped label', () => {
    const html = tooltipRow('#2a78d6', '<b>KIAS</b>', '123.4 kt')
    expect(html).toContain('background:#2a78d6')
    expect(html).toContain('width:14px;height:3px')
    expect(html).toContain('&lt;b&gt;KIAS&lt;/b&gt;')
    expect(html).not.toContain('<b>')
    expect(html.indexOf('123.4 kt')).toBeGreaterThan(html.indexOf('background:#2a78d6'))
    expect(html.indexOf('123.4 kt')).toBeLessThan(html.indexOf('KIAS'))
    expect(html).toContain('font-weight:600')
  })

  it('escapes the value too', () => {
    expect(tooltipRow('#000', 'a', '<x>')).toContain('&lt;x&gt;')
  })

  it('accepts CSS colour syntax and refuses anything that could break out of the style attribute', () => {
    expect(tooltipRow('rgba(12, 102, 228, 0.55)', 'a', '1')).toContain('background:rgba(12, 102, 228, 0.55)')
    expect(tooltipRow('var(--series-1)', 'a', '1')).toContain('background:var(--series-1)')
    for (const hostile of ['red;background-image:url(x)', '"><script>alert(1)</script>', 'url(javascript:x)', '']) {
      const html = tooltipRow(hostile, 'a', '1')
      expect(html).toContain('background:currentColor')
      expect(html).not.toContain('script')
      expect(html).not.toContain('url(')
    }
  })
})

describe('tooltipHeader', () => {
  it('escapes its text', () => {
    const html = tooltipHeader('t = 1.5 s <i>')
    expect(html).toContain('t = 1.5 s &lt;i&gt;')
    expect(html.startsWith('<div')).toBe(true)
  })
})
