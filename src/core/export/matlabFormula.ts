// Translates a derived-channel formula (the app's formula language, core/analysis/expr.ts) into a MATLAB expression,
// so an exported script re-computes formula channels from the log instead of dropping them.
// OWNER: export agent.
//
// Same grammar and semantics as expr.ts: precedence (loosest first) ?: · == != · < <= > >= · + − · * / · unary − · ^
// (right-assoc); comparisons give 1/0, or NaN when either side is NaN; a NaN condition makes ?: NaN; constants win
// over channel aliases and [name] always means a channel. Real-valued like JavaScript's Math: sqrt(−1), ln(−1),
// asin(2) and (−8)^(1/3) are NaN, never complex (xppReal). The output is fully parenthesised and element-wise over
// column vectors; `t` is the script's elapsed-time vector `el`. Helpers used are listed in `helpers` (local MATLAB
// functions the script must define: xppReal, xppCmp, xppIf, xppDdt, xppInteg, xppSmooth, xppLag).

export interface MatlabFormula {
  /** MATLAB expression (a column vector or a scalar) */
  code: string
  /** Names of the local MATLAB functions the expression calls */
  helpers: string[]
  /** Channel names the formula references, as written (identifiers and [tokens]) */
  refs: string[]
}

/** The formula constants, spelled so MATLAB computes the same doubles as expr.ts. */
const CONSTANTS: Record<string, string> = {
  pi: 'pi',
  e: '2.718281828459045',
  g0: '9.80665',
  rho0: '1.225',
  kt2ms: '(1852 / 3600)',
  ft2m: '0.3048',
  lb2n: '(0.45359237 * 9.80665)',
  lbf2n: '(0.45359237 * 9.80665)',
  hp2w: '(550 * 0.3048 * (0.45359237 * 9.80665))',
  nm2m: '1852',
  fpm2ms: '(0.3048 / 60)',
  t: 'el',
}

interface FunctionSpec {
  min: number
  max: number
  emit: (args: string[]) => string
  helpers?: string[]
}

const call = (name: string): FunctionSpec => ({ min: 1, max: 1, emit: (a) => `${name}(${a[0]})` })
/** MATLAB returns complex numbers where JavaScript's Math returns NaN: xppReal turns them into NaN. */
const realCall = (name: string): FunctionSpec => ({
  min: 1,
  max: 1,
  emit: (a) => `xppReal(${name}(${a[0]}))`,
  helpers: ['xppReal'],
})
/** Math.min/max propagate NaN; MATLAB's min/max skip it unless told otherwise. */
const extremum = (name: 'min' | 'max'): FunctionSpec => ({
  min: 2,
  max: Infinity,
  emit: (a) => a.reduce((acc, b) => `${name}(${acc}, ${b}, 'includenan')`),
})

const FUNCTIONS: Record<string, FunctionSpec> = {
  sin: call('sin'),
  cos: call('cos'),
  tan: call('tan'),
  asin: realCall('asin'),
  acos: realCall('acos'),
  atan: call('atan'),
  atan2: { min: 2, max: 2, emit: (a) => `atan2(${a[0]}, ${a[1]})` },
  sqrt: realCall('sqrt'),
  abs: call('abs'),
  exp: call('exp'),
  ln: realCall('log'),
  log10: realCall('log10'),
  pow: { min: 2, max: 2, emit: (a) => `xppReal(${a[0]} .^ ${a[1]})`, helpers: ['xppReal'] },
  min: extremum('min'),
  max: extremum('max'),
  floor: call('floor'),
  ceil: call('ceil'),
  // expr.ts rounds halves away from zero, like MATLAB's round.
  round: call('round'),
  sign: call('sign'),
  hypot: { min: 2, max: Infinity, emit: (a) => a.reduce((acc, b) => `hypot(${acc}, ${b})`) },
  deg: { min: 1, max: 1, emit: (a) => `(${a[0]} * 180 / pi)` },
  rad: { min: 1, max: 1, emit: (a) => `(${a[0]} * pi / 180)` },
  clamp: { min: 3, max: 3, emit: (a) => `min(max(${a[0]}, ${a[1]}, 'includenan'), ${a[2]}, 'includenan')` },
  diff: { min: 1, max: 1, emit: (a) => `xppDdt(${a[0]}, el)`, helpers: ['xppDdt'] },
  integ: { min: 1, max: 1, emit: (a) => `xppInteg(${a[0]}, el)`, helpers: ['xppInteg'] },
  smooth: { min: 2, max: 2, emit: (a) => `xppSmooth(${a[0]}, el, ${a[1]})`, helpers: ['xppSmooth'] },
  lag: { min: 2, max: 2, emit: (a) => `xppLag(${a[0]}, ${a[1]}, nRows)`, helpers: ['xppLag'] },
}

const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!='])

type Token =
  | { kind: 'num'; text: string; pos: number }
  | { kind: 'id'; text: string; pos: number }
  | { kind: 'ref'; text: string; pos: number }
  | { kind: 'op'; text: string; pos: number }
  | { kind: 'end'; text: ''; pos: number }

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/
const TWO_CHAR_OPS = ['<=', '>=', '==', '!=']
const ONE_CHAR_OPS = '+-*/^(),?:<>'

/** The app's tokenizer (expr.ts), including "−" (U+2212) as minus. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    const rest = source.slice(i)
    const num = /[0-9.]/.test(ch) ? NUMBER.exec(rest) : null
    if (num) {
      tokens.push({ kind: 'num', text: num[0], pos: i })
      i += num[0].length
      continue
    }
    const id = IDENT.exec(rest)
    if (id) {
      tokens.push({ kind: 'id', text: id[0], pos: i })
      i += id[0].length
      continue
    }
    if (ch === '[') {
      const close = source.indexOf(']', i + 1)
      if (close < 0) throw new Error(`unclosed "[" at character ${i + 1}`)
      tokens.push({ kind: 'ref', text: source.slice(i + 1, close).trim(), pos: i })
      i = close + 1
      continue
    }
    const two = source.slice(i, i + 2)
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ kind: 'op', text: two, pos: i })
      i += 2
      continue
    }
    const op = ch.charCodeAt(0) === 0x2212 ? '-' : ch
    if (!ONE_CHAR_OPS.includes(op)) throw new Error(`unexpected "${ch}" at character ${i + 1}`)
    tokens.push({ kind: 'op', text: op, pos: i })
    i += 1
  }
  tokens.push({ kind: 'end', text: '', pos: source.length })
  return tokens
}

/**
 * Translates `source` to MATLAB. `resolve` maps a channel name (an alias, a channel id or a raw token, exactly as
 * written) to a MATLAB expression, or null when unknown. Throws Error with a short reason for syntax errors, unknown
 * functions and unknown channels.
 */
export function formulaToMatlab(source: string, resolve: (name: string) => string | null): MatlabFormula {
  const tokens = tokenize(source)
  const helpers = new Set<string>()
  const refs: string[] = []
  let index = 0

  const peek = (): Token => tokens[index]
  const isOp = (text: string): boolean => peek().kind === 'op' && peek().text === text
  const expect = (text: string): void => {
    if (!isOp(text)) throw new Error(`expected "${text}" at character ${peek().pos + 1}`)
    index += 1
  }
  const channel = (name: string): string => {
    const code = name ? resolve(name) : null
    if (code === null) throw new Error(`unknown channel "${name}"`)
    refs.push(name)
    return code
  }

  const primary = (): string => {
    const token = tokens[index++]
    if (token.kind === 'num') return token.text
    if (token.kind === 'ref') return channel(token.text)
    if (token.kind === 'op' && token.text === '(') {
      const inner = ternary()
      expect(')')
      return `(${inner})`
    }
    if (token.kind === 'id') {
      if (isOp('(')) return functionCall(token.text)
      // Constants are reserved words; any other identifier is a channel alias.
      return Object.hasOwn(CONSTANTS, token.text) ? CONSTANTS[token.text] : channel(token.text)
    }
    // Prefix signs bind looser than "^" only: −a^b = −(a^b), −a*b = (−a)*b.
    if (token.kind === 'op' && token.text === '-') return `(-${unary()})`
    if (token.kind === 'op' && token.text === '+') return unary()
    throw new Error(token.kind === 'end' ? 'the formula ends too early' : `unexpected "${token.text}" at character ${token.pos + 1}`)
  }

  const functionCall = (name: string): string => {
    const spec = FUNCTIONS[name]
    if (!spec) throw new Error(`unknown function "${name}"`)
    expect('(')
    const args: string[] = []
    if (!isOp(')')) {
      args.push(ternary())
      while (isOp(',')) {
        index += 1
        args.push(ternary())
      }
    }
    expect(')')
    if (args.length < spec.min || args.length > spec.max) throw new Error(`wrong number of arguments for ${name}()`)
    for (const helper of spec.helpers ?? []) helpers.add(helper)
    return spec.emit(args)
  }

  // "^" binds tighter than unary minus and is right-associative: −2^2 = −4, 2^−1 = 0.5, 2^3^2 = 2^9.
  const power = (): string => {
    const base = primary()
    if (!isOp('^')) return base
    index += 1
    helpers.add('xppReal')
    return `xppReal(${base} .^ ${unary()})`
  }

  const unary = (): string => {
    if (isOp('-') || isOp('+')) return primary()
    return power()
  }

  const binaryLevel = (next: () => string, ops: Record<string, (a: string, b: string) => string>) => (): string => {
    let left = next()
    while (peek().kind === 'op' && Object.hasOwn(ops, peek().text)) {
      const op = tokens[index++].text
      left = ops[op](left, next())
    }
    return left
  }
  const compare = (op: string) => (a: string, b: string): string => {
    helpers.add('xppCmp')
    return `xppCmp(${a}, ${b}, '${op === '!=' ? '~=' : op}')`
  }
  const comparisons = (ops: string[]) => Object.fromEntries(ops.filter((o) => COMPARISONS.has(o)).map((o) => [o, compare(o)]))

  const multiplicative = binaryLevel(unary, { '*': (a, b) => `(${a} .* ${b})`, '/': (a, b) => `(${a} ./ ${b})` })
  const additive = binaryLevel(multiplicative, { '+': (a, b) => `(${a} + ${b})`, '-': (a, b) => `(${a} - ${b})` })
  const relational = binaryLevel(additive, comparisons(['<', '<=', '>', '>=']))
  const equality = binaryLevel(relational, comparisons(['==', '!=']))

  function ternary(): string {
    const condition = equality()
    if (!isOp('?')) return condition
    index += 1
    const whenTrue = ternary()
    expect(':')
    const whenFalse = ternary()
    helpers.add('xppIf')
    return `xppIf(${condition}, ${whenTrue}, ${whenFalse})`
  }

  if (peek().kind === 'end') throw new Error('the formula is empty')
  const code = ternary()
  if (peek().kind !== 'end') throw new Error(`unexpected "${peek().text}" at character ${peek().pos + 1}`)
  return { code, helpers: [...helpers], refs }
}
