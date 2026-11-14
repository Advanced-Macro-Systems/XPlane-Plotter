import { describe, expect, it } from 'vitest'
import { withDerived } from '../../core/analysis/derived'
import { fileChannel, makeDataset } from '../../core/export/testFixtures'
import type { DerivedDef } from '../../core/types'
import {
  FORMULA_HELP,
  aliasEntries,
  caretLocation,
  checkFormula,
  formulaDependents,
  formulaSlug,
  formulasBefore,
  insertCompletion,
  predictFormulaId,
  suggestAliases,
  suggestHelp,
  wordAtCaret,
} from './formulaCheck'

function dataset() {
  return makeDataset(
    [
      fileChannel('_Vind,_kias', 1, 0, [100, 110, 120, 130], 'KIAS', 'kt'),
      fileChannel('Vtrue,_ktas', 1, 1, [120, 130, 140, 150], 'KTAS', 'kt'),
      fileChannel('elev1,__deg', 1, 2, [1, 2, 3, 4], 'Elevator', 'deg'),
      fileChannel('elev1,__deg', 2, 3, [-1, -2, -3, -4], 'Elevator (2)', 'deg'),
      fileChannel('empty,___lb', 1, 4, [9000, 9000, 9000, 9000], 'Empty weight', 'lb'),
    ],
    [0, 1, 2, 3],
  )
}

const def = (slug: string, expression: string, name = slug): DerivedDef => ({ id: `fx:${slug}`, name, unit: '', expression })

describe('checkFormula', () => {
  const ds = dataset()

  it('says nothing for an empty expression', () => {
    expect(checkFormula(ds, [], '   ')).toEqual({ status: 'empty' })
  })

  it('evaluates a good formula for the preview', () => {
    const check = checkFormula(ds, [], 'Vtrue_ktas - Vind_kias')
    expect(check.status).toBe('ok')
    if (check.status !== 'ok') return
    expect(Array.from(check.values)).toEqual([20, 20, 20, 20])
    expect(check.stats).toMatchObject({ min: 20, max: 20, constant: true, finite: 4 })
    expect(check.refs).toEqual(['Vtrue_ktas', 'Vind_kias'])
  })

  it('points at syntax errors', () => {
    const check = checkFormula(ds, [], 'Vind_kias * (2 + ')
    expect(check).toMatchObject({ status: 'error', phase: 'syntax' })
    if (check.status !== 'error') return
    expect(check.position).toBe(17)
  })

  it('points at unknown functions', () => {
    const check = checkFormula(ds, [], '2 * sqroot(Vind_kias)')
    expect(check).toMatchObject({ status: 'error', phase: 'syntax', position: 4 })
  })

  it('suggests the channel meant by a misspelt name', () => {
    const check = checkFormula(ds, [], '1 + Vind_kas')
    expect(check).toMatchObject({ status: 'error', phase: 'evaluate', position: 4 })
    if (check.status !== 'error') return
    expect(check.message).toContain('Vind_kas')
    expect(check.message).toContain('Did you mean Vind_kias?')
  })

  it('sees earlier formulas but not later ones', () => {
    const defs = [def('a', 'Vind_kias * 2'), def('b', 'a + 1')]
    const base = withDerived(ds, defs.slice(0, 1)).dataset
    expect(checkFormula(ds, defs.slice(0, 1), 'a / 2', base).status).toBe('ok')
    expect(checkFormula(ds, [], 'a / 2').status).toBe('error')
  })
})

describe('formulasBefore', () => {
  const defs = [def('a', '1'), def('b', '2'), def('c', '3')]
  it('gives every formula for a new one and the earlier ones when editing', () => {
    expect(formulasBefore(defs, null)).toHaveLength(3)
    expect(formulasBefore(defs, 'fx:b').map((d) => d.id)).toEqual(['fx:a'])
    expect(formulasBefore(defs, 'fx:a')).toEqual([])
    expect(formulasBefore(defs, 'fx:gone')).toHaveLength(3)
  })
})

describe('caret helpers', () => {
  it('finds the line and column of a position', () => {
    expect(caretLocation('a + b\nc * (d', 11)).toEqual({ line: 2, column: 5, lineText: 'c * (d' })
    expect(caretLocation('abc', 99)).toEqual({ line: 1, column: 3, lineText: 'abc' })
  })

  it('finds the identifier being typed', () => {
    expect(wordAtCaret('2 * Vtr', 7)).toEqual({ prefix: 'Vtr', start: 4, end: 7 })
    expect(wordAtCaret('Vtrue_ktas + 1', 3)).toEqual({ prefix: 'Vtr', start: 0, end: 10 })
    expect(wordAtCaret('2 * ', 4).prefix).toBe('')
    // Not inside a [raw token] or a number.
    expect(wordAtCaret('[_Vind,_kia', 11).prefix).toBe('')
    expect(wordAtCaret('1e3', 3).prefix).toBe('')
  })

  it('replaces the identifier being typed with a completion', () => {
    expect(insertCompletion('2 * Vtr', 7, 'Vtrue_ktas')).toEqual({ text: '2 * Vtrue_ktas', caret: 14 })
    expect(insertCompletion('2 * Vtr + 1', 6, 'Vtrue_ktas')).toEqual({ text: '2 * Vtrue_ktas + 1', caret: 14 })
    expect(insertCompletion('x + ', 4, 'sqrt()', 5)).toEqual({ text: 'x + sqrt()', caret: 9 })
  })
})

describe('completions', () => {
  const entries = aliasEntries(dataset().channels)

  it('offers each channel’s formula name once', () => {
    expect(entries.map((e) => e.alias)).toEqual(['Vind_kias', 'Vtrue_ktas', 'elev1_deg', 'elev1_deg_2', 'empty_lb'])
  })

  it('ranks names starting with the prefix first, then containing it, then label matches', () => {
    expect(suggestAliases(entries, 'v').map((e) => e.alias)).toEqual(['Vind_kias', 'Vtrue_ktas', 'elev1_deg', 'elev1_deg_2'])
    expect(suggestAliases(entries, 'elevator').map((e) => e.alias)).toEqual(['elev1_deg', 'elev1_deg_2'])
    expect(suggestAliases(entries, 'zzz')).toEqual([])
  })

  it('lists varying channels before constant ones when nothing is typed', () => {
    expect(suggestAliases(entries, '').at(-1)?.alias).toBe('empty_lb')
    expect(suggestAliases(entries, '', 2)).toHaveLength(2)
  })

  it('filters functions and constants', () => {
    const functions = FORMULA_HELP.functions
    expect(suggestHelp(functions, 'sq').map((e) => e.name)).toEqual(['sqrt'])
    expect(suggestHelp(functions, '').length).toBe(functions.length)
    expect(suggestHelp(FORMULA_HELP.constants, 'g0').map((e) => e.name)).toEqual(['g0'])
  })
})

describe('saving', () => {
  const ds = withDerived(dataset(), [def('q', 'Vind_kias * 2', 'q')]).dataset

  it('chooses the slug', () => {
    const editing = def('dyn_p', 'Vind_kias', 'Dyn p')
    expect(formulaSlug('Dynamic pressure', null, null)).toBe('dynamic_pressure')
    expect(formulaSlug('Dynamic pressure', null, 'dynamic_pressure_pa')).toBe('dynamic_pressure_pa')
    expect(formulaSlug('Dyn p', editing, null)).toBe('dyn_p')
    expect(formulaSlug('Renamed', editing, null)).toBe('renamed')
    expect(formulaSlug('Renamed', editing, null, true)).toBe('dyn_p')
  })

  it('predicts the id saveDerived gives', () => {
    expect(predictFormulaId(ds, 'lift', null)).toBe('fx:lift')
    expect(predictFormulaId(ds, 'q', null)).toBe('fx:q_2')
    expect(predictFormulaId(ds, 'q', 'fx:q')).toBe('fx:q')
  })

  it('finds the formulas that depend on one, through chains and [id] references', () => {
    const defs = [
      def('a', 'Vind_kias * 2'),
      def('b', 'a + 1'),
      def('c', 'Vtrue_ktas'),
      def('d', 'b * 2'),
      def('e', '[fx:a] - 1'),
      def('f', 'broken +'),
    ]
    expect(formulaDependents(defs, 'fx:a').map((d) => d.id)).toEqual(['fx:b', 'fx:d', 'fx:e'])
    expect(formulaDependents(defs, 'fx:c')).toEqual([])
    expect(formulaDependents(defs, 'fx:missing')).toEqual([])
  })
})
