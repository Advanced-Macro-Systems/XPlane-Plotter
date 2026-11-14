import { describe, expect, it } from 'vitest'
import { ExprError, UnknownNameError, compileExpression, exprHelp, isExprConstant, type ExprContext } from './expr'
import exprSource from './expr.ts?raw'

function context(channels: Record<string, ArrayLike<number>>, time?: ArrayLike<number>): ExprContext {
  const rowCount = Object.values(channels)[0]?.length ?? time?.length ?? 1
  const table = new Map(Object.entries(channels).map(([k, v]) => [k, Float64Array.from(v)]))
  return {
    rowCount,
    time: Float64Array.from(time ?? Array.from({ length: rowCount }, (_, i) => i)),
    resolve: (name) => table.get(name.trim()),
  }
}

/** Evaluates a scalar formula (one row). */
function calc(source: string): number {
  return compileExpression(source).evaluate(context({}, [0]))[0]
}

function errorOf(fn: () => unknown): ExprError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ExprError) return error
    throw error
  }
  throw new Error('expected an ExprError')
}

describe('compileExpression — numbers, operators and precedence', () => {
  it.each([
    ['1', 1],
    ['2.5', 2.5],
    ['1e-3', 0.001],
    ['.5', 0.5],
    ['5.', 5],
    ['1E3', 1000],
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['100 / 10 / 5', 2],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['(-2) ^ 2', 4],
    ['2 ^ -1', 0.5],
    ['2 * -3', -6],
    ['- -3', 3],
    ['+4', 4],
    ['5 − 3', 2],
    ['1 + 2 < 4', 1],
    ['3 <= 2', 0],
    ['2 > 1', 1],
    ['2 >= 2', 1],
    ['3 == 3', 1],
    ['3 != 3', 0],
    ['1 < 2 == 3 > 2', 1],
    ['1 ? 10 : 20', 10],
    ['0 ? 10 : 20', 20],
    ['0 ? 1 : 0 ? 2 : 3', 3],
    ['1 > 2 ? 1 : 2 + 3', 5],
    ['(1 ? 2 : 3) * 4', 8],
  ])('%s = %d', (source, expected) => {
    expect(calc(source)).toBeCloseTo(expected, 12)
  })

  it('propagates NaN through comparisons and conditions', () => {
    const ctx = context({ a: [NaN, 1, 3] })
    expect(Array.from(compileExpression('a > 2').evaluate(ctx))).toEqual([NaN, 0, 1])
    expect(Array.from(compileExpression('a != 1').evaluate(ctx))).toEqual([NaN, 0, 1])
    expect(Array.from(compileExpression('a > 2 ? 10 : 20').evaluate(ctx))).toEqual([NaN, 20, 10])
  })

  it('turns division by zero and other non-finite results into NaN only at the end', () => {
    expect(calc('1 / 0')).toBeNaN()
    expect(calc('-1 / 0')).toBeNaN()
    expect(calc('0 / 0')).toBeNaN()
    expect(calc('1 / (1 / 0)')).toBe(0)
    expect(calc('sqrt(-1)')).toBeNaN()
    expect(calc('ln(0)')).toBeNaN()
  })
})

describe('compileExpression — references', () => {
  it('evaluates channel aliases and [raw tokens] row by row with scalar broadcasting', () => {
    const ctx = context({ Vind_kias: [100, 120, 140], '_Vind,_kias': [100, 120, 140], 'elev1,__deg#2': [1, 2, 3] })
    expect(Array.from(compileExpression('Vind_kias * 2 + 1').evaluate(ctx))).toEqual([201, 241, 281])
    expect(Array.from(compileExpression('[_Vind,_kias] - [ elev1,__deg#2 ]').evaluate(ctx))).toEqual([99, 118, 137])
  })

  it('lists references once, in order, without constants or functions', () => {
    const compiled = compileExpression('sqrt(b) + a * pi + [S-ref,ft*ft] + b + t + g0 + max(a, c)')
    expect(compiled.refs).toEqual(['b', 'a', 'S-ref,ft*ft', 'c'])
  })

  it('returns a new array and never modifies the inputs', () => {
    const values = Float64Array.of(1, Infinity, 3)
    const ctx: ExprContext = { rowCount: 3, time: Float64Array.of(0, 1, 2), resolve: () => values }
    const out = compileExpression('x').evaluate(ctx)
    expect(out).not.toBe(values)
    expect(Array.from(out)).toEqual([1, NaN, 3])
    expect(values[1]).toBe(Infinity)
  })

  it('fills scalar formulas across every row', () => {
    const out = compileExpression('2 * pi').evaluate(context({}, [0, 1, 2, 3]))
    expect(out).toHaveLength(4)
    expect(Array.from(out).every((v) => v === 2 * Math.PI)).toBe(true)
  })

  it('throws an UnknownNameError at evaluate time with the position of the first unknown name', () => {
    const compiled = compileExpression('Vind_kias + bogus * [nope]')
    const error = errorOf(() => compiled.evaluate(context({ Vind_kias: [1] })))
    expect(error).toBeInstanceOf(UnknownNameError)
    expect(error.position).toBe(12)
    expect((error as UnknownNameError).ref).toBe('bogus')
    const bracket = errorOf(() => compiled.evaluate(context({ Vind_kias: [1], bogus: [2] })))
    expect(bracket.position).toBe(20)
    expect(bracket.message).toContain('[nope]')
  })

  it('rejects a channel of the wrong length', () => {
    const ctx: ExprContext = { rowCount: 3, time: new Float64Array(3), resolve: () => new Float64Array(2) }
    expect(errorOf(() => compileExpression('1 + x').evaluate(ctx)).position).toBe(4)
  })

  it('does not treat object prototype names as constants or functions', () => {
    expect(() => compileExpression('constructor(1)')).toThrow(ExprError)
    const error = errorOf(() => compileExpression('toString + 1').evaluate(context({}, [0])))
    expect(error).toBeInstanceOf(UnknownNameError)
  })
})

describe('compileExpression — constants and functions', () => {
  it('provides the documented constants', () => {
    expect(calc('pi')).toBe(Math.PI)
    expect(calc('e')).toBe(Math.E)
    expect(calc('g0')).toBe(9.80665)
    expect(calc('rho0')).toBe(1.225)
    expect(calc('kt2ms')).toBeCloseTo(0.514444, 6)
    expect(calc('ft2m')).toBe(0.3048)
    expect(calc('lb2n')).toBeCloseTo(4.4482216, 7)
    expect(calc('lbf2n')).toBe(calc('lb2n'))
    expect(calc('hp2w')).toBeCloseTo(745.69987, 5)
    expect(calc('nm2m')).toBe(1852)
    expect(calc('fpm2ms')).toBeCloseTo(0.00508, 12)
    const out = compileExpression('t * 2').evaluate(context({}, [0, 0.5, 1.25]))
    expect(Array.from(out)).toEqual([0, 1, 2.5])
    expect(isExprConstant('g0')).toBe(true)
    expect(isExprConstant('Vind_kias')).toBe(false)
  })

  it.each([
    ['sin(pi / 2)', 1],
    ['cos(0)', 1],
    ['tan(pi / 4)', 1],
    ['asin(1)', Math.PI / 2],
    ['acos(1)', 0],
    ['atan(1)', Math.PI / 4],
    ['atan2(1, -1)', (3 * Math.PI) / 4],
    ['sqrt(16)', 4],
    ['abs(-3)', 3],
    ['exp(1)', Math.E],
    ['ln(e ^ 2)', 2],
    ['log10(1000)', 3],
    ['pow(2, 10)', 1024],
    ['min(3, -1, 2)', -1],
    ['max(3, -1, 2)', 3],
    ['floor(-2.5)', -3],
    ['ceil(-2.5)', -2],
    ['round(2.5)', 3],
    ['round(-2.5)', -3],
    ['round(-2.4)', -2],
    ['sign(-7)', -1],
    ['hypot(3, 4)', 5],
    ['hypot(1, 2, 2)', 3],
    ['deg(pi)', 180],
    ['rad(90)', Math.PI / 2],
    ['clamp(5, 0, 3)', 3],
    ['clamp(-5, 0, 3)', 0],
    ['clamp(2, 0, 3)', 2],
  ])('%s = %d', (source, expected) => {
    expect(calc(source)).toBeCloseTo(expected, 12)
  })

  it('applies functions element-wise over channels', () => {
    const ctx = context({ a: [1, 4, 9], b: [3, 2, 1] })
    expect(Array.from(compileExpression('sqrt(a) + max(a, b, 2)').evaluate(ctx))).toEqual([4, 6, 12])
    expect(Array.from(compileExpression('clamp(a, b, 5)').evaluate(ctx))).toEqual([3, 4, 5])
  })

  it('diff: central differences per second, one-sided at the ends and next to gaps, NaN for zero dt', () => {
    const time = [0, 0.1, 0.2, 0.4, 0.5, 0.5, 0.6]
    const x = time.map((v) => 3 * v + 1)
    const out = compileExpression('diff(x)').evaluate(context({ x }, time))
    // A straight line has the same slope everywhere, whatever the spacing.
    for (const i of [0, 1, 2, 3, 6]) expect(out[i]).toBeCloseTo(3, 10)
    // Rows 4 and 5 share a time stamp: the central difference there spans 0.1 s, still fine...
    expect(out[4]).toBeCloseTo(3, 10)
    // ...and a stencil with no time step gives NaN.
    const flat = compileExpression('diff(x)').evaluate(context({ x: [1, 2, 3] }, [0, 0, 0]))
    expect(Array.from(flat).every(Number.isNaN)).toBe(true)
    const gappy = compileExpression('diff(x)').evaluate(context({ x: [0, 1, NaN, 3, 4] }, [0, 1, 2, 3, 4]))
    expect(Array.from(gappy)).toEqual([1, 1, NaN, 1, 1])
    // Central difference of t² at t = 1 with h = 1 is exact for a parabola: 2.
    const parabola = compileExpression('diff(t ^ 2)').evaluate(context({}, [0, 1, 2]))
    expect(parabola[1]).toBe(2)
  })

  it('integ: cumulative trapezoid in seconds, bridging gaps', () => {
    const time = [0, 1, 2, 4, 5]
    const constant = compileExpression('integ(2)').evaluate(context({}, time))
    expect(Array.from(constant)).toEqual([0, 2, 4, 8, 10])
    const ramp = compileExpression('integ(t)').evaluate(context({}, time))
    for (let i = 0; i < time.length; i += 1) expect(ramp[i]).toBeCloseTo(time[i] ** 2 / 2, 12)
    const gap = compileExpression('integ(x)').evaluate(context({ x: [NaN, 1, NaN, 3, 3] }, time))
    // First finite sample starts at 0; the gap 1 → 4 s is bridged by the trapezoid (1 + 3)/2 × 3 = 6.
    expect(Array.from(gap)).toEqual([NaN, 0, NaN, 6, 9])
    // Fuel used: 3600 lb/h for one hour is 3600 lb.
    const fuel = compileExpression('integ(ff) / 3600').evaluate(context({ ff: [3600, 3600] }, [0, 3600]))
    expect(fuel[1]).toBe(3600)
  })

  it('smooth: centred moving average over a time window', () => {
    const time = Array.from({ length: 50 }, (_, i) => i * 0.1)
    const x = time.map((v, i) => Math.sin(v * 3) + (i % 3) * 0.1 + 1000)
    const out = compileExpression('smooth(x, 0.5)').evaluate(context({ x }, time))
    for (let i = 0; i < x.length; i += 1) {
      let sum = 0
      let count = 0
      for (let j = 0; j < x.length; j += 1) {
        if (Math.abs(time[j] - time[i]) <= 0.25 + 1e-9) {
          sum += x[j]
          count += 1
        }
      }
      expect(out[i]).toBeCloseTo(sum / count, 9)
    }
    // ±1 s windows: row 0 sees {1, NaN}, row 2 sees {NaN, 3, 5}, row 3 sees {3, 5}; the NaN row stays NaN.
    const nan = compileExpression('smooth(x, 2)').evaluate(context({ x: [1, NaN, 3, 5] }, [0, 1, 2, 3]))
    expect(Array.from(nan)).toEqual([1, NaN, 4, 4])
    const none = compileExpression('smooth(x, 0)').evaluate(context({ x: [1, 2, 4] }, [0, 1, 2]))
    expect(Array.from(none)).toEqual([1, 2, 4])
  })

  it('lag: shifts by whole rows with NaN fill', () => {
    const ctx = context({ x: [1, 2, 3, 4] })
    expect(Array.from(compileExpression('lag(x, 1)').evaluate(ctx))).toEqual([NaN, 1, 2, 3])
    expect(Array.from(compileExpression('lag(x, -2)').evaluate(ctx))).toEqual([3, 4, NaN, NaN])
    expect(Array.from(compileExpression('lag(x, 0)').evaluate(ctx))).toEqual([1, 2, 3, 4])
    expect(Array.from(compileExpression('lag(x, 9)').evaluate(ctx)).every(Number.isNaN)).toBe(true)
    expect(Array.from(compileExpression('x - lag(x, 1)').evaluate(ctx))).toEqual([NaN, 1, 1, 1])
  })

  it('requires constant window and shift arguments', () => {
    const ctx = context({ x: [1, 2, 3] })
    expect(errorOf(() => compileExpression('smooth(x, x)').evaluate(ctx)).position).toBe(10)
    expect(errorOf(() => compileExpression('smooth(x, -1)').evaluate(ctx)).message).toMatch(/negative/)
    expect(errorOf(() => compileExpression('lag(x, x)').evaluate(ctx)).position).toBe(7)
    expect(errorOf(() => compileExpression('lag(x, 0/0)').evaluate(ctx)).message).toMatch(/constant/)
  })
})

describe('compileExpression — syntax errors with positions', () => {
  it.each([
    ['', 0, /empty/],
    ['   ', 3, /empty|ends/],
    ['1 +', 3, /ends unexpectedly/],
    ['(1 + 2', 6, /Missing "\)"/],
    ['1 2', 2, /operator/],
    ['a b', 2, /operator/],
    ['1 + * 2', 4, /Unexpected/],
    ['a = b', 2, /==/],
    ['a && b', 2, /not supported/],
    ['!a', 0, /!=/],
    ['[abc', 0, /Missing "\]"/],
    ['[ ]', 0, /Empty/],
    ['1 ? 2', 5, /":"/],
    ['1 )', 2, /Unexpected/],
    ['min(1)', 0, /at least 2/],
    ['atan2(1)', 0, /2 arguments/],
    ['sin(1, 2)', 0, /1 argument/],
    ['sin(1', 5, /Missing "\)"/],
    ['2 + foo(3)', 4, /Unknown function "foo"/],
    ['log(2)', 0, /ln.*log10/],
    ['Sin(1)', 0, /did you mean sin/],
    ['pi(2)', 0, /constant/],
    ['3 # 4', 2, /Unexpected character/],
    ['α + 1', 0, /Unexpected character/],
  ])('%j fails at %d', (source, position, message) => {
    const error = errorOf(() => compileExpression(source))
    expect(error.position).toBe(position)
    expect(error.message).toMatch(message)
  })

  it('limits nesting depth and length instead of overflowing the stack', () => {
    const deep = '('.repeat(150) + '1' + ')'.repeat(150)
    expect(calc(deep)).toBe(1)
    expect(() => compileExpression('('.repeat(500) + '1' + ')'.repeat(500))).toThrow(/nested too deeply/)
    expect(() => compileExpression('-'.repeat(500) + '1')).toThrow(/nested too deeply/)
    expect(() => compileExpression('('.repeat(5000) + '1' + ')'.repeat(5000))).toThrow(ExprError)
    const long = Array.from({ length: 1500 }, () => '1').join(' + ')
    expect(calc(long)).toBe(1500)
    expect(() => compileExpression(Array.from({ length: 3000 }, () => '1').join(' + '))).toThrow(/too long/)
  })
})

describe('exprHelp', () => {
  it('documents every function and constant of the language', () => {
    const help = exprHelp()
    const functions = help.functions.map((f) => f.name)
    for (const name of 'sin cos tan asin acos atan atan2 sqrt abs exp ln log10 pow min max floor ceil round sign hypot deg rad clamp diff integ smooth lag'.split(' ')) {
      expect(functions).toContain(name)
    }
    expect(help.constants.map((c) => c.name)).toEqual([
      'pi',
      'e',
      'g0',
      'rho0',
      'kt2ms',
      'ft2m',
      'lb2n',
      'lbf2n',
      'hp2w',
      'nm2m',
      'fpm2ms',
      't',
    ])
    for (const entry of [...help.functions, ...help.constants]) {
      expect(entry.description.length).toBeGreaterThan(5)
      expect(entry.signature.startsWith(entry.name)).toBe(true)
    }
    expect(help.functions.find((f) => f.name === 'smooth')?.signature).toBe('smooth(x, seconds)')
    // Every documented function compiles with its documented arity.
    for (const f of help.functions) {
      const args = f.signature.includes('...') ? 'a, b' : f.signature.slice(f.name.length)
      expect(() => compileExpression(f.signature.includes('...') ? `${f.name}(${args})` : `${f.name}${args}`)).not.toThrow()
    }
  })
})

describe('safety', () => {
  it('never uses eval or the Function constructor', () => {
    expect(exprSource).toContain('compileExpression')
    expect(exprSource).not.toMatch(/\beval\s*\(|new\s+Function\b/)
  })
})
