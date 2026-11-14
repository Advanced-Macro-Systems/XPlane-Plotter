// Module Web Worker that runs the Dynamic modes fit off the main thread (see useModeFit.ts), so fitting a long window
// (a whole 200k-row file can take seconds) never freezes the page. It imports only ./modeFit and the fitting maths.

import { runModeFit, type ModeFitJob, type ModeFitReply } from './modeFit'

/** The parts of DedicatedWorkerGlobalScope used here (the app's TS lib is DOM, not WebWorker). */
interface FitWorkerScope {
  onmessage: ((event: MessageEvent<ModeFitJob>) => void) | null
  postMessage(message: ModeFitReply): void
}

const scope = self as unknown as FitWorkerScope

scope.onmessage = (event) => {
  const { id, t, y, model, detrend } = event.data
  try {
    scope.postMessage({ id, result: runModeFit({ t, y }, model, detrend) })
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
