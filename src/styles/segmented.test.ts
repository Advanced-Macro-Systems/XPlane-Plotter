import { describe, expect, it } from 'vitest'

/** styles/global.css as text (Vitest blanks CSS imports; read through Node's builtin-module loader, as theme.test does). */
function readGlobalCss(): string {
  type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
  type NodeProcess = { getBuiltinModule?: (id: string) => unknown }
  const nodeProcess = (globalThis as unknown as { process?: NodeProcess }).process
  const fs = nodeProcess?.getBuiltinModule?.('node:fs') as Fs | undefined
  if (!fs) throw new Error('These tests need Node 20.16 or later (process.getBuiltinModule)')
  return fs.readFileSync(new URL('./global.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The custom properties of the block that opens with `opening`. */
function tokens(css: string, opening: string): Map<string, string> {
  const start = css.indexOf(opening)
  expect(start).toBeGreaterThanOrEqual(0)
  const block = css.slice(start, css.indexOf('\n}', start))
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

/** The declarations of the rule whose selector list is exactly `selector` (whitespace-insensitive). */
function rule(css: string, selector: string): Map<string, string> {
  const want = selector.replace(/\s+/g, ' ').trim()
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].replace(/\s+/g, ' ').trim() !== want) continue
    return new Map([...match[2].matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
  }
  throw new Error(`no rule ${selector}`)
}

describe('a disabled segmented control', () => {
  const css = readGlobalCss()
  const light = tokens(css, ':root {')
  const dark = tokens(css, ":root[data-theme='dark'] {")

  it('has its own tokens in both themes, never the "on" colours (no lit cyan in dark)', () => {
    for (const name of ['--segment-off', '--segment-off-text', '--segment-off-shadow']) {
      expect(light.has(name), name).toBe(true)
      expect(dark.has(name), name).toBe(true)
      const on = name.replace('-off', '-on')
      expect(dark.get(name), name).not.toBe(dark.get(on))
      expect(dark.get(name), name).not.toMatch(/34, 195, 238|--accent|--info|--segment-on/)
    }
    // Made of the theme's own tokens, not new hard-coded colours.
    for (const name of ['--segment-off', '--segment-off-text', '--segment-off-shadow']) {
      expect(light.get(name)).toMatch(/var\(--/)
      expect(dark.get(name)).toMatch(/var\(--/)
    }
  })

  it('shows its choice as a flat neutral pill and its other options muted, without hover', () => {
    const chosen = rule(
      css,
      ".segmented-option[aria-pressed='true']:disabled, .segmented-option[aria-checked='true']:disabled",
    )
    expect(chosen.get('background')).toBe('var(--segment-off)')
    expect(chosen.get('color')).toBe('var(--segment-off-text)')
    expect(chosen.get('box-shadow')).toBe('var(--segment-off-shadow)')
    const off = rule(css, '.segmented-option:disabled')
    expect(off.get('color')).toBe('var(--text-subtle)')
    expect(off.get('cursor')).toBe('not-allowed')
    // The disabled rules come after the "on" rule, so they win at equal specificity; hover leaves disabled ones alone.
    expect(css.indexOf(".segmented-option[aria-checked='true']:disabled")).toBeGreaterThan(
      css.indexOf(".segmented-option[aria-checked='true'] {"),
    )
    expect(rule(css, '.segmented-option:hover:not(:disabled)').get('color')).toBe('var(--text)')
  })
})
