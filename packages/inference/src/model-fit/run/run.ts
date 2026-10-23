import type { AbortSignal } from 'bare-abort-controller'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { generateShortHash } from '@/utils/formatting'
import { callEngineFit } from '@/model-fit/run/engine'
import type { AddonFit, FitProbeRequest } from '@/model-fit/run/engine'

/**
 * Why a run produced no fit. Each one makes the verdict `unknown`, so the
 * caller proceeds with the load it was going to run anyway.
 */
export type FitRunUnknownReason = 'cancelled' | 'crashed' | 'marker-error' | 'timeout'

export type FitRunResult =
  | { status: 'completed'; fit: AddonFit }
  | { status: 'unknown'; reason: FitRunUnknownReason; message: string }

export interface RunFitOptions {
  signal?: AbortSignal
  timeoutMs?: number
  stateDir?: string
  callFit?: typeof callEngineFit
}

function unknown(reason: FitRunUnknownReason, message: string): FitRunResult {
  return { status: 'unknown', reason, message }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** How long a marker keeps a request from calling its fitter. */
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A fit sits in front of a load, so a fitter that never returns must not hold it. */
const FIT_TIMEOUT_MS = 30_000

/** Fits this process has in flight, per request. */
const inFlight = new Map<string, number>()

/** Requests whose fit timed out and has not returned. */
const hung = new Set<string>()

function markerKey(probe: FitProbeRequest): string {
  return generateShortHash(JSON.stringify(probe))
}

export function runningMarkerPath(
  stateDir: string,
  probe: FitProbeRequest,
  pid: number = os.pid()
): string {
  return path.join(stateDir, `${markerKey(probe)}.${pid}.running`)
}

export function suspectMarkerPath(stateDir: string, probe: FitProbeRequest): string {
  return path.join(stateDir, `${markerKey(probe)}.suspect`)
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

function expired(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > MARKER_TTL_MS
  } catch {
    return false
  }
}

function remove(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    // Marker cleanup must not turn an advisory fit into a load failure.
  }
}

function mark(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
}

/**
 * A marker with this process's pid is from an earlier process that had the
 * same pid, since this one holds no fit of the request. `EPERM` means the
 * process exists under another user.
 */
function isAlive(pid: number): boolean {
  if (pid === os.pid()) return false
  try {
    os.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/** `.running` markers of this request whose process is gone or that have expired. */
function unfinishedFits(stateDir: string, probe: FitProbeRequest): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(stateDir) as string[]
  } catch {
    return []
  }
  const pattern = new RegExp(`^${markerKey(probe)}\\.(\\d+)\\.running$`)
  return names.flatMap((name) => {
    const pid = pattern.exec(name)?.[1]
    if (pid === undefined) return []
    const file = path.join(stateDir, name)
    return isAlive(Number(pid)) && !expired(file) ? [] : [file]
  })
}

async function resolveStateDir(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return explicit
  const { getCacheDir } = await import('@/utils/cache/paths')
  return getCacheDir('model-fit')
}

async function settle(
  probe: FitProbeRequest,
  callFit: typeof callEngineFit,
  stateDir: string
): Promise<FitRunResult> {
  const key = markerKey(probe)
  try {
    return { status: 'completed', fit: await callFit(probe) }
  } finally {
    const remaining = (inFlight.get(key) ?? 1) - 1
    if (remaining === 0) {
      inFlight.delete(key)
      hung.delete(key)
      remove(runningMarkerPath(stateDir, probe))
      remove(suspectMarkerPath(stateDir, probe))
    } else {
      inFlight.set(key, remaining)
    }
  }
}

function bounded(
  fit: Promise<FitRunResult>,
  key: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<FitRunResult> {
  return new Promise((resolve, reject) => {
    const settled = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (result: FitRunResult) => {
      settled()
      resolve(result)
    }
    const fail = (error: unknown) => {
      settled()
      reject(error)
    }
    const onAbort = () => finish(unknown('cancelled', 'Fit was cancelled'))
    const timer = setTimeout(() => {
      hung.add(key)
      finish(unknown('timeout', `Fit did not return within ${timeoutMs} ms`))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    fit.then(finish, fail)
  })
}

/**
 * Runs one engine's fitter in this process.
 *
 * A fitter that aborts takes the process with it, as does a process that quits
 * or is killed mid-fit. Each process marks its fit with a `.running` file named
 * by its pid, so a marker whose process is gone is a fit that never finished,
 * while one whose process is alive is a fit still running there. The first
 * unfinished fit of a request leaves `.suspect` and the fit runs again. A
 * second one in a row leaves `.crashed`, and the request skips the fitter
 * until that marker expires.
 *
 * Fits of one request in this process share one marker, removed by the last.
 * An aborted `signal` answers `cancelled` and a fit past `timeoutMs` answers
 * `timeout`, both at once, while the fitter runs on and releases the marker
 * when it returns. Until a timed-out fitter returns, further fits of its
 * request answer `timeout` without calling it again.
 *
 * A fitter that rejects, for a model it cannot read or a request it refuses,
 * rejects this call with its error.
 */
export async function runFit(
  probe: FitProbeRequest,
  options: RunFitOptions = {}
): Promise<FitRunResult> {
  if (options.signal?.aborted === true) {
    return unknown('cancelled', 'Fit was cancelled')
  }

  const key = markerKey(probe)
  if (hung.has(key)) {
    return unknown('timeout', 'An earlier fit of this request has not returned')
  }

  const stateDir = await resolveStateDir(options.stateDir)
  const crashed = crashedMarkerPath(stateDir, probe)
  const suspect = suspectMarkerPath(stateDir, probe)
  const held = inFlight.get(key) ?? 0

  if (held === 0) {
    for (const marker of [crashed, suspect]) {
      if (exists(marker) && expired(marker)) remove(marker)
    }

    const unfinished = unfinishedFits(stateDir, probe)
    if (exists(crashed) || (unfinished.length > 0 && exists(suspect))) {
      try {
        mark(crashed)
        remove(suspect)
        unfinished.forEach(remove)
      } catch {
        // Keep the unfinished markers if `.crashed` could not be written so
        // the next attempt still counts them.
      }
      return unknown('crashed', 'Earlier fits did not finish; treating this model as unknown')
    }

    try {
      if (unfinished.length > 0) {
        mark(suspect)
        unfinished.forEach(remove)
      }
      mark(runningMarkerPath(stateDir, probe))
    } catch (error) {
      return unknown('marker-error', `Fit marker could not be written: ${describe(error)}`)
    }
  }

  inFlight.set(key, held + 1)

  const fit = settle(probe, options.callFit ?? callEngineFit, stateDir)
  return bounded(fit, key, options.timeoutMs ?? FIT_TIMEOUT_MS, options.signal)
}
