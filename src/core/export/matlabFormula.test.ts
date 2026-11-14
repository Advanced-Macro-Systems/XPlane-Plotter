import { describe, expect, it } from 'vitest'
import { formulaToMatlab } from './matlabFormula'

const COLUMNS: Record<string, string> = {
  Vind_kias: 'V',
  '_Vind,_kias': 'V',
  'elev1,__deg#2': 'E2',
  alpha_deg: 'A',
  t: 'T_CHANNEL',
}
const translate = (source: string) => formulaToMatlab(source, (name) => COLUMNS[name] ?? null)
const code = (source: string) => translate(source).code

describe('formulaToMatlab', () => {
  it('writes element-wise, fully parenthesised MATLAB', () => {
    expect(code('Vind_kias * 2 + alpha_deg / 3')).toBe('((V .* 2) + (A ./ 3))')
    expect(code('(Vind_kias - 1) * (alpha_deg + 1)')).toBe('(((V - 1)) .* ((A + 1)))')
    expect(code('1.5e-3 * Vind_kias')).toBe('(1.5e-3 .* V)')
  })

  it('follows the app precedence: unary minus below ^, ^ right-associative', () => {
    expect(code('-2^2')).toBe('(-xppReal(2 .^ 2))')
    expect(code('2^-1')).toBe('xppReal(2 .^ (-1))')
    expect(code('2^3^2')).toBe('xppReal(2 .^ xppReal(3 .^ 2))')
    expect(code('-Vind_kias * 2')).toBe('((-V) .* 2)')
    expect(code('Vind_kias − 1')).toBe('(V - 1)')
  })

  it('maps comparisons and ?: to NaN-aware helpers', () => {
    const result = translate('Vind_kias > 200 == 1 ? alpha_deg : -1')
    expect(result.code).toBe("xppIf(xppCmp(xppCmp(V, 200, '>'), 1, '=='), A, (-1))")
    expect(result.helpers.sort()).toEqual(['xppCmp', 'xppIf'])
    expect(code('Vind_kias != 0')).toBe("xppCmp(V, 0, '~=')")
    expect(code('a_ ? 1 : 2 ? 3 : 4'.replace('a_', 'alpha_deg'))).toBe('xppIf(A, 1, xppIf(2, 3, 4))')
  })

  it('translates constants and gives them precedence over channels; [name] always means a channel', () => {
    expect(code('t')).toBe('el')
    expect(code('[t]')).toBe('T_CHANNEL')
    expect(code('kt2ms * pi')).toBe('((1852 / 3600) .* pi)')
    expect(code('g0 + rho0 + e')).toBe('((9.80665 + 1.225) + 2.718281828459045)')
    expect(code('[_Vind,_kias] + [elev1,__deg#2]')).toBe('(V + E2)')
  })

  it('translates the functions, keeping results real and NaN-propagating', () => {
    expect(code('sqrt(Vind_kias)')).toBe('xppReal(sqrt(V))')
    expect(code('ln(Vind_kias) + log10(2)')).toBe('(xppReal(log(V)) + xppReal(log10(2)))')
    expect(code('max(Vind_kias, 1, alpha_deg)')).toBe("max(max(V, 1, 'includenan'), A, 'includenan')")
    expect(code('clamp(alpha_deg, 0, 10)')).toBe("min(max(A, 0, 'includenan'), 10, 'includenan')")
    expect(code('round(deg(rad(alpha_deg)))')).toBe('round(((A * pi / 180) * 180 / pi))')
    expect(code('hypot(1, 2, 3)')).toBe('hypot(hypot(1, 2), 3)')
    expect(code('pow(Vind_kias, 2)')).toBe('xppReal(V .^ 2)')
  })

  it('maps the time-aware functions to local helpers using the elapsed time', () => {
    const result = translate('diff(Vind_kias) + integ(alpha_deg) + smooth(Vind_kias, 2) + lag(alpha_deg, 3)')
    expect(result.code).toBe('(((xppDdt(V, el) + xppInteg(A, el)) + xppSmooth(V, el, 2)) + xppLag(A, 3, nRows))')
    expect(result.helpers.sort()).toEqual(['xppDdt', 'xppInteg', 'xppLag', 'xppSmooth'])
    expect(result.refs).toEqual(['Vind_kias', 'alpha_deg', 'Vind_kias', 'alpha_deg'])
  })

  it('throws a short reason for anything it cannot translate', () => {
    expect(() => translate('nope_channel * 2')).toThrow('unknown channel "nope_channel"')
    expect(() => translate('log(Vind_kias)')).toThrow('unknown function "log"')
    expect(() => translate('sqrt(1, 2)')).toThrow('wrong number of arguments for sqrt()')
    expect(() => translate('Vind_kias +')).toThrow('the formula ends too early')
    expect(() => translate('(Vind_kias')).toThrow('expected ")"')
    expect(() => translate('Vind_kias = 2')).toThrow('unexpected "="')
    expect(() => translate('[Vind_kias')).toThrow('unclosed "["')
    expect(() => translate('Vind_kias 2')).toThrow('unexpected "2"')
    expect(() => translate('   ')).toThrow('the formula is empty')
    expect(() => translate('[]')).toThrow('unknown channel ""')
  })
})
