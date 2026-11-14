// Hand-built datasets and workspaces for the X–Y and test-point tests (no parser), with fixed channel meanings so
// results do not depend on the channel dictionary. Test-only: imported by *.test.ts files.

import { computeStats } from '../../core/dataset'
import type { Channel, Dataset, TimeAxis, Workspace, XYConfig } from '../../core/types'

export function channel(token: string, values: readonly number[], short: string, unit: string, occurrence = 1): Channel {
  const v = Float64Array.from(values)
  return {
    id: occurrence > 1 ? `${token}#${occurrence}` : token,
    token,
    occurrence,
    column: 0,
    meta: { label: short, short, unit, quantity: 'other', group: 'other', known: false },
    values: v,
    stats: computeStats(v),
  }
}

export function dataset(channels: Channel[], elapsed: readonly number[], extra: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 1000,
    format: 'xplane',
    rowCount: elapsed.length,
    channels,
    timeSourceId: null,
    elapsed: Float64Array.from(elapsed),
    segments: [{ start: 0, end: elapsed.length, reason: 'start' }],
    sampleRateHz: 1,
    warnings: [],
    signature: 'sig00001',
    loadedAt: 0,
    ...extra,
  }
}

export function elapsedAxis(ds: Dataset): TimeAxis {
  return { id: 'elapsed', label: 'Elapsed time', unit: 's', values: ds.elapsed }
}

export function xyConfig(patch: Partial<XYConfig> = {}): XYConfig {
  return {
    x: 'x',
    ys: ['y'],
    source: 'all',
    style: 'points',
    colorBy: 'series',
    fit: 'none',
    fitTarget: 'samples',
    showSamples: true,
    showMeans: true,
    title: '',
    xLabel: '',
    yLabel: '',
    ...patch,
  }
}

export function workspace(patch: Partial<Workspace> = {}): Workspace {
  return {
    version: 1,
    timeBase: 'elapsed',
    panels: [],
    groups: [
      { id: 'g1', name: 'Trim', slot: 0 },
      { id: 'g2', name: 'Dynamic', slot: 3 },
    ],
    points: [],
    derived: [],
    xy: xyConfig(),
    modes: { channelId: null, source: 'selection', model: 'oscillation', detrend: 'linear' },
    tracked: [],
    ...patch,
  }
}

/** The workspace parts buildXYData takes. */
export function wsArgs(ws: Workspace): { ws: Workspace; xy: XYConfig } {
  return { ws, xy: ws.xy }
}

/** 0..n-1 */
export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}
