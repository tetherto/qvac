import type { FitConfig, FitResult } from '@qvac/model-fit'
import type { AbortSignal } from 'bare-abort-controller'
import fs from 'bare-fs'
import path from 'bare-path'
import type { FitLlamaProcessConfig, LlamaLoadKind } from '@qvac/model-fit/process'

import { generateShortHash } from '@/utils/formatting'
import type { IsolatedFitUnknownReason } from '@/resources/model-fit/native-probe/run-isolated-fit'

export interface RunInProcessFitOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fit?: (config: FitConfig) => FitResult | Promise<FitResult>
  stateDir?: string
}

function parseOptionalInt(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return undefined
  return parsed
}

export function toFitConfig(config: FitLlamaProcessConfig) {
  const nCtx = parseOptionalInt(config.params['ctx_size'])
  const nGpuLayers = parseOptionalInt(config.params['gpu_layers'])
  const nBatch = parseOptionalInt(config.params['batch_size'])
  return {
    modelPath: config.modelPath,
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir }),
    ...(config.marginMiB !== undefined && { marginMiB: config.marginMiB }),
    ...(config.nCtxMin !== undefined && { nCtxMin: config.nCtxMin }),
    ...(nCtx !== undefined && nCtx > 0 && { nCtx }),
    ...(nGpuLayers !== undefined && { nGpuLayers }),
    ...(nBatch !== undefined && { nBatch })
  }
}

function markerPath(stateDir: string, config: FitConfig) {
  const key = generateShortHash(
    JSON.stringify({
      modelPath: config.modelPath,
      nCtx: config.nCtx,
      nCtxMin: config.nCtxMin,
      nGpuLayers: config.nGpuLayers,
      marginMiB: config.marginMiB
    })
  )
  return path.join(stateDir, `${key}.running`)
}

export function crashMarkerPath(stateDir: string, config: FitLlamaProcessConfig) {
  return markerPath(stateDir, toFitConfig(config))
}

function exists(file: string) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function writeMarker(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
}

function clearMarker(file: string) {
  try {
    fs.unlinkSync(file)
  } catch {
    // Marker cleanup must not turn an advisory fit into a load failure.
  }
}

function unknown(reason: IsolatedFitUnknownReason, message: string) {
  return { status: 'unknown', reason, message }
}

function formatError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function defaultFit(config: FitConfig) {
  const { fitParams } = await import('@qvac/model-fit')
  return fitParams(config)
}

async function resolveStateDir(explicit: string | undefined) {
  if (explicit !== undefined) return explicit
  const { getCacheDir } = await import('@/utils/cache/paths')
  return getCacheDir('model-fit')
}

/**
 * In-process llama.cpp fit for hosts with no disposable child (Android/iOS).
 *
 * `fitParams` is a blocking native call. A leftover `.running` marker means a
 * previous call aborted the process; that model is `unknown` so the next launch
 * does not retry the same abort.
 */
export async function runInProcessFit(
  _loadKind: LlamaLoadKind,
  config: FitLlamaProcessConfig,
  options: RunInProcessFitOptions = {}
) {
  if (options.signal?.aborted === true) {
    return unknown('cancelled', 'In-process fit was cancelled')
  }

  const fitConfig = toFitConfig(config)
  const stateDir = await resolveStateDir(options.stateDir)
  const marker = markerPath(stateDir, fitConfig)

  if (exists(marker)) {
    clearMarker(marker)
    return unknown(
      'crashed',
      'Previous in-process fit did not finish; treating this model as unknown'
    )
  }

  try {
    writeMarker(marker)
  } catch (error) {
    return unknown(
      'invocation-error',
      `Fit crash marker could not be written: ${formatError(error)}`
    )
  }

  try {
    const fit = options.fit ?? defaultFit
    const result = await fit(fitConfig)
    return { status: 'completed' as const, result }
  } catch (error) {
    return unknown('invocation-error', formatError(error))
  } finally {
    clearMarker(marker)
  }
}
