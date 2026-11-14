// Runs the Dynamic modes fit in a background worker (fit.worker.ts), so a long window never blocks the page. A newer
// request stops a fit that is still running (the worker is replaced) rather than queueing behind it. Without workers,
// or if the worker cannot start, the fit runs on the main thread instead, as before.

import { useEffect, useRef, useState } from 'react'
import { runModeFit, type FitSeries, type ModeDetrend, type ModeFit, type ModeFitJob, type ModeFitReply, type ModeModel } from './modeFit'

export interface ModeFitRequest {
  series: FitSeries
  model: ModeModel
  detrend: ModeDetrend
}

/** A finished fit and the request it answers. */
export interface ModeFitDone<R extends ModeFitRequest> {
  request: R
  result: ModeFit
}

interface Slot {
  worker: Worker
  busy: boolean
}

/** Set once a worker failed to start or load: later fits run on the main thread. */
let workersFail = typeof Worker === 'undefined'
let jobs = 0

function startWorker(): Worker | null {
  if (workersFail) return null
  try {
    return new Worker(new URL('./fit.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    workersFail = true
    return null
  }
}

/** The latest finished fit (possibly for an older request: compare `done.request`), null before the first. */
export function useModeFit<R extends ModeFitRequest>(request: R | null): ModeFitDone<R> | null {
  const [done, setDone] = useState<ModeFitDone<R> | null>(null)
  // A fit that threw is re-thrown while rendering, so the tab's error boundary shows it (as when it ran inline).
  const [failure, setFailure] = useState<Error | null>(null)
  const slot = useRef<Slot | null>(null)

  useEffect(() => {
    if (!request) return
    let live = true
    const fitHere = () => {
      if (!live) return
      try {
        setDone({ request, result: runModeFit(request.series, request.model, request.detrend) })
      } catch (error) {
        setFailure(error instanceof Error ? error : new Error(String(error)))
      }
    }
    let current = slot.current
    if (current?.busy) {
      // Superseded: stop it, a new worker takes this request.
      current.worker.terminate()
      current = slot.current = null
    }
    if (!current) {
      const worker = startWorker()
      current = slot.current = worker ? { worker, busy: false } : null
    }
    if (!current) {
      const timer = window.setTimeout(fitHere, 0)
      return () => {
        live = false
        window.clearTimeout(timer)
      }
    }
    const own = current
    const id = (jobs += 1)
    own.busy = true
    own.worker.onmessage = (event: MessageEvent<ModeFitReply>) => {
      if (event.data.id !== id) return
      own.busy = false
      if (!live) return
      if ('result' in event.data) setDone({ request, result: event.data.result })
      else setFailure(new Error(event.data.error))
    }
    own.worker.onerror = (event) => {
      // The worker could not load (blocked or missing chunk): fit here from now on.
      event.preventDefault()
      workersFail = true
      own.worker.terminate()
      if (slot.current === own) slot.current = null
      fitHere()
    }
    own.worker.postMessage({
      id,
      t: request.series.t,
      y: request.series.y,
      model: request.model,
      detrend: request.detrend,
    } satisfies ModeFitJob)
    return () => {
      live = false
    }
  }, [request])

  useEffect(
    () => () => {
      slot.current?.worker.terminate()
      slot.current = null
    },
    [],
  )

  if (failure) throw failure
  return done
}
