import { describe, expect, it } from 'vitest'
import type { RowRange, TimeAxis } from '../../core/types'
import { TimeController, axisPointerValue } from './timeController'
import { xFrame } from './timeMath'

const axis: TimeAxis = {
  id: 'elapsed',
  label: 'Elapsed time',
  unit: 's',
  values: Float64Array.from({ length: 201 }, (_, i) => i * 0.5),
}
const frame = xFrame(axis)

describe('axisPointerValue', () => {
  it('reads the x value of an updateAxisPointer event', () => {
    expect(axisPointerValue({ axesInfo: [{ axisDim: 'x', axisIndex: 0, value: 12.5 }] })).toBe(12.5)
    expect(axisPointerValue({ axesInfo: [{ axisDim: 'y', value: 3 }] })).toBeNull()
    expect(axisPointerValue({ axesInfo: [] })).toBeNull()
    expect(axisPointerValue(null)).toBeNull()
  })
})

describe('TimeController without charts', () => {
  it('applies the store view as its window and does not write it back', () => {
    const writes: (RowRange | null)[] = []
    const controller = new TimeController((view) => writes.push(view))
    controller.sync(axis, frame, [20, 41])
    expect(controller.getWindow()).toEqual([10, 20])
    expect(controller.isZoomed()).toBe(true)
    controller.sync(axis, frame, [20, 41])
    expect(writes).toEqual([])
  })

  it('notifies subscribers when the window changes', () => {
    const controller = new TimeController(() => {})
    let calls = 0
    const unsubscribe = controller.subscribe(() => (calls += 1))
    controller.sync(axis, frame, null)
    controller.zoomTo([30, 60])
    unsubscribe()
    controller.zoomTo([40, 50])
    expect(calls).toBe(2)
  })

  it('writes a zoom to the store once it settles, and a reset at once', async () => {
    const writes: (RowRange | null)[] = []
    const controller = new TimeController((view) => writes.push(view))
    controller.sync(axis, frame, null)
    controller.zoomTo([10, 20])
    expect(writes).toEqual([])
    controller.dispose() // flushes the pending zoom
    expect(writes).toEqual([[20, 41]])
    controller.resetZoom()
    expect(writes).toEqual([[20, 41], null])
    expect(controller.getWindow()).toEqual([0, 100])
  })

  it('re-applies the view when the axis changes', () => {
    const controller = new TimeController(() => {})
    controller.sync(axis, frame, [20, 41])
    const rows: TimeAxis = { id: 'index', label: 'Row number', unit: '', values: Float64Array.from({ length: 201 }, (_, i) => i) }
    controller.sync(rows, xFrame(rows), [20, 41])
    expect(controller.getWindow()).toEqual([20, 40])
  })

  it('converts pointer fractions to time and rows across the window', () => {
    const controller = new TimeController(() => {})
    controller.sync(axis, frame, [20, 41])
    expect(controller.xAt(0.5)).toBe(15)
    expect(controller.rowsBetween(controller.xAt(0), controller.xAt(1))).toEqual([20, 41])
  })

  it('cancels a drag in progress once', () => {
    const controller = new TimeController(() => {})
    let cancelled = 0
    controller.setDragCancel(() => (cancelled += 1))
    expect(controller.cancelDrag()).toBe(true)
    expect(controller.cancelDrag()).toBe(false)
    expect(cancelled).toBe(1)
  })
})
