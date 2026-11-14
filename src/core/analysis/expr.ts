// A small, safe formula language for derived channels (no eval / Function). Evaluated element-wise over rows.
//   numbers 1, 2.5, 1e-3 · + − * / ^ (right-assoc) · unary − · parentheses · comparisons < <= > >= == != (1/0)
//   cond ? a : b · identifiers = channel aliases (see channels/alias.ts) or constants · [raw token] references
//   functions: sin cos tan asin acos atan atan2 sqrt abs exp ln log10 pow min max floor ceil round sign hypot
//              deg rad (convert) clamp(x,lo,hi) · time-aware: diff(x) d/dt (central differences, per second),
//              integ(x) cumulative trapezoid from the first row, smooth(x, seconds) centred moving average,
//              lag(x, rows) shift
//   constants: pi, e, g0 (9.80665 m/s²), rho0 (1.225 kg/m³), kt2ms (0.514444), ft2m (0.3048), lb2n (4.4482216),
//              lbf2n, hp2w (745.69987), nm2m (1852), fpm2ms (0.00508), t (elapsed time in seconds, per row)
// OWNER: analysis agent. Public API below is a contract; keep these signatures.
// Mirrored in MATLAB by core/export/matlabFormula.ts and the xppDdt/xppInteg/xppSmooth/xppLag/xppCmp/xppIf helpers in
// core/export/matlabLibrary.ts: keep precedence, NaN rules, constants and the time-aware functions in step.
//
// Precedence, loosest first: ?: (right-assoc) · == != · < <= > >= · + − · * / · unary − · ^ (right-assoc), so
// −2^2 = −4 and 2^−1 = 0.5 (as in MATLAB and Python). Comparisons give 1 or 0, or NaN when either side is NaN;
// a NaN condition makes ?: give NaN. Both branches of ?: are evaluated (whole columns at a time). Intermediate
// results follow IEEE arithmetic (1/0 = Infinity); non-finite values in the final column become NaN.
// Constants take precedence over channels with the same alias; [name] always means the channel.

/** A syntax or reference error with the 0-based character position it refers to (for the editor). */
export class ExprError extends Error {
  readonly position: number
  constructor(message: string, position: number) {
    super(message)
    this.name = 'ExprError'
    this.position = position
  }
}

/** An identifier or [token] that is neither a constant nor a channel (thrown by CompiledExpr.evaluate). */
export class UnknownNameError extends ExprError {
  /** The name as written, without brackets */
  readonly ref: string
  constructor(ref: string, position: number, bracket: boolean) {
    super(
      bracket ? `Unknown channel [${ref}].` : `Unknown name "${ref}": it is neither a channel alias nor a constant.`,
      position,
    )
    this.name = 'UnknownNameError'
    this.ref = ref
  }
}

export interface ExprContext {
  rowCount: number
  /** Seconds per row (Dataset.elapsed) — used by t, diff, integ, smooth */
  time: Float64Array
  /** Channel lookup by alias / id / token (channels/alias.ts makeResolver) */
  resolve(name: string): Float64Array | undefined
}

export interface CompiledExpr {
  /** Identifiers and [tokens] the formula references (excluding constants and functions) */
  refs: string[]
  /** Evaluates to a new Float64Array of ctx.rowCount values. Throws ExprError for unknown references. */
  evaluate(ctx: ExprContext): Float64Array
}

export interface ExprHelpEntry {
  name: string
  /** e.g. "smooth(x, seconds)" */
  signature: string
  description: string
}

// ------------------------------------------------------------------------------------------ constants & functions

const LB_TO_N = 0.45359237 * 9.80665

const CONSTANTS = new Map<string, { value: number; description: string }>([
  ['pi', { value: Math.PI, description: 'π ≈ 3.14159' }],
  ['e', { value: Math.E, description: "Euler's number ≈ 2.71828" }],
  ['g0', { value: 9.80665, description: 'Standard gravity, 9.80665 m/s²' }],
  ['rho0', { value: 1.225, description: 'ISA sea-level air density, 1.225 kg/m³' }],
  ['kt2ms', { value: 1852 / 3600, description: 'Knots to m/s: × 0.514444 (1852/3600)' }],
  ['ft2m', { value: 0.3048, description: 'Feet to metres: × 0.3048' }],
  ['lb2n', { value: LB_TO_N, description: 'Pounds(-force) to newtons: × 4.4482216' }],
  ['lbf2n', { value: LB_TO_N, description: 'Pounds-force to newtons: × 4.4482216 (same as lb2n)' }],
  ['hp2w', { value: 550 * 0.3048 * LB_TO_N, description: 'Horsepower to watts: × 745.69987' }],
  ['nm2m', { value: 1852, description: 'Nautical miles to metres: × 1852' }],
  ['fpm2ms', { value: 0.3048 / 60, description: 'Feet per minute to m/s: × 0.00508' }],
  ['t', { value: NaN, description: 'Elapsed time in seconds at each row (resets and gaps collapsed)' }],
])

/** true for the names the formula language reserves as constants (pi, e, g0, ..., t). */
export function isExprConstant(name: string): boolean {
  return CONSTANTS.has(name)
}

type Kernel = (...args: number[]) => number
type TimeFunction = 'diff' | 'integ' | 'smooth' | 'lag'

interface FunctionSpec {
  signature: string
  description: string
  minArgs: number
  maxArgs: number
  /** Element-wise implementation; absent for the time-aware functions */
  kernel?: Kernel
}

function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}

const FUNCTIONS = new Map<string, FunctionSpec>([
  ['sin', { signature: 'sin(x)', description: 'Sine of x in radians (sin(rad(x)) for degrees).', minArgs: 1, maxArgs: 1, kernel: Math.sin }],
  ['cos', { signature: 'cos(x)', description: 'Cosine of x in radians (cos(rad(x)) for degrees).', minArgs: 1, maxArgs: 1, kernel: Math.cos }],
  ['tan', { signature: 'tan(x)', description: 'Tangent of x in radians (tan(rad(x)) for degrees).', minArgs: 1, maxArgs: 1, kernel: Math.tan }],
  ['asin', { signature: 'asin(x)', description: 'Inverse sine in radians, NaN outside −1…1 (deg(asin(x)) for degrees).', minArgs: 1, maxArgs: 1, kernel: Math.asin }],
  ['acos', { signature: 'acos(x)', description: 'Inverse cosine in radians, NaN outside −1…1.', minArgs: 1, maxArgs: 1, kernel: Math.acos }],
  ['atan', { signature: 'atan(x)', description: 'Inverse tangent in radians.', minArgs: 1, maxArgs: 1, kernel: Math.atan }],
  ['atan2', { signature: 'atan2(y, x)', description: 'Angle of the vector (x, y) in radians, −π…π, e.g. deg(atan2(vy, vx)).', minArgs: 2, maxArgs: 2, kernel: Math.atan2 }],
  ['sqrt', { signature: 'sqrt(x)', description: 'Square root (NaN for negative x).', minArgs: 1, maxArgs: 1, kernel: Math.sqrt }],
  ['abs', { signature: 'abs(x)', description: 'Absolute value.', minArgs: 1, maxArgs: 1, kernel: Math.abs }],
  ['exp', { signature: 'exp(x)', description: 'e to the power x.', minArgs: 1, maxArgs: 1, kernel: Math.exp }],
  ['ln', { signature: 'ln(x)', description: 'Natural logarithm.', minArgs: 1, maxArgs: 1, kernel: Math.log }],
  ['log10', { signature: 'log10(x)', description: 'Base-10 logarithm.', minArgs: 1, maxArgs: 1, kernel: Math.log10 }],
  ['pow', { signature: 'pow(x, y)', description: 'x to the power y (same as x ^ y).', minArgs: 2, maxArgs: 2, kernel: Math.pow }],
  ['min', { signature: 'min(a, b, ...)', description: 'Smallest of the arguments, row by row.', minArgs: 2, maxArgs: Infinity, kernel: Math.min }],
  ['max', { signature: 'max(a, b, ...)', description: 'Largest of the arguments, row by row.', minArgs: 2, maxArgs: Infinity, kernel: Math.max }],
  ['floor', { signature: 'floor(x)', description: 'Round down to an integer.', minArgs: 1, maxArgs: 1, kernel: Math.floor }],
  ['ceil', { signature: 'ceil(x)', description: 'Round up to an integer.', minArgs: 1, maxArgs: 1, kernel: Math.ceil }],
  ['round', { signature: 'round(x)', description: 'Round to the nearest integer (halves away from zero).', minArgs: 1, maxArgs: 1, kernel: roundHalfAway }],
  ['sign', { signature: 'sign(x)', description: '−1, 0 or 1 by the sign of x.', minArgs: 1, maxArgs: 1, kernel: Math.sign }],
  ['hypot', { signature: 'hypot(a, b, ...)', description: '√(a² + b² + ...), e.g. hypot(vx, vy).', minArgs: 2, maxArgs: Infinity, kernel: Math.hypot }],
  ['deg', { signature: 'deg(x)', description: 'Radians to degrees.', minArgs: 1, maxArgs: 1, kernel: (x) => (x * 180) / Math.PI }],
  ['rad', { signature: 'rad(x)', description: 'Degrees to radians.', minArgs: 1, maxArgs: 1, kernel: (x) => (x * Math.PI) / 180 }],
  ['clamp', { signature: 'clamp(x, lo, hi)', description: 'x limited to the range lo…hi.', minArgs: 3, maxArgs: 3, kernel: (x, lo, hi) => Math.min(Math.max(x, lo), hi) }],
  [
    'diff',
    {
      signature: 'diff(x)',
      description:
        'Rate of change dx/dt per second: central differences on elapsed time, one-sided at the ends and next to ' +
        'missing samples; NaN where time does not advance.',
      minArgs: 1,
      maxArgs: 1,
    },
  ],
  [
    'integ',
    {
      signature: 'integ(x)',
      description:
        'Running integral of x over time in seconds from the first row (trapezoid rule; gaps bridged linearly), ' +
        'e.g. integ(FF_1_lb_h) / 3600 is fuel burned in lb.',
      minArgs: 1,
      maxArgs: 1,
    },
  ],
  [
    'smooth',
    {
      signature: 'smooth(x, seconds)',
      description: 'Centred moving average over a window of the given width in seconds (missing samples ignored).',
      minArgs: 2,
      maxArgs: 2,
    },
  ],
  [
    'lag',
    {
      signature: 'lag(x, rows)',
      description:
        "x shifted by a whole number of rows: lag(x, 1) is the previous row's value, negative rows look ahead; " +
        'rows shifted in from outside the file are NaN.',
      minArgs: 2,
      maxArgs: 2,
    },
  ],
])

/** Functions and constants for the formula editor's help and autocomplete. */
export function exprHelp(): { functions: ExprHelpEntry[]; constants: ExprHelpEntry[] } {
  return {
    functions: [...FUNCTIONS].map(([name, spec]) => ({ name, signature: spec.signature, description: spec.description })),
    constants: [...CONSTANTS].map(([name, spec]) => ({ name, signature: name, description: spec.description })),
  }
}

// ------------------------------------------------------------------------------------------ tokenizer

interface Token {
  type: 'number' | 'ident' | 'ref' | 'op' | 'end'
  text: string
  value: number
  pos: number
}

const NUMBER_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y
const TWO_CHAR_OPS = new Set(['<=', '>=', '==', '!='])
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '^', '(', ')', ',', '?', ':', '<', '>'])

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    const pos = i
    if (/[0-9.]/.test(ch)) {
      NUMBER_RE.lastIndex = i
      const match = NUMBER_RE.exec(src)
      if (!match) throw new ExprError(`Unexpected "${ch}".`, pos)
      tokens.push({ type: 'number', text: match[0], value: Number(match[0]), pos })
      i += match[0].length
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      IDENT_RE.lastIndex = i
      const match = IDENT_RE.exec(src)
      const text = match ? match[0] : ch
      tokens.push({ type: 'ident', text, value: NaN, pos })
      i += text.length
      continue
    }
    if (ch === '[') {
      const close = src.indexOf(']', i + 1)
      if (close < 0) throw new ExprError('Missing "]" to close the channel reference.', pos)
      const text = src.slice(i + 1, close).trim()
      if (!text) throw new ExprError('Empty channel reference "[]".', pos)
      tokens.push({ type: 'ref', text, value: NaN, pos })
      i = close + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', text: two, value: NaN, pos })
      i += 2
      continue
    }
    // U+2212 (the typographic minus used in the app's own text) is accepted as "-".
    const op = ch === '−' ? '-' : ch
    if (ONE_CHAR_OPS.has(op)) {
      tokens.push({ type: 'op', text: op, value: NaN, pos })
      i += 1
      continue
    }
    if (ch === '=') throw new ExprError('Use == to compare ("=" alone is not an operator).', pos)
    if (ch === '!') throw new ExprError('Unexpected "!" (use != for "not equal").', pos)
    if (ch === '&' || ch === '|') {
      throw new ExprError('"&&" and "||" are not supported: multiply comparisons for "and", e.g. (a > 1) * (b < 2).', pos)
    }
    if (ch === ']') throw new ExprError('Unexpected "]" (channel references look like [token]).', pos)
    throw new ExprError(`Unexpected character "${ch}".`, pos)
  }
  tokens.push({ type: 'end', text: '', value: NaN, pos: src.length })
  return tokens
}

// ------------------------------------------------------------------------------------------ parser (Pratt)

type BinaryOp = '+' | '-' | '*' | '/' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!='

type Node =
  | { type: 'num'; value: number; pos: number }
  | { type: 'const'; name: string; pos: number }
  | { type: 'ref'; name: string; bracket: boolean; pos: number }
  | { type: 'neg'; arg: Node; pos: number }
  | { type: 'bin'; op: BinaryOp; left: Node; right: Node; pos: number }
  | { type: 'cond'; test: Node; yes: Node; no: Node; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number }

type RefNode = Extract<Node, { type: 'ref' }>

const TERNARY_BP = 1
const UNARY_BP = 6
const BINARY_BP: Record<BinaryOp, number> = {
  '==': 2,
  '!=': 2,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '^': 7,
}
const MAX_DEPTH = 200
const MAX_TOKENS = 4000

function isBinaryOp(text: string): text is BinaryOp {
  return Object.hasOwn(BINARY_BP, text)
}

function describeToken(tok: Token): string {
  if (tok.type === 'end') return 'the end of the formula'
  if (tok.type === 'ref') return `[${tok.text}]`
  return `"${tok.text}"`
}

function unknownFunctionMessage(name: string): string {
  if (name === 'log') return 'Unknown function "log": use ln (natural logarithm) or log10.'
  if (CONSTANTS.has(name)) return `"${name}" is a constant, not a function.`
  const lower = name.toLowerCase()
  if (FUNCTIONS.has(lower)) return `Unknown function "${name}": did you mean ${lower}?`
  return `Unknown function "${name}".`
}

function parse(src: string): { ast: Node; refNodes: RefNode[] } {
  const tokens = tokenize(src)
  // Evaluation recurses over the syntax tree: bound its size so no formula can exhaust the stack.
  if (tokens.length > MAX_TOKENS) throw new ExprError('The formula is too long.', tokens[MAX_TOKENS].pos)
  const refNodes: RefNode[] = []
  let k = 0
  let depth = 0

  const peek = (): Token => tokens[k]
  const isOp = (tok: Token, text: string) => tok.type === 'op' && tok.text === text
  const expect = (text: string, message: string): void => {
    if (!isOp(peek(), text)) throw new ExprError(message, peek().pos)
    k += 1
  }

  function parseExpression(minBp: number): Node {
    depth += 1
    if (depth > MAX_DEPTH) throw new ExprError('The formula is nested too deeply.', peek().pos)
    let left = parsePrefix()
    for (;;) {
      const tok = peek()
      if (tok.type === 'end') break
      if (tok.type !== 'op') throw new ExprError(`Expected an operator before ${describeToken(tok)}.`, tok.pos)
      if (tok.text === '?') {
        if (TERNARY_BP <= minBp) break
        k += 1
        const yes = parseExpression(0)
        expect(':', `Expected ":" to complete "? :" (started at character ${tok.pos + 1}).`)
        const no = parseExpression(TERNARY_BP - 1)
        left = { type: 'cond', test: left, yes, no, pos: tok.pos }
        continue
      }
      if (!isBinaryOp(tok.text)) break
      const bp = BINARY_BP[tok.text]
      if (bp <= minBp) break
      k += 1
      // "^" is right-associative: its right operand may itself contain "^".
      const right = parseExpression(tok.text === '^' ? bp - 1 : bp)
      left = { type: 'bin', op: tok.text, left, right, pos: tok.pos }
    }
    depth -= 1
    return left
  }

  function parsePrefix(): Node {
    const tok = tokens[k]
    k += 1
    switch (tok.type) {
      case 'number':
        return { type: 'num', value: tok.value, pos: tok.pos }
      case 'ref': {
        const node: RefNode = { type: 'ref', name: tok.text, bracket: true, pos: tok.pos }
        refNodes.push(node)
        return node
      }
      case 'ident': {
        if (isOp(peek(), '(')) return parseCall(tok)
        if (CONSTANTS.has(tok.text)) return { type: 'const', name: tok.text, pos: tok.pos }
        const node: RefNode = { type: 'ref', name: tok.text, bracket: false, pos: tok.pos }
        refNodes.push(node)
        return node
      }
      case 'op':
        if (tok.text === '-') return { type: 'neg', arg: parseExpression(UNARY_BP), pos: tok.pos }
        if (tok.text === '+') return parseExpression(UNARY_BP)
        if (tok.text === '(') {
          const inner = parseExpression(0)
          expect(')', `Missing ")" to close the "(" at character ${tok.pos + 1}.`)
          return inner
        }
        throw new ExprError(`Unexpected ${describeToken(tok)}.`, tok.pos)
      case 'end':
        throw new ExprError(tok.pos === 0 ? 'The formula is empty.' : 'The formula ends unexpectedly.', tok.pos)
    }
  }

  function parseCall(nameToken: Token): Node {
    const name = nameToken.text
    const spec = FUNCTIONS.get(name)
    if (!spec) throw new ExprError(unknownFunctionMessage(name), nameToken.pos)
    k += 1 // "("
    const args: Node[] = []
    if (!isOp(peek(), ')')) {
      for (;;) {
        args.push(parseExpression(0))
        if (!isOp(peek(), ',')) break
        k += 1
      }
    }
    expect(')', `Missing ")" to close ${name}(.`)
    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      const expected =
        spec.maxArgs === Infinity
          ? `at least ${spec.minArgs} arguments`
          : `${spec.minArgs} argument${spec.minArgs === 1 ? '' : 's'}`
      throw new ExprError(`${spec.signature} takes ${expected} (got ${args.length}).`, nameToken.pos)
    }
    return { type: 'call', name, args, pos: nameToken.pos }
  }

  const ast = parseExpression(0)
  const rest = peek()
  if (rest.type !== 'end') throw new ExprError(`Unexpected ${describeToken(rest)}.`, rest.pos)
  return { ast, refNodes }
}

/** Parses a formula. Throws ExprError with a position for syntax errors and unknown functions. */
export function compileExpression(source: string): CompiledExpr {
  const { ast, refNodes } = parse(source)
  const refs = [...new Set(refNodes.map((node) => node.name))]
  return {
    refs,
    evaluate(ctx: ExprContext): Float64Array {
      const n = Math.max(0, Math.floor(ctx.rowCount))
      let time = ctx.time
      if (time.length !== n) {
        time = new Float64Array(n).fill(NaN)
        time.set(ctx.time.subarray(0, n))
      }
      // Resolve every reference first, in source order, so the error points at the first unknown name.
      const resolved = new Map<RefNode, Float64Array>()
      for (const node of refNodes) {
        const values = ctx.resolve(node.name)
        if (!values) throw new UnknownNameError(node.name, node.pos, node.bracket)
        if (values.length !== n) {
          throw new ExprError(`"${node.name}" has ${values.length} values but the dataset has ${n} rows.`, node.pos)
        }
        resolved.set(node, values)
      }
      const value = evaluateNode(ast, { n, time, resolved })
      const out = new Float64Array(n)
      if (typeof value === 'number') {
        out.fill(Number.isFinite(value) ? value : NaN)
      } else {
        for (let i = 0; i < n; i += 1) out[i] = Number.isFinite(value[i]) ? value[i] : NaN
      }
      return out
    },
  }
}

// ------------------------------------------------------------------------------------------ evaluation

/** A scalar (broadcast to every row) or one value per row. Inputs are never modified. */
type Value = number | Float64Array

interface Env {
  n: number
  time: Float64Array
  resolved: Map<RefNode, Float64Array>
}

const at = (v: Value, i: number): number => (typeof v === 'number' ? v : v[i])

function compare(test: (a: number, b: number) => boolean): Kernel {
  return (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : test(a, b) ? 1 : 0)
}

const BINARY_KERNELS: Record<BinaryOp, Kernel> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '^': Math.pow,
  '<': compare((a, b) => a < b),
  '<=': compare((a, b) => a <= b),
  '>': compare((a, b) => a > b),
  '>=': compare((a, b) => a >= b),
  '==': compare((a, b) => a === b),
  '!=': compare((a, b) => a !== b),
}

function evaluateNode(node: Node, env: Env): Value {
  switch (node.type) {
    case 'num':
      return node.value
    case 'const':
      return node.name === 't' ? env.time : (CONSTANTS.get(node.name)?.value ?? NaN)
    case 'ref':
      return env.resolved.get(node) ?? NaN
    case 'neg':
      return mapValues([evaluateNode(node.arg, env)], (a) => -a, env.n)
    case 'bin':
      return mapValues([evaluateNode(node.left, env), evaluateNode(node.right, env)], BINARY_KERNELS[node.op], env.n)
    case 'cond': {
      const test = evaluateNode(node.test, env)
      const yes = evaluateNode(node.yes, env)
      const no = evaluateNode(node.no, env)
      return mapValues([test, yes, no], (c, a, b) => (Number.isNaN(c) ? NaN : c !== 0 ? a : b), env.n)
    }
    case 'call':
      return evaluateCall(node, env)
  }
}

/** Applies an element-wise kernel with scalar broadcasting. */
function mapValues(args: Value[], kernel: Kernel, n: number): Value {
  if (args.every((a) => typeof a === 'number')) return kernel(...(args as number[]))
  const out = new Float64Array(n)
  if (args.length === 1) {
    const a = args[0] as Float64Array
    for (let i = 0; i < n; i += 1) out[i] = kernel(a[i])
  } else if (args.length === 2) {
    const [a, b] = args
    for (let i = 0; i < n; i += 1) out[i] = kernel(at(a, i), at(b, i))
  } else if (args.length === 3) {
    const [a, b, c] = args
    for (let i = 0; i < n; i += 1) out[i] = kernel(at(a, i), at(b, i), at(c, i))
  } else {
    const row = new Array<number>(args.length)
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < args.length; j += 1) row[j] = at(args[j], i)
      out[i] = kernel(...row)
    }
  }
  return out
}

function toColumn(v: Value, n: number): Float64Array {
  return typeof v === 'number' ? new Float64Array(n).fill(v) : v
}

function scalarArgument(v: Value, node: Node, message: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprError(message, node.pos)
  return v
}

function evaluateCall(node: Extract<Node, { type: 'call' }>, env: Env): Value {
  const args = node.args.map((arg) => evaluateNode(arg, env))
  const spec = FUNCTIONS.get(node.name)
  if (spec?.kernel) return mapValues(args, spec.kernel, env.n)
  const name = node.name as TimeFunction
  const x = toColumn(args[0], env.n)
  switch (name) {
    case 'diff':
      return differentiate(x, env.time, env.n)
    case 'integ':
      return integrate(x, env.time, env.n)
    case 'smooth': {
      const seconds = scalarArgument(args[1], node.args[1], 'smooth(x, seconds): seconds must be a constant number.')
      if (seconds < 0) throw new ExprError('smooth(x, seconds): seconds must not be negative.', node.args[1].pos)
      return movingAverage(x, env.time, env.n, seconds)
    }
    case 'lag': {
      const rows = scalarArgument(args[1], node.args[1], 'lag(x, rows): rows must be a constant number.')
      return shift(x, env.n, roundHalfAway(rows))
    }
  }
}

/**
 * d/dt: (x[i+1] − x[i−1]) / (t[i+1] − t[i−1]), one-sided at the ends and next to missing samples; NaN where x[i]
 * is missing or the time step is not positive.
 */
function differentiate(x: Float64Array, t: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN)
  const ok = (i: number) => Number.isFinite(x[i]) && Number.isFinite(t[i])
  for (let i = 0; i < n; i += 1) {
    if (!ok(i)) continue
    const prev = i > 0 && ok(i - 1)
    const next = i < n - 1 && ok(i + 1)
    let dx: number
    let dt: number
    if (prev && next) {
      dx = x[i + 1] - x[i - 1]
      dt = t[i + 1] - t[i - 1]
    } else if (next) {
      dx = x[i + 1] - x[i]
      dt = t[i + 1] - t[i]
    } else if (prev) {
      dx = x[i] - x[i - 1]
      dt = t[i] - t[i - 1]
    } else {
      continue
    }
    out[i] = dt > 0 ? dx / dt : NaN
  }
  return out
}

/** Cumulative trapezoid ∫x dt from the first finite sample (0 there); NaN rows stay NaN, gaps are bridged linearly. */
function integrate(x: Float64Array, t: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN)
  // Neumaier-compensated sum: long logs add many small increments to a growing total.
  let sum = 0
  let compensation = 0
  let last = -1
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(t[i])) continue
    if (last >= 0) {
      const dt = t[i] - t[last]
      if (dt > 0) {
        const increment = 0.5 * (x[i] + x[last]) * dt
        const total = sum + increment
        compensation += Math.abs(sum) >= Math.abs(increment) ? sum - total + increment : increment - total + sum
        sum = total
      }
    }
    out[i] = sum + compensation
    last = i
  }
  return out
}

/**
 * Centred moving average over |t_j − t_i| ≤ seconds/2 (time must be non-decreasing, as Dataset.elapsed is).
 * Two pointers and a running sum make it O(n) whatever the window; values are offset by the first finite sample so
 * the running sum stays small. NaN rows stay NaN; NaN samples inside the window are ignored.
 */
function movingAverage(x: Float64Array, t: Float64Array, n: number, seconds: number): Float64Array {
  const out = new Float64Array(n).fill(NaN)
  const half = seconds / 2
  let ref = 0
  for (let i = 0; i < n; i += 1) {
    if (Number.isFinite(x[i])) {
      ref = x[i]
      break
    }
  }
  const counts = (j: number) => Number.isFinite(x[j]) && Number.isFinite(t[j])
  let lo = 0
  let hi = 0
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i += 1) {
    const ti = t[i]
    if (!Number.isFinite(ti)) continue
    while (hi < n && (!Number.isFinite(t[hi]) || t[hi] <= ti + half)) {
      if (counts(hi)) {
        sum += x[hi] - ref
        count += 1
      }
      hi += 1
    }
    while (lo < hi && (!Number.isFinite(t[lo]) || t[lo] < ti - half)) {
      if (counts(lo)) {
        sum -= x[lo] - ref
        count -= 1
      }
      lo += 1
    }
    if (Number.isFinite(x[i]) && count > 0) out[i] = ref + sum / count
  }
  return out
}

/** out[i] = x[i − rows] (NaN outside the file). */
function shift(x: Float64Array, n: number, rows: number): Float64Array {
  const out = new Float64Array(n).fill(NaN)
  for (let i = Math.max(0, rows); i < Math.min(n, n + rows); i += 1) out[i] = x[i - rows]
  return out
}
