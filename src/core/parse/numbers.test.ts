import { describe, expect, it } from 'vitest'
import {
  CELL_EMPTY,
  CELL_MISSING,
  CELL_NUMBER,
  CELL_TEXT,
  NumberScanner,
  parseCell,
  parseNumber,
  type CellResult,
} from './numbers'

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const scanner = new NumberScanner()

/** The fast path on a whole string: the value, or null when it declines (or does not consume everything). */
function fast(text: string, decimalComma = false): number | null {
  const value = scanner.scan(text, 0, text.length, decimalComma)
  return Number.isNaN(value) || scanner.end !== text.length ? null : value
}

describe('NumberScanner (fast path)', () => {
  it('returns exactly what Number() returns for X-Plane style values', () => {
    const next = random(1)
    for (let i = 0; i < 50_000; i += 1) {
      const magnitude = 10 ** Math.floor(next() * 10 - 3)
      const text = ((next() - 0.5) * magnitude).toFixed(5)
      const value = fast(text)
      if (!Object.is(value, Number(text))) throw new Error(`${text}: fast ${value} vs Number ${Number(text)}`)
    }
  })

  it('returns exactly what Number() returns for exponents, signs and integers', () => {
    const next = random(2)
    for (let i = 0; i < 50_000; i += 1) {
      const digits = 1 + Math.floor(next() * 15)
      let mantissa = String(Math.floor(next() * 10 ** digits))
      if (next() < 0.5 && mantissa.length > 1) {
        const dot = 1 + Math.floor(next() * (mantissa.length - 1))
        mantissa = `${mantissa.slice(0, dot)}.${mantissa.slice(dot)}`
      }
      const sign = next() < 0.3 ? '-' : next() < 0.1 ? '+' : ''
      const exponent = next() < 0.5 ? `${next() < 0.5 ? 'e' : 'E'}${next() < 0.5 ? '-' : ''}${Math.floor(next() * 12)}` : ''
      const text = sign + mantissa + exponent
      const value = fast(text)
      if (value !== null && !Object.is(value, Number(text))) {
        throw new Error(`${text}: fast ${value} vs Number ${Number(text)}`)
      }
    }
  })

  it('handles the edge forms', () => {
    expect(fast('0')).toBe(0)
    expect(Object.is(fast('-0.00000'), -0)).toBe(true)
    expect(fast('+1')).toBe(1)
    expect(fast('.5')).toBe(0.5)
    expect(fast('5.')).toBe(5)
    expect(fast('1e22')).toBe(1e22)
    expect(fast('1e-22')).toBe(1e-22)
    expect(fast('123456789012345')).toBe(123456789012345)
    expect(fast('-143.75827')).toBe(-143.75827)
    expect(fast('1,25', true)).toBe(1.25)
  })

  it('declines what it cannot do exactly, so the caller falls back to Number()', () => {
    expect(fast('1234567890123456')).toBeNull() // 16 digits
    expect(fast('1e23')).toBeNull()
    expect(fast('1e-23')).toBeNull()
    expect(fast('1e')).toBeNull()
    expect(fast('-')).toBeNull()
    expect(fast('.')).toBeNull()
    expect(fast('nan')).toBeNull()
    expect(fast('1,25')).toBeNull() // "," only with decimalComma
  })

  it('stops at the end of the number and never reads past the limit', () => {
    expect(scanner.scan('  12.5 | 3', 2, 10, false)).toBe(12.5)
    expect(scanner.end).toBe(6)
    expect(scanner.scan('12345', 0, 3, false)).toBe(123)
    expect(scanner.end).toBe(3)
  })
})

describe('parseCell / parseNumber', () => {
  const out: CellResult = { value: NaN, kind: CELL_EMPTY }
  const kind = (text: string, decimalComma = false) => {
    parseCell(text, decimalComma, out)
    return out.kind
  }

  it('classifies cells', () => {
    expect(kind('')).toBe(CELL_EMPTY)
    expect(kind('12.5')).toBe(CELL_NUMBER)
    expect(kind('1,5', true)).toBe(CELL_NUMBER)
    for (const text of ['nan', 'NaN', '-nan', '-nan(ind)', 'nan(snan)', 'inf', '-inf', 'Infinity', '1.#INF', '-1.#IND', '1.#QNAN0', '1e999']) {
      expect(kind(text), text).toBe(CELL_MISSING)
    }
    for (const text of ['abc', '_Vind,_kias', '12:30:00', '2026-01-13', '1.2.3', '1,5']) {
      expect(kind(text), text).toBe(CELL_TEXT)
    }
  })

  it('turns everything that is not a finite number into NaN', () => {
    expect(parseNumber(' 12.5 ')).toBe(12.5)
    expect(parseNumber('-3e2')).toBe(-300)
    expect(parseNumber('1234567890123456')).toBe(1234567890123456) // 16 digits: the Number() path
    expect(parseNumber('1,5', true)).toBe(1.5)
    for (const text of ['', '  ', 'nan', 'inf', '-Infinity', '1e999', 'abc', '1,5']) {
      expect(parseNumber(text), JSON.stringify(text)).toBeNaN()
    }
  })
})
