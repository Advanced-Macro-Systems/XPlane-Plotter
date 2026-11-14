import { describe, expect, it } from 'vitest'
import { allGroups, loggingGuide, recordingSteps } from '.'

describe('recordingSteps', () => {
  it('walks through the X-Plane 12 Data Output screen, the disk rate and where Data.txt is written', () => {
    const steps = recordingSteps()
    expect(steps.length).toBeGreaterThanOrEqual(4)
    for (const step of steps) expect(step.trim()).not.toBe('')
    const text = steps.join(' ')
    for (const phrase of ['Settings', 'Data Output', 'General Data Output', 'Disk (data.txt File)', 'Disk Rate', 'Quit X-Plane', 'X-Plane 12 folder'])
      expect(text).toContain(phrase)
    // The landing page shows the first four steps: they must take the user from the menu to the file.
    const first = steps.slice(0, 4).join(' ')
    for (const phrase of ['Data Output', 'Disk (data.txt File)', 'Disk Rate', 'Data.txt']) expect(first).toContain(phrase)
  })
})

describe('loggingGuide', () => {
  const guide = loggingGuide()
  // Only real Data Output rows: "Formulas" and "Other" are app groups, and "Other" is what an unknown id would give.
  const rows = allGroups().filter((g) => g.id !== 'derived' && g.id !== 'other')

  it('names only rows the dictionary has', () => {
    expect(() => loggingGuide()).not.toThrow()
    for (const row of guide.flatMap((rec) => rec.rows)) {
      expect(row.name).not.toBe('Other')
      expect(row.name).not.toBe('Formulas')
      expect(row.index, row.name).not.toBeUndefined()
    }
  })

  it('recommends rows for each kind of flight test', () => {
    const titles = guide.map((rec) => rec.title).join(' | ')
    for (const kind of [/core/i, /performance.*range.*endurance/i, /static stability.*trim/i, /dynamic/i, /propulsion/i])
      expect(titles).toMatch(kind)
    for (const rec of guide) {
      expect(rec.summary.trim()).not.toBe('')
      expect(rec.rows.length).toBeGreaterThan(3)
      expect(new Set(rec.rows.map((row) => row.name)).size).toBe(rec.rows.length)
      for (const row of rec.rows) {
        expect(row.why.trim()).not.toBe('')
        // Name and index are the X-Plane 12 row's own.
        const group = rows.find((g) => g.name === row.name)
        expect(group, row.name).toBeDefined()
        expect(row.index).toBe(group?.index)
      }
      expect(rec.rows.filter((row) => typeof row.index === 'number').length).toBeGreaterThan(rec.rows.length / 2)
    }
  })

  it('uses the X-Plane 12 row numbers', () => {
    const index = (name: string) => guide.flatMap((rec) => rec.rows).find((row) => row.name === name)?.index
    expect(index('Times')).toBe(1)
    expect(index('Speeds')).toBe(3)
    expect(index('Weight and balance')).toBe(63)
    expect(index('Angular velocities')).toBe(16)
    expect(index('Angular accelerations')).toBe(167)
    expect(index('Lift over drag and coefficients')).toBe(68)
    expect(index('SFC (lb/hp-hr or lb/lb-hr)')).toBeNull()
  })
})
