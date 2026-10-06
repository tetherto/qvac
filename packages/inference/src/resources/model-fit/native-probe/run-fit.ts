import type { AbortSignal } from 'bare-abort-controller'

import type { FitProbeRequest } from '@/resources/model-fit/native-probe/engine-fit'
import type { FitRunResult } from '@/resources/model-fit/native-probe/fit-outcome'

export interface RunFitOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Whether this host can spawn a disposable child. Resolved by the caller,
   * which already knows the runtime.
   */
  mobile?: boolean
}

/**
 * Runs one engine's fitter and returns what it projected.
 *
 * A disposable child is the stronger boundary — a fitter that aborts takes only
 * the child with it — so it is used wherever one can be spawned. Mobile has no
 * such child and runs the fitter in process, carrying crash markers to bound
 * the abort it cannot contain. `bare-subprocess` stays deferred from the mobile
 * pack that way.
 *
 * Both strategies are imported lazily, so a host only loads the one it uses.
 */
export async function runFit(
  probe: FitProbeRequest,
  options: RunFitOptions = {}
): Promise<FitRunResult> {
  const { mobile, timeoutMs, ...runOptions } = options

  if (mobile === true) {
    const { runInProcessFit } =
      await import('@/resources/model-fit/native-probe/run-in-process-fit')
    return runInProcessFit(probe, runOptions)
  }

  const { runIsolatedFit } = await import('@/resources/model-fit/native-probe/run-isolated-fit')
  return runIsolatedFit(probe, { ...runOptions, ...(timeoutMs !== undefined && { timeoutMs }) })
}
