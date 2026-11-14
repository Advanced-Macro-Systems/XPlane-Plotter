// MATLAB script export: a self-contained .m file that re-reads the ORIGINAL X-Plane log and reproduces the test-point
// statistics, the X–Y figure (means ± σ, the app's fits), the time-history figure and (optionally) the mode fit, writing
// figures and tables to ./out/ — so coursework figures and numbers come from MATLAB (run_all.m), not from the browser.
// Base MATLAB only (R2021a+, no toolboxes). The reader must accept exactly the rows the app's parser accepts.
// OWNER: export agent. Public API below is a contract; keep these signatures.
//
// The generated script is data (channels, rows, labels, settings) followed by generic MATLAB code and local functions
// (matlabLibrary.ts), so every export runs the same, tested code. Rows are written 1-based and inclusive (the app's
// [start, end) becomes start+1:end), each with the elapsed time the app had there: the script checks them against its
// own elapsed time and locates the window by time instead when the log does not match. Settings that the code branches
// on live in structs (xy.*, modeCfg.*) so the MATLAB Code Analyzer does not report the other branches as unreachable.
// Script-level names are distinctive (logNames, iPoint, ...) because a script shares the caller's workspace (run_all.m).

import { channelTitle } from '../channels'
import { channelAlias } from '../channels/alias'
import { channelById } from '../dataset'
import type { Channel, Dataset, RowRange, TestPoint, Workspace } from '../types'
import { matlabLibrary } from './matlabLibrary'
import { formulaToMatlab } from './matlabFormula'

export interface MatlabExportOptions {
  ds: Dataset
  ws: Workspace
  include: {
    /** Test-point table (mean, std, min, max, n per tracked channel) -> out/test_points.csv */
    points: boolean
    /** X–Y figure per the workspace's XYConfig -> out/xy.png + out/xy.pdf */
    xy: boolean
    /** Time histories of the workspace's panels over `view` -> out/time_history.png + .pdf */
    time: boolean
    /** Mode fit of ws.modes on its rows -> out/mode_fit.png + out/mode_fit.txt */
    modes: boolean
  }
  /** Rows for the time-history figure (current zoom); null = whole file */
  view: RowRange | null
  /** Rows for the mode fit when ws.modes.source is 'selection' or 'view' */
  modeRows: RowRange | null
  /** File name the script reads (default: ds.name) */
  dataFile?: string
  /** Public URL of the app, quoted in the header comment */
  appUrl?: string
  /**
   * The X–Y axis ranges the app showed (views/xy focusedAxes: a few absurd samples, such as CL on the ground, are left
   * off the axes); null or absent = automatic axes. The script applies them to its axes and, like the app, fits
   * through the samples inside them only.
   */
  xyLimits?: { x: readonly [number, number] | null; y: readonly [number, number] | null } | null
}

/** The app's 8 categorical colours in the light theme (styles/global.css --series-1..8), in slot order. */
export const SERIES_COLORS: readonly { hex: string; name: string }[] = [
  { hex: '#2a78d6', name: 'blue' },
  { hex: '#eb6834', name: 'orange' },
  { hex: '#1baf7a', name: 'aqua' },
  { hex: '#eda100', name: 'yellow' },
  { hex: '#e87ba4', name: 'magenta' },
  { hex: '#008300', name: 'green' },
  { hex: '#6250d6', name: 'violet' },
  { hex: '#e34948', name: 'red' },
]

const MATLAB_KEYWORDS = new Set([
  'break', 'case', 'catch', 'classdef', 'continue', 'else', 'elseif', 'end', 'for', 'function', 'global', 'if',
  'otherwise', 'parfor', 'persistent', 'return', 'spmd', 'switch', 'try', 'while',
])

// ------------------------------------------------------------------ MATLAB text helpers

/** C0/C1 control characters and the Unicode line/paragraph separators. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

/** Text on one line: every run of control characters (line breaks included) becomes one space. */
function oneLine(text: string): string {
  let out = ''
  let inRun = false
  for (let i = 0; i < text.length; i += 1) {
    if (isControl(text.charCodeAt(i))) {
      if (!inRun) out += ' '
      inRun = true
    } else {
      out += text[i]
      inRun = false
    }
  }
  return out
}

/**
 * A MATLAB char-vector expression for any text: single quotes doubled, line breaks and other control characters
 * replaced by spaces, and non-ASCII characters written as char(code), so the script reads the same whatever encoding
 * MATLAB assumes for the file: "lb·ft" -> ['lb' char(183) 'ft'].
 */
export function matlabString(text: string): string {
  const clean = oneLine(text)
  const parts: string[] = []
  let ascii = ''
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i)
    if (code < 128) {
      ascii += code === 39 ? "''" : clean[i]
      continue
    }
    if (ascii) parts.push(`'${ascii}'`)
    ascii = ''
    // MATLAB chars are UTF-16 code units, like JS strings: surrogate pairs stay two codes.
    parts.push(`char(${code})`)
  }
  if (ascii || parts.length === 0) parts.push(`'${ascii}'`)
  return parts.length === 1 ? parts[0] : `[${parts.join(' ')}]`
}

/** Text for a % comment: one line, no control characters. */
function commentText(text: string): string {
  return oneLine(text).trim()
}

/** "name = value;" padded so its comment starts in a fixed column. */
function setting(assignment: string, comment: string): string {
  return `${assignment.padEnd(30)} % ${comment}`
}

/** A finite number as a MATLAB literal (shortest round-trip, e.g. 0.1, 1e-7); NaN for anything else. */
function num(value: number): string {
  return Number.isFinite(value) ? String(value) : 'NaN'
}

/** A time (s) with 6 decimals — far finer than the 1e-3 s row check — without trailing zeros. */
function seconds(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : 'NaN'
}

/** A cell column vector of char literals: {'a'; 'b'} (one element per line when long). */
function cellColumn(items: readonly string[]): string {
  if (items.length === 0) return 'cell(0, 1)'
  const literals = items.map(matlabString)
  const inline = `{${literals.join('; ')}}`
  return inline.length <= 90 ? inline : `{\n    ${literals.join('\n    ')}\n}`
}

/** Column-vector literal: [a; b], a bare scalar for one item (no Code Analyzer note), `empty` for none. */
function columnLiteral(cells: readonly string[], empty: string): string {
  if (cells.length === 0) return empty
  return cells.length === 1 ? cells[0] : `[${cells.join('; ')}]`
}

/** A logical column vector: [true; false]. */
function logicalColumn(items: readonly boolean[]): string {
  return columnLiteral(items.map((b) => (b ? 'true' : 'false')), 'false(0, 1)')
}

/** A numeric column vector: [1; 2]. */
function numberColumn(items: readonly number[]): string {
  return columnLiteral(items.map(num), 'zeros(0, 1)')
}

/** A valid, unique MATLAB identifier built from `base` (at most `maxLength` characters). */
function identifier(base: string, used: Set<string>, maxLength = 63): string {
  let name = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '')
  if (!/^[A-Za-z]/.test(name)) name = `x${name}`
  name = name.slice(0, maxLength).replace(/_+$/, '') || 'x'
  if (MATLAB_KEYWORDS.has(name)) name = `${name}_`
  let candidate = name
  for (let k = 2; used.has(candidate); k += 1) {
    const suffix = `_${k}`
    candidate = name.slice(0, maxLength - suffix.length) + suffix
  }
  used.add(candidate)
  return candidate
}

/** Words wrapped into comment lines of at most `width` characters. */
function wrapComment(text: string, width = 116): string[] {
  const lines: string[] = []
  let line = '%'
  for (const word of commentText(text).split(/\s+/)) {
    if (line.length > 1 && line.length + 1 + word.length > width) {
      lines.push(line)
      line = '%  '
    }
    line += ` ${word}`
  }
  lines.push(line)
  return lines
}

/**
 * A file name for the script that MATLAB can run by name ("Data 737.txt" -> "xpp_Data_737.m"): letters, digits and
 * underscores only, starting with a letter, at most 63 characters before ".m".
 */
export function matlabScriptName(datasetName: string): string {
  const stem = datasetName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${`xpp_${stem || 'export'}`.slice(0, 63).replace(/_+$/, '')}.m`
}

// ------------------------------------------------------------------ the generator

interface Formula {
  variable: string
  lines: string[]
}

/** Rows written into the script: 1-based inclusive bounds plus the app's elapsed time at both ends. */
interface RowsLiteral {
  first: number
  last: number
  t0: number
  t1: number
}

class ScriptWriter {
  readonly helpers = new Set<string>()
  readonly notes: string[] = []
  private readonly variables = new Set<string>()
  private readonly formulas = new Map<string, Formula>()
  private readonly formulaOrder: string[] = []
  private readonly ds: Dataset

  constructor(ds: Dataset) {
    this.ds = ds
  }

  /** MATLAB expression (a column vector) for a channel id; null when the dataset has no such channel. */
  channelExpr(id: string | null | undefined): string | null {
    if (!id) return null
    const ch = channelById(this.ds, id)
    if (!ch) return null
    if (ch.derived) return this.formula(ch).variable
    if (ch.column < 0) return null
    return `D(:, col(${matlabString(ch.token)}, ${ch.occurrence}))`
  }

  /**
   * Formula channels used so far, as MATLAB lines, in the dataset's order (creation order — a formula can only use
   * earlier ones, so dependencies come first).
   */
  formulaLines(): string[] {
    const position = (id: string) => this.ds.channels.findIndex((ch) => ch.id === id)
    return [...this.formulaOrder]
      .sort((a, b) => position(a) - position(b))
      .flatMap((id) => this.formulas.get(id)?.lines ?? [])
  }

  /** A derived channel as a MATLAB variable, translated from its formula (dependencies first). */
  private formula(ch: Channel): Formula {
    const known = this.formulas.get(ch.id)
    if (known) return known
    const variable = identifier(`fx_${ch.id.replace(/^fx:/, '')}`, this.variables, 40)
    const entry: Formula = { variable, lines: [] }
    // Registered before translating, so a formula that (wrongly) refers to itself cannot recurse forever.
    this.formulas.set(ch.id, entry)
    const expression = ch.derived?.expression ?? ''
    const header = `% ${commentText(channelTitle(ch))} = ${commentText(expression)}`
    try {
      const resolve = this.formulaResolver(ch)
      const result = formulaToMatlab(expression, (name) => {
        const target = resolve(name)
        return target ? this.channelExpr(target.id) : null
      })
      for (const helper of result.helpers) this.helpers.add(helper)
      entry.lines = [
        header,
        `${variable} = ${result.code} + zeros(nRows, 1);`,
        // As in the app: a formula's infinities (1/0) are stored as NaN.
        `${variable}(~isfinite(${variable})) = NaN;`,
      ]
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      entry.lines = [
        header,
        `% This formula could not be translated to MATLAB (${commentText(reason)}): the channel is NaN below.`,
        `${variable} = NaN(nRows, 1);`,
        `warning('xpp:formula', 'Formula channel %s could not be translated to MATLAB; it is NaN in this script.', ${matlabString(
          channelTitle(ch),
        )});`,
      ]
      this.notes.push(`formula channel "${channelTitle(ch)}" could not be translated (${reason})`)
    }
    this.formulaOrder.push(ch.id)
    return entry
  }

  /** The app's formula name lookup (channels/alias.ts makeResolver) over the channels defined before `ch`. */
  private formulaResolver(ch: Channel): (name: string) => Channel | undefined {
    const table = new Map<string, Channel>()
    for (const other of this.ds.channels) {
      if (other === ch) break
      const alias = channelAlias(other)
      if (!table.has(alias)) table.set(alias, other)
      if (!table.has(other.id)) table.set(other.id, other)
      if (other.token && !table.has(other.token)) table.set(other.token, other)
    }
    return (name) => table.get(name.trim())
  }

  /** Row range [start, end) as a checked MATLAB row literal; null when empty after clamping. */
  rows(range: RowRange): RowsLiteral | null {
    const n = this.ds.rowCount
    const start = Math.max(0, Math.min(n, Math.floor(Math.min(range[0], range[1]))))
    const end = Math.max(start, Math.min(n, Math.ceil(Math.max(range[0], range[1]))))
    if (end <= start) return null
    return { first: start + 1, last: end, t0: this.ds.elapsed[start], t1: this.ds.elapsed[end - 1] }
  }

  /** xppRows(...) call for a row literal. */
  rowsCall(rows: RowsLiteral, what: string): string {
    this.helpers.add('xppRows')
    return `xppRows(el, ${rows.first}, ${rows.last}, ${seconds(rows.t0)}, ${seconds(rows.t1)}, ${matlabString(what)})`
  }
}

/** Short description of a row literal for comments: "rows 1201-1350 (elapsed 120-134.9 s)". */
function describeRows(rows: RowsLiteral): string {
  return `rows ${rows.first}-${rows.last} (elapsed ${seconds(rows.t0)}-${seconds(rows.t1)} s)`
}

function titleOf(ds: Dataset, id: string | null): string {
  const ch = id ? channelById(ds, id) : undefined
  return ch ? channelTitle(ch) : ''
}

/** Y-axis label for several channels: their shared unit when they have one, else their titles. */
function sharedLabel(channels: Channel[]): string {
  if (channels.length === 1) return channelTitle(channels[0])
  const units = new Set(channels.map((ch) => ch.meta.unit))
  const [unit] = [...units]
  return units.size === 1 && unit
    ? `${channels.map((ch) => ch.meta.short).join(', ')} [${unit}]`
    : channels.map(channelTitle).join(', ')
}

function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return ''
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`
  return `${bytes} B`
}

/** UTC date and time like "2026-11-14 01:23 UTC". */
function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function matlabScript(opts: MatlabExportOptions): string {
  const { ds, ws } = opts
  const w = new ScriptWriter(ds)
  const dataFile = opts.dataFile?.trim() || ds.name
  const fileColumns = ds.channels.filter((ch) => !ch.derived && ch.column >= 0).length

  // The X–Y figure needs an x and at least one y channel. The test points are defined once for the table and the
  // X–Y figure (also when it does not plot them, so its xy.source setting can be switched to 'points').
  const doXY = opts.include.xy && w.channelExpr(ws.xy.x) !== null && ws.xy.ys.some((id) => w.channelExpr(id) !== null)
  const modePoint = ws.modes.source.startsWith('point:')
    ? ws.points.find((p) => `point:${p.id}` === ws.modes.source)
    : undefined
  const needPoints = (opts.include.points && ws.points.length > 0) || doXY

  // Build the sections first: they register the channels, formulas and helpers that the preamble must define.
  const pointsDef = needPoints ? pointsDefinition(w, ws) : []
  const table = opts.include.points ? pointsTable(w, ds, ws) : []
  const xy = opts.include.xy ? xySection(w, ds, ws, opts, doXY) : null
  const time = opts.include.time ? timeSection(w, ds, ws, opts) : null
  const modes = opts.include.modes ? modeSection(w, ds, ws, opts, modePoint) : null
  const formulas = w.formulaLines()
  const figures = [xy, time, modes].some((s) => s?.figure)

  const outputs: string[] = []
  if (opts.include.points && ws.points.length) outputs.push('test-point table -> out/test_points.csv')
  if (xy?.figure) outputs.push('X-Y plot -> out/xy.png, out/xy.pdf')
  if (time?.figure) outputs.push('time histories -> out/time_history.png, out/time_history.pdf')
  if (modes?.figure) outputs.push('mode fit -> out/mode_fit.png, out/mode_fit.pdf, out/mode_fit.txt')

  const sections: { title: string; lines: string[] }[] = []
  sections.push({ title: 'Read the log', lines: readSection(w, ds, fileColumns) })
  sections.push({ title: 'Elapsed time', lines: elapsedSection(w, ds) })
  if (formulas.length) {
    sections.push({
      title: 'Formula channels',
      lines: [
        "% The app's formula channels, re-computed here from the same columns (translated from the formula",
        '% language: element-wise operators, t = elapsed time, NaN where a result is not a real number; diff, integ,',
        '% smooth and lag stay inside each segment, never reaching across a sim reset or recording gap).',
        ...formulas,
      ],
    })
  }
  if (figures) sections.push({ title: 'Plot colours', lines: colourLines() })
  if (pointsDef.length) sections.push({ title: 'Test points', lines: pointsDef })
  if (table.length) sections.push({ title: 'Test-point table -> out/test_points.csv', lines: table })
  if (xy) sections.push({ title: 'X-Y plot -> out/xy.png, out/xy.pdf', lines: xy.lines })
  if (time) sections.push({ title: 'Time histories -> out/time_history.png, .pdf', lines: time.lines })
  if (modes) sections.push({ title: 'Mode fit -> out/mode_fit.png, .pdf, .txt', lines: modes.lines })

  const scriptName = matlabScriptName(ds.name)
  const sectionList = ['1 Settings', ...sections.map((s, i) => `${i + 2} ${s.title.replace(/ ->.*$/, '')}`)].join(', ')
  const header = [
    `%% X-Plane Plotter export: ${commentText(ds.name)}`,
    `% Generated by X-Plane Plotter${opts.appUrl ? ` (${commentText(opts.appUrl)})` : ''} on ${stamp(new Date())}.`,
    `% Source log: ${commentText(ds.name)}, ${ds.rowCount} rows x ${fileColumns} columns` +
      `${ds.sizeBytes > 0 ? ` (${formatBytes(ds.sizeBytes)})` : ''}, ` +
      `${ds.format === 'xplane' ? 'X-Plane Data.txt format' : 'delimited text'}.`,
    '%',
    '% How to use',
    "%   1. Save this script next to the log, or set dataFile in section 1 to the log's full path.",
    `%   2. Run it, or call it from your run_all.m:   run('${scriptName}')`,
    '%   3. Figures (PNG at 300 dpi and vector PDF) and tables are written to the "out" folder next to this script.',
    '% Needs MATLAB R2021a or newer and no toolboxes. The script only reads the log. Like any script it leaves its',
    '% variables (D, logNames, el, ...) in the workspace; it never clears the workspace or closes figures it did not make.',
    '%',
    '% Outputs',
    ...(outputs.length ? outputs.map((o) => `%   - ${o}`) : ['%   (none: the script reads the log and builds elapsed time)']),
    ...(w.notes.length ? ['%', '% Notes', ...w.notes.flatMap((n) => wrapComment(`  - ${n}`))] : []),
    '%',
    ...wrapComment(`Sections: ${sectionList}. Local functions (readXPlaneLog and helpers) are at the end of the file.`),
  ]

  const lines: string[] = [
    ...header,
    '',
    '%% 1. Settings',
    `${`dataFile = ${matlabString(dataFile)};`.padEnd(61)} % the X-Plane log: next to this script, or a full path`,
    `${"outDir = fullfile(fileparts(mfilename('fullpath')), 'out');".padEnd(61)} % figures and tables are written here`,
    `${'showFigures = true;'.padEnd(61)} % false: draw figures off-screen (batch runs)`,
  ]
  sections.forEach((section, i) => {
    lines.push('', `%% ${i + 2}. ${section.title}`, ...section.lines)
  })
  lines.push('', "fprintf('\\nDone. Outputs are in %s\\n', outDir);")
  lines.push('', '%% Local functions', ...matlabLibrary(w.helpers))
  return `${lines.join('\n')}\n`
}

// ------------------------------------------------------------------ sections

interface Section {
  lines: string[]
  /** true when the section draws and saves a figure (false when it only explains why it was skipped) */
  figure: boolean
}

function skipped(comment: string, message: string): Section {
  return { lines: [`% ${comment}`, `fprintf('%s\\n', ${matlabString(message)});`], figure: false }
}

function readSection(w: ScriptWriter, ds: Dataset, fileColumns: number): string[] {
  w.helpers.add('readXPlaneLog')
  w.helpers.add('xppColumn')
  return [
    "scriptDir = fileparts(mfilename('fullpath'));",
    'if ~isfile(dataFile) && isfile(fullfile(scriptDir, dataFile))',
    '    dataFile = fullfile(scriptDir, dataFile);',
    'end',
    'if ~isfile(dataFile)',
    "    error('xpp:noLog', 'Cannot find the log \"%s\". Put it next to this script or set dataFile in section 1.', dataFile);",
    'end',
    'if ~isfolder(outDir)',
    '    mkdir(outDir);',
    'end',
    'readTimer = tic;',
    '[D, logNames] = readXPlaneLog(dataFile);   % D: one row per sample, one column per header cell',
    'nRows = size(D, 1);',
    "fprintf('Read %s: %d rows x %d columns in %.2f s.\\n', dataFile, nRows, size(D, 2), toc(readTimer));",
    `if nRows ~= ${ds.rowCount} || size(D, 2) ~= ${fileColumns}`,
    `    warning('xpp:size', ['X-Plane Plotter read ${ds.rowCount} rows x ${fileColumns} columns from its copy of ` +
      "the log; ' ...",
    "        'this file has %d x %d. Rows are checked against elapsed time below.'], nRows, size(D, 2));",
    'end',
    "% Columns by header token: col('elev1,__deg', 2) is the second column named \"elev1,__deg\" (the app's channel",
    '% id "elev1,__deg#2"; X-Plane repeats some tokens).',
    'col = @(token, occurrence) xppColumn(logNames, token, occurrence);',
  ]
}

function elapsedSection(w: ScriptWriter, ds: Dataset): string[] {
  const source = ds.timeSourceId ? channelById(ds, ds.timeSourceId) : undefined
  if (!source || source.derived || source.column < 0) {
    return [
      '% The log has no usable time column, so (like the app) the script assumes one row per second.',
      "el = (0:nRows - 1)';",
      'dtMedian = 1;',
      'segStart = 1;',
    ]
  }
  w.helpers.add('xppElapsed')
  const segments = ds.segments.length
  return [
    `% Elapsed time (s) as the app builds it, from "${commentText(source.token)}" (the app prefers sim time, then real`,
    '% time). A step backwards (sim reset, new flight) or forwards by more than max(1 s, 20 x the median step) (paused',
    '% recording) starts a new segment and counts as one median step, so the clock never jumps; a row without a time',
    `% value also counts as one median step. The app found ${segments} segment${segments === 1 ? '' : 's'} and ` +
      `${seconds(ds.elapsed[ds.rowCount - 1] ?? 0)} s in total.`,
    `[el, dtMedian, segStart] = xppElapsed(D(:, col(${matlabString(source.token)}, ${source.occurrence})));`,
    "fprintf('Elapsed time: %.3f s over %d segment(s), median step %.4g s.\\n', el(end), numel(segStart), dtMedian);",
  ]
}

function colourLines(): string[] {
  const rows = SERIES_COLORS.map((c, i) => {
    const rgb = [1, 3, 5].map((at) => String(parseInt(c.hex.slice(at, at + 2), 16)).padStart(3))
    return `    ${rgb.join(' ')}   % ${i + 1} ${c.hex} ${c.name}`
  })
  return [
    "% The app's 8 categorical colours (light theme). A test-point group keeps its colour slot everywhere.",
    'seriesColors = [',
    ...rows,
    '] / 255;',
  ]
}

/** The test points (all of them, hidden ones flagged) and their checked rows. */
function pointsDefinition(w: ScriptWriter, ws: Workspace): string[] {
  const groups = ws.groups.length ? ws.groups : [{ id: '', name: 'Test points', slot: 0 }]
  const groupIndex = new Map(groups.map((g, i) => [g.id, i + 1]))
  const points: { p: TestPoint; rows: RowsLiteral }[] = []
  for (const p of ws.points) {
    const rows = w.rows([p.start, p.end])
    if (rows) points.push({ p, rows })
  }
  w.helpers.add('xppRows')
  const width = Math.max(4, ...points.map(({ rows }) => String(rows.last).length))
  const rowLines = points.map(({ p, rows }) => {
    const cells = [rows.first, rows.last].map((v) => String(v).padStart(width)).join(' ')
    return `    ${cells}   ${seconds(rows.t0).padStart(12)} ${seconds(rows.t1).padStart(12)}   % ${commentText(p.name)}`
  })
  return [
    "% Every test point of the app, in its order. Rows are MATLAB rows (1-based, inclusive: the app's rows",
    '% [start, end) are start+1 to end) with the elapsed time the app had at the first and last row. Each window is',
    "% checked against this log's elapsed time and, if it does not match, found by elapsed time instead.",
    `groupName = ${cellColumn(groups.map((g) => g.name))};`,
    `groupSlot = ${numberColumn(groups.map((g) => Math.min(7, Math.max(0, Math.round(g.slot))) + 1))};   % row of seriesColors`,
    `pointName = ${cellColumn(points.map(({ p }) => p.name))};`,
    `pointGroup = ${numberColumn(points.map(({ p }) => groupIndex.get(p.groupId) ?? 1))};   % row of groupName`,
    `pointHidden = ${logicalColumn(points.map(({ p }) => p.hidden === true))};   % hidden in the app (not plotted)`,
    'pointWindow = [   % first row, last row, elapsed at first row (s), elapsed at last row (s)',
    ...rowLines,
    '];',
    'if isempty(pointWindow)',
    '    pointWindow = zeros(0, 4);',
    'end',
    'nPoints = numel(pointName);',
    'pointRows = cell(nPoints, 1);',
    'for iPoint = 1:nPoints',
    '    pointRows{iPoint} = xppRows(el, pointWindow(iPoint, 1), pointWindow(iPoint, 2), pointWindow(iPoint, 3), ...',
    "        pointWindow(iPoint, 4), sprintf('test point \"%s\"', pointName{iPoint}));",
    'end',
  ]
}

function pointsTable(w: ScriptWriter, ds: Dataset, ws: Workspace): string[] {
  if (!ws.points.length) {
    return [
      '% The app had no test points when this script was exported: add some in the Points tab and export again.',
      "fprintf('No test points: out/test_points.csv was not written.\\n');",
    ]
  }
  w.helpers.add('xppStats')
  const used = new Set<string>(['Point', 'Group', 'Hidden', 'FirstRow', 'LastRow', 'Start_s', 'End_s'])
  const tracked: string[] = []
  for (const id of ws.tracked) {
    const ch = channelById(ds, id)
    const expr = w.channelExpr(id)
    if (!ch || !expr) continue
    const name = identifier(channelAlias(ch), used, 63 - '_mean'.length)
    tracked.push(`    ${matlabString(name)}, ${expr}, ${matlabString(channelTitle(ch))}`)
  }
  return [
    '% One row per test point: its rows and elapsed times, then the mean, standard deviation (n - 1), min, max and',
    '% number of finite samples of each tracked channel over the point (NaN samples ignored, as in the app).',
    'tracked = {   % name in the table, values, title',
    ...tracked,
    '};',
    'if isempty(tracked)',
    '    tracked = cell(0, 3);',
    'end',
    'firstRow = NaN(nPoints, 1);',
    'lastRow = NaN(nPoints, 1);',
    'for iPoint = 1:nPoints',
    '    if ~isempty(pointRows{iPoint})',
    '        firstRow(iPoint) = pointRows{iPoint}(1);',
    '        lastRow(iPoint) = pointRows{iPoint}(end);',
    '    end',
    'end',
    'startS = NaN(nPoints, 1);',
    'endS = NaN(nPoints, 1);',
    'startS(~isnan(firstRow)) = el(firstRow(~isnan(firstRow)));',
    'endS(~isnan(lastRow)) = el(lastRow(~isnan(lastRow)));',
    'T = table(pointName, groupName(pointGroup), pointHidden, firstRow, lastRow, startS, endS, ...',
    "    'VariableNames', {'Point', 'Group', 'Hidden', 'FirstRow', 'LastRow', 'Start_s', 'End_s'});",
    "statNames = {'mean', 'std', 'min', 'max', 'n'};",
    'for iTracked = 1:size(tracked, 1)',
    '    S = NaN(nPoints, 5);',
    '    for iPoint = 1:nPoints',
    '        S(iPoint, :) = xppStats(tracked{iTracked, 2}(pointRows{iPoint}));',
    '    end',
    '    for iStat = 1:5',
    "        T.([tracked{iTracked, 1} '_' statNames{iStat}]) = S(:, iStat);",
    '    end',
    'end',
    "% For spreadsheets, a name starting with = + - @ (or a tab or carriage return) gets a leading ' so that Excel",
    "% never runs it as a formula, as in the app's own CSV files. T itself keeps the names as they are.",
    'csvT = T;',
    "defuse = @(names) regexprep(names, '^([=+\\-@\\t\\r])', '''$1');",
    'csvT.Point = defuse(csvT.Point);',
    'csvT.Group = defuse(csvT.Group);',
    "writetable(csvT, fullfile(outDir, 'test_points.csv'));",
    "fprintf('\\nTest points -> %s\\n', fullfile(outDir, 'test_points.csv'));",
    'for iTracked = 1:size(tracked, 1)',
    "    fprintf('  %-28s %s\\n', tracked{iTracked, 1}, tracked{iTracked, 3});",
    'end',
    'disp(T);',
  ]
}

function xySection(w: ScriptWriter, ds: Dataset, ws: Workspace, opts: MatlabExportOptions, doXY: boolean): Section {
  const config = ws.xy
  if (!doXY) {
    return skipped(
      'No X-Y plot: the app had no X channel or no Y channel chosen (X-Y tab) when this script was exported.',
      'X-Y plot skipped: no X or Y channel was chosen in the app.',
    )
  }
  const ys = config.ys
    .map((id) => ({ ch: channelById(ds, id), expr: w.channelExpr(id) }))
    .filter((y): y is { ch: Channel; expr: string } => !!y.ch && y.expr !== null)
    .slice(0, SERIES_COLORS.length)
  const xExpr = w.channelExpr(config.x) ?? 'NaN(nRows, 1)'
  const usePoints = config.source === 'points' && ws.points.length > 0
  const source = usePoints ? 'points' : config.source === 'points' ? 'all' : config.source
  const viewRows = opts.view ? w.rows(opts.view) : null
  const degree = { none: 0, linear: 1, poly2: 2, poly3: 3 }[config.fit]
  const xLabel = config.xLabel.trim() || titleOf(ds, config.x)
  const yLabel = config.yLabel.trim() || sharedLabel(ys.map((y) => y.ch))
  for (const helper of ['xppFigure', 'xppExport', 'xppSamples', 'xppPolyFit', 'xppStats', 'xppOnAxes', 'xppDrawFit']) {
    w.helpers.add(helper)
  }

  // Defined whatever the source, so xy.source can be switched in MATLAB.
  const viewLine = viewRows
    ? `xy.viewRows = ${w.rowsCall(viewRows, "the app's zoom range")};   % ${describeRows(viewRows)}`
    : "xy.viewRows = (1:nRows)';     % the app's zoom range: it showed the whole log"

  const lines = [
    "% Settings from the app's X-Y tab (edit them and re-run to change the figure).",
    ...(config.source === 'points' && !usePoints
      ? ['% (The app plotted test points, but there were none when this script was exported: all rows are used.)']
      : []),
    'xy = struct();',
    `xy.x = ${xExpr};   % ${commentText(titleOf(ds, config.x))}`,
    'xy.y = {   % up to 8 channels on one shared y axis',
    ...ys.map((y) => `    ${y.expr}   % ${commentText(channelTitle(y.ch))}`),
    '};',
    `xy.yName = ${cellColumn(ys.map((y) => channelTitle(y.ch)))};`,
    `xy.xLabel = ${matlabString(xLabel)};`,
    `xy.yLabel = ${matlabString(yLabel)};`,
    `xy.title = ${matlabString(config.title.trim())};`,
    setting(`xy.source = '${source}';`, "rows: 'all' (whole log), 'view' (xy.viewRows), 'points' (visible test points)"),
    setting(
      `xy.useGroup = ${logicalColumn(xyGroupsUsed(ws))};`,
      "with 'points': which test-point groups to plot (one per row of groupName)",
    ),
    viewLine,
    setting(`xy.style = '${config.style}';`, "samples as 'points', 'lines' or 'both'"),
    setting(`xy.colorBy = '${config.colorBy}';`, "colour: 'series' (per y channel), 'group' (per test-point group) or 'time'"),
    setting(`xy.showSamples = ${config.showSamples};`, 'the raw samples'),
    setting(`xy.showMeans = ${config.showMeans};`, 'mean +/- 1 standard deviation of each visible test point'),
    setting(
      `xy.fitDegree = ${degree};`,
      'polynomial fit: 0 none, 1 linear, 2 quadratic, 3 cubic (one per colour: per group or per y channel)',
    ),
    setting(`xy.fitTarget = '${config.fitTarget}';`, "fit through the test-point 'means' or the raw 'samples'"),
    setting(`xy.xLimits = ${limitsLiteral(opts.xyLimits?.x)};`, 'x axis range the app showed ([] = automatic)'),
    setting(
      `xy.yLimits = ${limitsLiteral(opts.xyLimits?.y)};`,
      'y axis range; a fit through the samples uses those inside both',
    ),
    ...XY_CODE,
  ]
  return { lines, figure: true }
}

/** An axis range as a MATLAB row [lo hi], or [] (automatic) when there is none. */
function limitsLiteral(range: readonly [number, number] | null | undefined): string {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || !(range[1] > range[0])) return '[]'
  return `[${num(range[0])} ${num(range[1])}]`
}

/** Per group, in the order pointsDefinition writes groupName: plotted by the X–Y figure (XYConfig.groups). */
function xyGroupsUsed(ws: Workspace): boolean[] {
  const groups = ws.groups.length ? ws.groups : [{ id: '' }]
  const chosen = ws.xy.groups?.length ? new Set(ws.xy.groups) : null
  return groups.map((g) => !chosen || chosen.has(g.id))
}

/** Generic X–Y plotting code (uses the xy settings above, the test points and seriesColors). */
const XY_CODE = [
  '',
  "fig = xppFigure(showFigures, 'X-Y plot', [16 11]);",
  'ax = axes(fig);',
  "hold(ax, 'on');",
  "grid(ax, 'on');",
  "box(ax, 'on');",
  "markers = 'osd^v<>p';   % one marker shape per y channel",
  'fitLog = {};             % fit equations, printed below',
  "if strcmp(xy.source, 'points')",
  "    % As in the app, one colour (and one fit) per plotted group when colouring by group; otherwise one per y channel",
  "    % with the points of every plotted group pooled.",
  '    plotted = reshape(find(xy.useGroup), 1, []);',
  "    if strcmp(xy.colorBy, 'group')",
  '        units = num2cell(plotted);',
  '    else',
  '        units = {plotted};',
  '    end',
  '    for iY = 1:numel(xy.y)',
  '        for iUnit = 1:numel(units)',
  '            members = find(ismember(pointGroup, units{iUnit}) & ~pointHidden);',
  '            members = members(~cellfun(@isempty, pointRows(members)));',
  '            if isempty(members)',
  '                continue',
  '            end',
  "            if strcmp(xy.colorBy, 'group')",
  '                color = seriesColors(groupSlot(units{iUnit}), :);',
  '                label = groupName{units{iUnit}};',
  '                if numel(xy.y) > 1',
  "                    label = sprintf('%s - %s', label, xy.yName{iY});",
  '                end',
  '            else',
  '                color = seriesColors(iY, :);',
  '                label = xy.yName{iY};',
  '            end',
  '            rows = unique(vertcat(pointRows{members}));   % a row two points share counts once, as in the app',
  '            if xy.showSamples',
  '                % Coloured by series the samples carry the legend; otherwise the mean markers do, unless hidden.',
  '                xppSamples(ax, xy.x, xy.y{iY}, rows, xy.style, xy.colorBy, color, el, label, ...',
  "                    strcmp(xy.colorBy, 'series') || (~xy.showMeans && strcmp(xy.colorBy, 'group')));",
  '            end',
  '            M = NaN(numel(members), 4);   % x mean, x std, y mean, y std',
  '            for iMember = 1:numel(members)',
  '                sx = xppStats(xy.x(pointRows{members(iMember)}));',
  '                sy = xppStats(xy.y{iY}(pointRows{members(iMember)}));',
  '                M(iMember, :) = [sx(1), sx(2), sy(1), sy(2)];',
  '            end',
  '            if xy.showMeans',
  '                errorbar(ax, M(:, 1), M(:, 3), M(:, 4), M(:, 4), M(:, 2), M(:, 2), markers(iY), ...',
  "                    'Color', color, 'MarkerFaceColor', color, 'MarkerSize', 7, 'LineStyle', 'none', ...",
  "                    'CapSize', 4, 'LineWidth', 1, 'DisplayName', [label ' (mean ' char(177) ' 1' char(963) ')']);",
  '            end',
  '            if xy.fitDegree > 0',
  "                if strcmp(xy.fitTarget, 'means')",
  '                    [xs, ys, equation] = xppPolyFit(M(:, 1), M(:, 3), xy.fitDegree);',
  '                    outside = 0;',
  '                else',
  '                    [fitRows, outside] = xppOnAxes(xy.x, xy.y{iY}, rows, xy.xLimits, xy.yLimits);',
  '                    [xs, ys, equation] = xppPolyFit(xy.x(fitRows), xy.y{iY}(fitRows), xy.fitDegree);',
  '                end',
  '                fitLog = xppDrawFit(ax, xs, ys, equation, label, color, outside, fitLog);',
  '            end',
  '        end',
  '    end',
  'else',
  "    rows = (1:nRows)';",
  "    if strcmp(xy.source, 'view')",
  '        rows = xy.viewRows;',
  '    end',
  '    for iY = 1:numel(xy.y)',
  '        color = seriesColors(iY, :);',
  '        if xy.showSamples',
  "            xppSamples(ax, xy.x, xy.y{iY}, rows, xy.style, xy.colorBy, color, el, xy.yName{iY}, ...",
  "                ~strcmp(xy.colorBy, 'time'));",
  '        end',
  '        if xy.fitDegree > 0',
  '            [fitRows, outside] = xppOnAxes(xy.x, xy.y{iY}, rows, xy.xLimits, xy.yLimits);',
  '            [xs, ys, equation] = xppPolyFit(xy.x(fitRows), xy.y{iY}(fitRows), xy.fitDegree);',
  '            fitLog = xppDrawFit(ax, xs, ys, equation, xy.yName{iY}, 0.6 * color, outside, fitLog);',
  '        end',
  '    end',
  'end',
  '% The axis ranges the app showed: it leaves a few absurd samples (CL on the ground) off the axes.',
  'if ~isempty(xy.xLimits)',
  '    xlim(ax, xy.xLimits);',
  'end',
  'if ~isempty(xy.yLimits)',
  '    ylim(ax, xy.yLimits);',
  'end',
  "if strcmp(xy.colorBy, 'time') && xy.showSamples",
  '    timeBar = colorbar(ax);',
  "    timeBar.Label.String = 'Elapsed time [s]';",
  'end',
  "xlabel(ax, xy.xLabel, 'Interpreter', 'none');",
  "ylabel(ax, xy.yLabel, 'Interpreter', 'none');",
  'if ~isempty(xy.title)',
  "    title(ax, xy.title, 'Interpreter', 'none');",
  'end',
  "legend(ax, 'Location', 'best', 'Interpreter', 'none');",
  'if ~isempty(fitLog)',
  "    fprintf('X-Y fits:\\n');",
  "    fprintf('  %s\\n', fitLog{:});",
  'end',
  "xppExport(fig, fullfile(outDir, 'xy'), showFigures);",
]

function timeSection(w: ScriptWriter, ds: Dataset, ws: Workspace, opts: MatlabExportOptions): Section {
  const panels = ws.panels
    .map((panel) => {
      const channels = panel.channelIds
        .map((id) => ({ ch: channelById(ds, id), expr: w.channelExpr(id) }))
        .filter((c): c is { ch: Channel; expr: string } => !!c.ch && c.expr !== null)
        .slice(0, SERIES_COLORS.length)
      return { channels, yZero: panel.yZero === true }
    })
    .filter((p) => p.channels.length > 0)
  if (!panels.length) {
    return skipped(
      'No time histories: the app had no panels with channels (Time history tab) when this script was exported.',
      'Time histories skipped: no panels.',
    )
  }
  for (const helper of ['xppFigure', 'xppExport']) w.helpers.add(helper)
  const viewRows = opts.view ? w.rows(opts.view) : null
  const axis = timeAxis(w, ds, ws)
  const lines = [
    "% The app's stacked panels (one y axis per panel, shared x axis) over its zoom range.",
    viewRows
      ? `thRows = ${w.rowsCall(viewRows, "the app's zoom range")};   % ${describeRows(viewRows)}`
      : "thRows = (1:nRows)';   % the app showed the whole log",
    `thX = ${axis.expr};`,
    `thXLabel = ${matlabString(axis.label)};`,
    'panelValues = {   % one cell per panel',
    ...panels.map((p) => `    {${p.channels.map((c) => c.expr).join(', ')}}`),
    '};',
    'panelNames = {',
    ...panels.map((p) => `    {${p.channels.map((c) => matlabString(channelTitle(c.ch))).join(', ')}}`),
    '};',
    `panelYLabel = ${cellColumn(panels.map((p) => sharedLabel(p.channels.map((c) => c.ch))))};`,
    `panelYZero = ${logicalColumn(panels.map((p) => p.yZero))};   % force the y axis to include zero`,
    '',
    'nPanels = numel(panelValues);',
    "fig = xppFigure(showFigures, 'Time histories', [16, 2 + 4 * nPanels]);",
    "layout = tiledlayout(fig, nPanels, 1, 'TileSpacing', 'compact', 'Padding', 'compact');",
    'axs = gobjects(nPanels, 1);',
    'for iPanel = 1:nPanels',
    '    ax = nexttile(layout);',
    "    hold(ax, 'on');",
    "    grid(ax, 'on');",
    "    box(ax, 'on');",
    '    for iLine = 1:numel(panelValues{iPanel})',
    "        plot(ax, thX(thRows), panelValues{iPanel}{iLine}(thRows), '-', 'Color', seriesColors(iLine, :), ...",
    "            'LineWidth', 1.25, 'DisplayName', panelNames{iPanel}{iLine});",
    '    end',
    '    % Dotted lines where the app starts a new segment (sim reset or recording gap).',
    '    for segRow = reshape(segStart(2:end), 1, [])   % row vector: no pass when there is one segment',
    '        if segRow > thRows(1) && segRow <= thRows(end)',
    "            xline(ax, thX(segRow), ':', 'Color', [0.45 0.45 0.45], 'HandleVisibility', 'off');",
    '        end',
    '    end',
    "    ylabel(ax, panelYLabel{iPanel}, 'Interpreter', 'none');",
    '    if panelYZero(iPanel)',
    '        limits = ylim(ax);',
    '        ylim(ax, [min(limits(1), 0), max(limits(2), 0)]);',
    '    end',
    "    legend(ax, 'Location', 'best', 'Interpreter', 'none');",
    '    axs(iPanel) = ax;',
    'end',
    "linkaxes(axs, 'x');",
    'if thX(thRows(end)) > thX(thRows(1))',
    '    xlim(axs(1), [thX(thRows(1)), thX(thRows(end))]);',
    'end',
    "xlabel(axs(end), thXLabel, 'Interpreter', 'none');",
    "xppExport(fig, fullfile(outDir, 'time_history'), showFigures);",
  ]
  return { lines, figure: true }
}

/** The time-history x axis: the workspace's time base (elapsed time, row number or a raw time channel). */
function timeAxis(w: ScriptWriter, ds: Dataset, ws: Workspace): { expr: string; label: string } {
  if (ws.timeBase === 'index') return { expr: "(0:nRows - 1)'", label: 'Row (0-based, as in the app)' }
  if (ws.timeBase.startsWith('ch:')) {
    const id = ws.timeBase.slice(3)
    const expr = w.channelExpr(id)
    const ch = channelById(ds, id)
    if (expr && ch) return { expr, label: channelTitle(ch) }
  }
  return { expr: 'el', label: 'Elapsed time [s]' }
}

function modeSection(
  w: ScriptWriter,
  ds: Dataset,
  ws: Workspace,
  opts: MatlabExportOptions,
  point: TestPoint | undefined,
): Section {
  const modes = ws.modes
  const ch = modes.channelId ? channelById(ds, modes.channelId) : undefined
  const expr = w.channelExpr(modes.channelId)
  if (!ch || !expr) {
    return skipped(
      'No mode fit: the app had no channel chosen in the Modes tab when this script was exported.',
      'Mode fit skipped: no channel chosen.',
    )
  }
  let range: RowRange | null
  let what: string
  if (modes.source.startsWith('point:')) {
    range = point ? [point.start, point.end] : null
    what = point ? `test point "${point.name}"` : 'the chosen test point'
  } else {
    // No zoom range means the whole log; no selection means there is nothing to fit.
    range = opts.modeRows ?? (modes.source === 'view' ? [0, ds.rowCount] : null)
    what = modes.source === 'view' ? "the app's zoom range" : "the app's selection"
  }
  const rows = range ? w.rows(range) : null
  if (!rows) {
    return skipped(
      `No mode fit: ${modes.source.startsWith('point:') ? 'its test point no longer exists' : 'no rows were selected'} ` +
        'when this script was exported.',
      'Mode fit skipped: no rows.',
    )
  }
  // Both fits are included, so modeCfg.model can be switched in MATLAB.
  for (const helper of ['xppFigure', 'xppExport', 'xppFitOscillation', 'xppFitFirstOrder', 'xppModeReport']) {
    w.helpers.add(helper)
  }
  const lines = [
    "% The model the app fits (Modes tab), with fminsearch: the nonlinear parameters are searched and the others are",
    '% solved by linear least squares at every step.',
    '%   oscillation: y = A exp(-sigma tau) cos(wd tau + phi) + c + b tau,  tau = t - t0  (b = 0 unless detrend is',
    "%                'linear'); first guesses from zero crossings (period) and the logarithmic decrement (damping)",
    '%   first-order: y = c + A exp(-tau / T); first guess from the time to cover 63% of the change',
    'modeCfg = struct();',
    `modeCfg.name = ${matlabString(channelTitle(ch))};`,
    `modeCfg.values = ${expr};`,
    setting(`modeCfg.model = '${modes.model}';`, "'oscillation' or 'first-order'"),
    setting(`modeCfg.detrend = '${modes.detrend}';`, "'linear' adds the slope b (oscillation only)"),
    `modeCfg.rows = ${w.rowsCall(rows, what)};   % ${commentText(what)}: ${describeRows(rows)}`,
    'tm = el(modeCfg.rows);',
    'ym = modeCfg.values(modeCfg.rows);',
    'keep = isfinite(tm) & isfinite(ym);',
    'tm = tm(keep);',
    'ym = ym(keep);',
    "if strcmp(modeCfg.model, 'oscillation')",
    "    modeFit = xppFitOscillation(tm, ym, strcmp(modeCfg.detrend, 'linear'));",
    'else',
    '    modeFit = xppFitFirstOrder(tm, ym);',
    'end',
    'report = xppModeReport(modeFit, modeCfg.name, modeCfg.rows, tm);',
    "fprintf('\\n%s\\n', report{:});",
    "reportFile = fopen(fullfile(outDir, 'mode_fit.txt'), 'w');",
    "fprintf(reportFile, '%s\\n', report{:});",
    'fclose(reportFile);',
    '',
    "fig = xppFigure(showFigures, 'Mode fit', [16 9]);",
    'ax = axes(fig);',
    "hold(ax, 'on');",
    "grid(ax, 'on');",
    "box(ax, 'on');",
    "plot(ax, tm, ym, '.', 'Color', seriesColors(1, :), 'MarkerSize', 8, 'DisplayName', modeCfg.name);",
    'if ~isempty(modeFit.fitted)',
    "    plot(ax, tm, modeFit.fitted, '-', 'Color', seriesColors(2, :), 'LineWidth', 1.5, 'DisplayName', 'fit');",
    'end',
    "if strcmp(modeFit.model, 'oscillation') && isfinite(modeFit.A)",
    '    tau = tm - modeFit.t0;',
    '    trend = modeFit.c + modeFit.b * tau;',
    '    swing = modeFit.A * exp(-modeFit.sigma * tau);   % the decaying amplitude',
    "    plot(ax, tm, trend + swing, '--', 'Color', [0.45 0.45 0.45], 'DisplayName', 'envelope');",
    "    plot(ax, tm, trend - swing, '--', 'Color', [0.45 0.45 0.45], 'HandleVisibility', 'off');",
    'end',
    "xlabel(ax, 'Elapsed time [s]');",
    "ylabel(ax, modeCfg.name, 'Interpreter', 'none');",
    "title(ax, report{2}, 'Interpreter', 'none', 'FontWeight', 'normal');",
    "legend(ax, 'Location', 'best', 'Interpreter', 'none');",
    "xppExport(fig, fullfile(outDir, 'mode_fit'), showFigures);",
  ]
  return { lines, figure: true }
}
