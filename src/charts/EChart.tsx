// React wrapper around one ECharts instance.
// OWNER: charts agent. Public API below is a contract; keep these props.
//
// Behaviour:
// - init once on mount (canvas renderer, the screen's devicePixelRatio), dispose on unmount. The first render waits for
//   the chart fonts (fonts.ts: text measured before they load stays mis-measured), so the chart appears and onChart fires
//   a moment after mount — at once when the fonts are already loaded;
// - ResizeObserver on the container -> chart.resize(), rAF-throttled and skipped when the size is unchanged or zero (a
//   hidden container keeps its last render); one forced re-layout if the web fonts finish loading after init;
// - setOption(option, { notMerge, replaceMerge, lazyUpdate: true }) whenever `option` changes (by reference). The chart
//   is never re-created for a new option, and changing only notMerge/replaceMerge does not re-apply it;
// - `group`: chart.group = group and echarts.connect(group) so tooltips/axis pointers/zoom sync across charts. Members
//   are counted, so a chart leaving a group (unmount, group change) never disconnects the charts still in it. Each
//   linked chart snaps to its own samples: with lines decimated differently per chart the crosshair can vanish or the
//   tooltips show slightly different instants (Time history syncs its panels by value instead: timeController.ts);
// - onEvents: bound per event name and re-bound when the set of names changes; handlers always see the latest props and
//   receive (params, chart). Keys starting with "zr:" ("zr:mousedown", "zr:mousemove", "zr:mouseup") bind raw zrender
//   events, which also fire over blank plot areas (drag-select); other keys are ECharts events ("click", "datazoom",
//   "updateAxisPointer", "globalout"...);
// - onChart(chart) once the chart exists and has its first option, onChart(null) before dispose: the imperative handle
//   (convertFromPixel, dispatchAction, getZr). No separate hook or ref is exported — onChart covers it;
// - the container gets role="img" and aria-label={ariaLabel}. When the option enables ECharts' aria component
//   (baseOption does), ariaLabel is also handed to it as the description, so ECharts doesn't replace the label with its
//   own generated summary. That costs one chart update per change: describe the chart, not the hover state.
// The container needs a definite size from className/style: ECharts draws into the box it measures.

import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react'
import { echarts, type ECharts, type EChartsOption } from './echarts'
import { chartFontsReady } from './fonts'

export interface EChartProps {
  option: EChartsOption
  notMerge?: boolean
  replaceMerge?: string[]
  group?: string
  onEvents?: Record<string, (params: unknown, chart: ECharts) => void>
  onChart?: (chart: ECharts | null) => void
  className?: string
  style?: CSSProperties
  ariaLabel: string
}

export function EChart({
  option,
  notMerge,
  replaceMerge,
  group,
  onEvents,
  onChart,
  className,
  style,
  ariaLabel,
}: EChartProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [chart, setChart] = useState<ECharts | null>(null)

  // Effect events read the latest props without making the effects below re-run when a callback changes identity.
  const applyOption = useEffectEvent((instance: ECharts, next: EChartsOption) => {
    instance.setOption(next, { notMerge, replaceMerge, lazyUpdate: true })
    // notMerge rebuilds the whole model, the aria description included: put it back (both land in the same frame).
    describe(instance, ariaLabel)
  })
  const emit = useEffectEvent((name: string, params: unknown, instance: ECharts) => {
    onEvents?.[name]?.(params, instance)
  })
  const announce = useEffectEvent((instance: ECharts | null) => {
    onChart?.(instance)
  })

  useEffect(() => {
    if (!isLive(chart) || !group) return
    joinGroup(chart, group)
    return () => leaveGroup(chart, group)
  }, [chart, group])

  const eventNames = onEvents ? Object.keys(onEvents).sort().join('\n') : ''
  useEffect(() => {
    if (!isLive(chart) || !eventNames) return
    const unbind = eventNames.split('\n').map((name) => bindEvent(chart, name, (params) => emit(name, params, chart)))
    return () => {
      if (chart.isDisposed()) return
      for (const off of unbind) off()
    }
  }, [chart, eventNames])

  useEffect(() => {
    if (isLive(chart)) applyOption(chart, option)
  }, [chart, option])

  useEffect(() => {
    if (isLive(chart)) describe(chart, ariaLabel)
  }, [chart, ariaLabel])

  useEffect(() => {
    if (!isLive(chart)) return
    announce(chart)
    return () => announce(null)
  }, [chart])

  // Lifetime. Declared last on purpose: React runs effect cleanups in declaration order, so on unmount the ones above
  // (leave the group, unbind handlers, onChart(null)) run while the chart still exists.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let instance: ECharts | null = null
    let cancelled = false
    let observer: ResizeObserver | null = null
    let frame = 0
    let forceNext = false
    let observed: { width: number; height: number } | null = null

    const resizeSoon = (force: boolean): void => {
      forceNext ||= force
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const forced = forceNext
        forceNext = false
        if (!instance || instance.isDisposed()) return
        if (!forced && observed) {
          // A hidden container (display: none) measures 0×0: keep the last render rather than lay out into nothing.
          if (observed.width < 1 || observed.height < 1) return
          // The first observation reports the size the chart was created at: nothing to do.
          const sameWidth = Math.abs(observed.width - instance.getWidth()) < 1
          if (sameWidth && Math.abs(observed.height - instance.getHeight()) < 1) return
        }
        instance.resize()
      })
    }

    void chartFontsReady().then(() => {
      if (cancelled) return
      instance = echarts.init(host, null, { renderer: 'canvas', devicePixelRatio: window.devicePixelRatio })
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver((entries) => {
          const box = entries[entries.length - 1]?.contentRect
          if (box) observed = { width: box.width, height: box.height }
          resizeSoon(false)
        })
        observer.observe(host)
      }
      // The font wait timed out: lay the text out again once the fonts arrive (best effort, see fonts.ts).
      if (document.fonts?.status === 'loading') void document.fonts.ready.then(() => resizeSoon(true))
      setChart(instance)
    })

    return () => {
      cancelled = true
      observer?.disconnect()
      cancelAnimationFrame(frame)
      instance?.dispose()
      instance = null
    }
  }, [])

  return <div ref={hostRef} className={className} style={style} role="img" aria-label={ariaLabel} />
}

function isLive(chart: ECharts | null): chart is ECharts {
  return chart !== null && !chart.isDisposed()
}

/** ECharts' aria component (when the option enables it) writes its own summary into the container's aria-label. */
function describe(chart: ECharts, label: string): void {
  chart.setOption({ aria: { label: { description: label } } }, { lazyUpdate: true })
}

// echarts.connect/disconnect switch a whole group on or off, so members are counted and the group is disconnected only
// when its last chart leaves.
const groupMembers = new Map<string, number>()

function joinGroup(chart: ECharts, group: string): void {
  chart.group = group
  groupMembers.set(group, (groupMembers.get(group) ?? 0) + 1)
  echarts.connect(group)
}

function leaveGroup(chart: ECharts, group: string): void {
  if (!chart.isDisposed() && chart.group === group) chart.group = ''
  const remaining = (groupMembers.get(group) ?? 1) - 1
  if (remaining > 0) {
    groupMembers.set(group, remaining)
  } else {
    groupMembers.delete(group)
    echarts.disconnect(group)
  }
}

const ZR_EVENT_PREFIX = 'zr:'

/** Binds one onEvents entry; returns its unbinder. */
function bindEvent(chart: ECharts, name: string, handler: (params: unknown) => void): () => void {
  if (name.startsWith(ZR_EVENT_PREFIX)) {
    const zr = chart.getZr()
    const zrName = name.slice(ZR_EVENT_PREFIX.length)
    zr.on(zrName, handler)
    return () => zr.off(zrName, handler)
  }
  chart.on(name, handler)
  return () => chart.off(name, handler)
}
