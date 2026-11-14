import { describe, expect, it } from 'vitest'
import { boxRanges, hitTest, meanTooltipHtml, nearestMean, nearestSample, pixelBox, sampleTooltipHtml } from './xyHover'

/** Samples interleaved x, y, t, row. */
function samples(points: number[][]): { data: Float32Array } {
  const data = new Float32Array(points.length * 4)
  points.forEach(([x, y], i) => data.set([x, y, i, i], i * 4))
  return { data }
}

const stats = (mean: number, std = 0) => ({ n: 3, mean, std, min: mean, max: mean, rms: mean })

describe('nearestSample', () => {
  // 1 data unit = 10 px in x, 2 px in y (pixels grow downwards)
  const scale = { x: 0, y: 0, ux: 0.1, uy: -0.5 }

  it('finds the nearest sample in screen distance', () => {
    const series = [samples([[1, 0], [0, 4]]), samples([[0.5, 1]])]
    // distances: (10, 0) = 10 px; (0, −8) = 8 px; (5, −2) ≈ 5.4 px
    expect(nearestSample(series, scale)).toMatchObject({ series: 1, index: 0 })
    expect(nearestSample(series, scale)?.dx).toBeCloseTo(5)
    expect(nearestSample(series, scale)?.dy).toBeCloseTo(-2)
  })

  it('ignores samples beyond the reach', () => {
    expect(nearestSample([samples([[3, 0]])], scale)).toBeNull() // 30 px
    expect(nearestSample([samples([[3, 0]])], scale, 40)).toMatchObject({ index: 0 })
  })

  it('needs a usable scale', () => {
    expect(nearestSample([samples([[0, 0]])], { x: 0, y: 0, ux: 0, uy: 1 })).toBeNull()
    expect(nearestSample([samples([[0, 0]])], { x: NaN, y: 0, ux: 1, uy: 1 })).toBeNull()
  })
})

describe('hitTest', () => {
  const scale = { x: 0, y: 0, ux: 0.1, uy: -0.1 }
  const data = { series: [samples([[0.05, 0]])], means: [{ x: stats(0.5), yStats: stats(0) }] }

  it('prefers a mean marker over the samples under it', () => {
    expect(hitTest(data, scale, { samples: true, means: true })).toMatchObject({ kind: 'mean', mean: 0 })
    expect(hitTest(data, scale, { samples: true, means: false })).toMatchObject({ kind: 'sample', index: 0 })
    expect(nearestMean(data.means, scale, 4)).toBeNull()
  })
})

describe('zoom box', () => {
  it('spans two pointer positions in any order', () => {
    expect(pixelBox([50, 40], [10, 100])).toEqual({ left: 10, top: 40, width: 40, height: 60 })
    expect(pixelBox([10, 10], [12, 80])).toBeNull()
  })

  it('turns two data corners into sorted axis ranges', () => {
    expect(boxRanges([5, -1], [2, 3])).toEqual({ x: [2, 5], y: [-1, 3] })
    expect(boxRanges([5, 1], [5, 3])).toBeNull()
    expect(boxRanges([NaN, 1], [5, 3])).toBeNull()
  })
})

describe('tooltips', () => {
  it('escapes names from the file', () => {
    const html = sampleTooltipHtml({
      color: '#2a78d6',
      series: '<b>KIAS</b>',
      xTitle: 'x <i>',
      yTitle: 'y & z',
      x: -1.5,
      y: 2,
      time: '12.0 s',
      point: 'Trim <1>',
    })
    expect(html).toContain('Trim &lt;1&gt; · 12.0 s')
    expect(html).toContain('y &amp; z')
    expect(html).toContain('x &lt;i&gt;')
    expect(html).toContain('−1.5')
    expect(html).not.toContain('<b>')
  })

  it('shows mean ± σ and the row count for a test point', () => {
    const html = meanTooltipHtml({
      color: '#2a78d6',
      point: 'Trim 250',
      group: 'CG fwd',
      xTitle: 'CL',
      yTitle: 'Elevator [deg]',
      x: { mean: 0.41234, std: 0.0021 },
      y: { mean: -2.5, std: 0.04 },
      rows: 400,
    })
    expect(html).toContain('Trim 250 · CG fwd')
    // σ to 2 significant figures, the mean to the same decimal place.
    expect(html).toContain('−2.500 ± 0.040')
    expect(html).toContain('0.4123 ± 0.0021')
    expect(html).toContain('400')
  })
})
