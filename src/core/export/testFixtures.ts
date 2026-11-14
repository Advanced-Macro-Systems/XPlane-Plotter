// Hand-built datasets and workspaces for the export tests (no parser, no buildDataset), with fixed channel meanings so
// the expected titles do not depend on the channel dictionary.
// OWNER: export agent.

import { computeStats } from '../dataset'
import type { Channel, ChannelMeta, Dataset, Workspace } from '../types'

export function meta(short: string, unit: string, group = 'other'): ChannelMeta {
  return { label: short, short, unit, quantity: 'other', group, known: false }
}

/** A file column. `id` gets "#n" for a repeated token, as in the app. */
export function fileChannel(
  token: string,
  occurrence: number,
  column: number,
  values: readonly number[],
  short: string,
  unit: string,
): Channel {
  const v = Float64Array.from(values)
  return {
    id: occurrence > 1 ? `${token}#${occurrence}` : token,
    token,
    occurrence,
    column,
    meta: meta(short, unit),
    values: v,
    stats: computeStats(v),
  }
}

/** A formula channel "fx:<slug>". */
export function derivedChannel(slug: string, name: string, unit: string, expression: string, values: readonly number[]): Channel {
  const v = Float64Array.from(values)
  return {
    id: `fx:${slug}`,
    token: '',
    occurrence: 1,
    column: -1,
    meta: meta(name, unit, 'derived'),
    values: v,
    stats: computeStats(v),
    derived: { expression },
  }
}

export function makeDataset(channels: Channel[], elapsed: readonly number[], extra: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds1',
    name: 'Data.txt',
    sizeBytes: 12_300_000,
    format: 'xplane',
    rowCount: elapsed.length,
    channels,
    timeSourceId: channels[0]?.id ?? null,
    elapsed: Float64Array.from(elapsed),
    segments: [{ start: 0, end: elapsed.length, reason: 'start' }],
    sampleRateHz: 2,
    warnings: [],
    signature: 'abc12345',
    loadedAt: 0,
    ...extra,
  }
}

/**
 * Six rows at 0.5 s: sim time, KIAS (one NaN), a token X-Plane repeats ("elev1,__deg" twice), a three-part token
 * with awkward numbers, and a formula channel.
 */
export function sampleDataset(): Dataset {
  return makeDataset(
    [
      fileChannel('_totl,_time', 1, 0, [10, 10.5, 11, 11.5, 12, 12.5], 'Sim time', 's'),
      fileChannel('_Vind,_kias', 1, 1, [100, 101, NaN, 103, 104, 105], 'KIAS', 'kt'),
      fileChannel('elev1,__deg', 1, 2, [1, 2, 3, 4, 5, 6], 'elev1', 'deg'),
      fileChannel('elev1,__deg', 2, 3, [-1, -2, -3, -4, -5, -6], 'elev1 (2)', 'deg'),
      fileChannel('thrst,_1,lb', 1, 4, [0.1, 0.2, 0.1 + 0.2, 1e21, -0, 5e-7], 'Thrust 1', 'lb'),
      derivedChannel('q', 'q', 'Pa', 'Vind_kias * 2', [200, 202, NaN, 206, 208, 210]),
    ],
    [0, 0.5, 1, 1.5, 2, 2.5],
  )
}

export function makeWorkspace(patch: Partial<Workspace> = {}): Workspace {
  return {
    version: 1,
    timeBase: 'elapsed',
    panels: [{ id: 'p1', channelIds: ['_Vind,_kias'] }],
    groups: [
      { id: 'g1', name: 'CG fwd', slot: 0 },
      { id: 'g2', name: 'CG "aft", test', slot: 3 },
    ],
    points: [
      { id: 't1', name: 'Point, "one"', groupId: 'g1', start: 0, end: 3 },
      { id: 't2', name: '=SUM(A1)', groupId: 'g2', start: 2, end: 6, hidden: true },
    ],
    derived: [{ id: 'fx:q', name: 'q', unit: 'Pa', expression: 'Vind_kias * 2' }],
    xy: {
      x: 'elev1,__deg',
      ys: ['_Vind,_kias'],
      source: 'points',
      style: 'points',
      colorBy: 'group',
      fit: 'linear',
      fitTarget: 'means',
      showSamples: true,
      showMeans: true,
      title: '',
      xLabel: '',
      yLabel: '',
    },
    modes: { channelId: '_Vind,_kias', source: 'selection', model: 'oscillation', detrend: 'linear' },
    tracked: ['_Vind,_kias', 'elev1,__deg#2'],
    ...patch,
  }
}
