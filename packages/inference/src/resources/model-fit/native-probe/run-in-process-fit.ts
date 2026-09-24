import type { AbortSignal } from 'bare-abort-controller'
import fs from 'bare-fs'
import path from 'bare-path'

import { generateShortHash } from '@/utils/formatting'
import { callEngineFit } from '@/resources/model-fit/native-probe/engine-fit'
import type { FitProbeRequest } from '@/resources/model-fit/native-probe/engine-fit'
import type {
  FitRunResult,
  FitRunUnknownReason
} from '@/resources/model-fit/native-probe/fit-outcome'

export interface RunInProcessFitOptions {
  signal?: AbortSignal
  stateDir?: string
  callFit?: typeof callEngineFit
}

function unknown(reason: FitRunUnknownReason, message: string): FitRunResult {
  return { status: 'unknown', reason, message }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function markerKey(probe: FitProbeRequest): string {
  return generateShortHash(JSON.stringify(probe))
}

export function crashMarkerPath(stateDir: string, probe: FitProbeRequest): string {
  return path.join(stateDir, `${markerKey(probe)}.running`)
}

export function crashedMarkerPath(stateDir: string, probe: FitProbeRequest): string {
  return path.join(stateDir, `${markerKey(probe)}.crashed`)
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function clearRunning(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    // Marker cleanup must not turn an advisory fit into a load failure.
  }
}

async function resolveStateDir(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return explicit
  const { getCacheDir } = await import('@/utils/cache/paths')
  return getCacheDir('model-fit')
}

/**
 * Runs one engine's fitter on the calling thread, for hosts that cannot spawn a
 * disposable child.
 *
 * There is no boundary here to contain a fitter that aborts: it takes the host
 * with it. A leftover `.running` marker is that abort, observed on the next
 * launch, and it is promoted to `.crashed` so the same request skips native
 * rather than repeating the abort. `timeoutMs` has no meaning on this path,
 * since the native call blocks the thread until it returns.
 */
export async function runInProcessFit(
  probe: FitProbeRequest,
  options: RunInProcessFitOptions = {}
): Promise<FitRunResult> {
  if (options.signal?.aborted === true) {
    return unknown('cancelled', 'In-process fit was cancelled')
  }

  const stateDir = await resolveStateDir(options.stateDir)
  const running = crashMarkerPath(stateDir, probe)
  const crashed = crashedMarkerPath(stateDir, probe)

  if (exists(crashed) || exists(running)) {
    try {
      fs.mkdirSync(path.dirname(crashed), { recursive: true })
      fs.writeFileSync(crashed, '')
      clearRunning(running)
    } catch {
      // Keep `.running` if `.crashed` could not be written so the next launch
      // still skips native.
    }
    return unknown('crashed', 'Previous fit did not finish; treating this model as unknown')
  }

  try {
    fs.mkdirSync(path.dirname(running), { recursive: true })
    fs.writeFileSync(running, '')
  } catch (error) {
    return unknown('invocation-error', `Fit crash marker could not be written: ${describe(error)}`)
  }

  try {
    const callFit = options.callFit ?? callEngineFit
    return { status: 'completed', probe: await callFit(probe) }
  } catch (error) {
    return unknown('invocation-error', describe(error))
  } finally {
    clearRunning(running)
  }
}
