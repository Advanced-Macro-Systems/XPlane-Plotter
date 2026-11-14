// The demo flight opens with its manoeuvres already marked, so every tab has something to show: the steady trim
// points in one group, the dynamic-mode response windows in another (their notes give the injected values, to
// compare with what the Dynamic modes tab fits), X–Y on the elevator-to-trim curve and Modes on the phugoid.

import { DEMO_EVENTS, DEMO_MODES } from '../core/demo/generateDemo'
import { channelById } from '../core/dataset'
import { rangeToRows } from '../core/time'
import type { Dataset, PointGroup, TestPoint, Workspace } from '../core/types'
import { defaultWorkspace } from './defaults'

const TRIM_GROUP: PointGroup = { id: 'g1', name: 'Trim points', slot: 0 }
const DYNAMIC_GROUP: PointGroup = { id: 'g2', name: 'Dynamic modes', slot: 1 }

function injected(kind: string): string {
  switch (kind) {
    case 'short-period':
      return `injected T = ${DEMO_MODES.shortPeriod.periodS} s, ζ = ${DEMO_MODES.shortPeriod.zeta}`
    case 'phugoid':
      return `injected T = ${DEMO_MODES.phugoid.periodS} s, ζ = ${DEMO_MODES.phugoid.zeta}`
    case 'dutch-roll':
      return `injected T = ${DEMO_MODES.dutchRoll.periodS} s, ζ = ${DEMO_MODES.dutchRoll.zeta}`
    case 'roll-subsidence':
      return `injected τ = ${DEMO_MODES.rollSubsidence.tauS} s`
    default:
      return ''
  }
}

/** The demo's starting workspace (falls back to the plain default for anything the dataset lacks). */
export function demoWorkspace(ds: Dataset): Workspace {
  const base = defaultWorkspace(ds)
  const has = (id: string) => channelById(ds, id) !== undefined
  const rows = (start: number, end: number) => rangeToRows(ds.elapsed, start, end)
  const points: TestPoint[] = []

  for (const event of DEMO_EVENTS) {
    if (event.kind !== 'trim') continue
    const [start, end] = rows(event.start, event.end)
    points.push({
      id: `demo-${event.id}`,
      name: `Trim ${event.kias ?? ''} KIAS`.replace('  ', ' '),
      groupId: TRIM_GROUP.id,
      start,
      end,
      note: event.description,
    })
  }
  for (const event of DEMO_EVENTS) {
    const response = event.response
    if (!response?.model) continue
    const [start, end] = rows(response.start, response.end)
    const note = injected(event.kind)
    points.push({
      id: `demo-${event.id}`,
      name: event.label,
      groupId: DYNAMIC_GROUP.id,
      start,
      end,
      note: note ? `${event.description} Synthetic demo: ${note}.` : event.description,
    })
  }

  const workspace: Workspace = { ...base, groups: [TRIM_GROUP, DYNAMIC_GROUP], points }

  // Static stability: elevator to trim against CL through the trim-point means.
  const elevator = ['elev1,__deg', '_elev,_surf'].find(has)
  if (has('___cl,total') && elevator) {
    workspace.xy = {
      ...base.xy,
      x: '___cl,total',
      ys: [elevator],
      source: 'points',
      groups: [TRIM_GROUP.id],
      colorBy: 'group',
      fit: 'linear',
      fitTarget: 'means',
      showSamples: true,
      showMeans: true,
    }
  }

  // Dynamic modes: the phugoid response in true airspeed.
  const phugoid = DEMO_EVENTS.find((e) => e.kind === 'phugoid')
  const channel = phugoid?.response?.channels.find(has)
  if (phugoid && channel && points.some((p) => p.id === `demo-${phugoid.id}`)) {
    workspace.modes = { channelId: channel, source: `point:demo-${phugoid.id}`, model: 'oscillation', detrend: 'linear' }
  }
  return workspace
}
