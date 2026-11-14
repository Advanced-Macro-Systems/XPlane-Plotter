// Time-history exports: the panel stack as one publication figure (PNG / SVG, paper theme), the plotted channels as
// CSV over the zoom range, and a MATLAB script that re-plots the panels from the original log.

import { channelTitle } from '../../core/channels'
import { channelById } from '../../core/dataset'
import { datasetCsv } from '../../core/export/csv'
import { downloadText, safeFilename } from '../../core/export/download'
import { sanitizeSlots } from '../../core/slots'
import type { Channel, Dataset, RowRange, TimeAxis, Workspace } from '../../core/types'
import { exportOptionImage } from '../../charts/exportChart'
import { chartFontsReady } from '../../charts/fonts'
import {
  timeStackOption,
  type StackPanelInput,
  type TextMeasure,
  type TimeStackFigure,
} from '../../charts/options/timeStack'
import { canvasTextWidth } from '../../charts/textWidth'
import { readChartTheme, seriesColor } from '../../charts/theme'
import { plottedIds } from './panelEdit'
import {
  axisTitle,
  boundaryMarks,
  figureTick,
  interleaveSeries,
  segmentBreaks,
  windowToRows,
  type XFrame,
  type XWindow,
} from './timeMath'

/** "Data 737.txt" -> "Data_737" (for file names). */
export function fileStem(ds: Dataset): string {
  return safeFilename(ds.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), 'flight')
}

/** The y-axis title of an exported panel: "KIAS [kt]" for one channel, "[kt]" (with a legend) for several. */
export function stackYName(channels: readonly Channel[]): string {
  if (channels.length === 1) return channelTitle(channels[0])
  const units = new Set(channels.map((c) => c.meta.unit))
  const [unit] = [...units]
  return units.size === 1 && unit ? `[${unit}]` : ''
}

export interface TimeFigureRequest {
  ds: Dataset
  ws: Workspace
  axis: TimeAxis
  frame: XFrame
  window: XWindow
  /** Measures the test-point names as drawn (TimeStackInput.measureText); the image export passes canvasTextWidth */
  measureText?: TextMeasure
}

export interface TimeImageRequest extends TimeFigureRequest {
  format: 'png' | 'svg'
}

export async function exportTimeImage({ format, ...request }: TimeImageRequest): Promise<void> {
  // The test-point names are laid out at their drawn widths: measured once the chart fonts are in.
  await chartFontsReady()
  const figure = timeFigure({ ...request, measureText: canvasTextWidth })
  if (!figure) return
  await exportOptionImage(figure.option, {
    format,
    width: figure.width,
    height: figure.height,
    filename: `${fileStem(request.ds)}_time_history`,
  })
}

/**
 * The panel stack over the zoom window as one figure in the paper theme (null without a channel to draw): each line
 * in its channel's colour slot, the test points as neutral bands with their names, the segment boundaries. Pure.
 */
export function timeFigure({ ds, ws, axis, frame, window, measureText }: TimeFigureRequest): TimeStackFigure | null {
  const theme = readChartTheme('paper')
  const breaks = segmentBreaks(ds.segments)
  const [first, end] = windowToRows(axis, frame, window)
  // One row either side so the lines reach the plot edges.
  const lo = Math.max(0, first - 1)
  const hi = Math.min(ds.rowCount, end + 1)
  const panels: StackPanelInput[] = ws.panels.flatMap((panel) => {
    // Each channel in its stored colour slot, as on screen.
    const slots = sanitizeSlots(panel.slots, panel.channelIds.length)
    const entries = panel.channelIds
      .map((id, i) => ({ ch: channelById(ds, id), slot: slots[i] }))
      .filter((e): e is { ch: Channel; slot: number } => e.ch !== undefined)
    if (!entries.length) return []
    return [
      {
        yName: stackYName(entries.map((e) => e.ch)),
        yZero: panel.yZero === true,
        series: entries.map((e) => ({
          name: channelTitle(e.ch),
          color: seriesColor(theme, e.slot),
          data: interleaveSeries(axis.values, e.ch.values, breaks, lo, hi, frame.factor),
        })),
      },
    ]
  })
  if (!panels.length) return null
  return timeStackOption({
    theme,
    panels,
    x: {
      min: window[0],
      max: window[1],
      clock: frame.clock,
      name: axisTitle(axis),
      tick: (x) => figureTick(frame, window, x),
    },
    boundaries: boundaryMarks(ds.segments, axis, frame).map((b) => ({ x: b.x, label: b.reason })),
    bands: ws.points
      .filter((p) => !p.hidden)
      .map((p) => ({
        x0: axis.values[p.start] * frame.factor,
        x1: axis.values[Math.max(p.start, p.end - 1)] * frame.factor,
        // A neutral wash, as on screen: in the plots, hue means a channel's line.
        color: theme.textMuted,
        name: p.name,
      })),
    plotHeight: panels.length <= 3 ? 170 : panels.length <= 5 ? 140 : 112,
    measureText,
  })
}

/** CSV of every plotted channel (with row, elapsed time and the time source) over the zoom range. */
export function exportTimeCsv(ds: Dataset, ws: Workspace, view: RowRange | null): string {
  const name = `${fileStem(ds)}_time_history${view ? '_zoom' : ''}.csv`
  const text = datasetCsv(ds, {
    channelIds: plottedIds(ws.panels),
    ranges: view ? [{ name: 'zoom', range: view }] : null,
    includeTime: true,
    delimiter: ',',
  })
  downloadText(name, text, 'text/csv')
  return name
}
