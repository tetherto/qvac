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

/**
 * Stable `ggml_type` ordinals from `ggml.h` (the header `fitParams` is compiled
 * against). Names llama.cpp has kept numbered since the enum was frozen:
 * F32=0, F16=1, Q4_0=2, Q4_1=3, (4/5 removed Q4_2/Q4_3), Q5_0=6, Q5_1=7,
 * Q8_0=8, Q8_1=9, IQ4_NL=20, BF16=30. Unmapped names (TurboQuant/PolarQuant)
 * fail the conversion instead of silently projecting against llama defaults.
 */
const GGML_TYPE: Record<string, number> = {
  f32: 0,
  f16: 1,
  q4_0: 2,
  q4_1: 3,
  q5_0: 6,
  q5_1: 7,
  q8_0: 8,
  q8_1: 9,
  iq4_nl: 20,
  bf16: 30
}

/** `enum llama_flash_attn_type` — domain checked in `@qvac/model-fit` index.js. */
const FLASH_ATTN_TYPE: Record<string, number> = {
  auto: -1,
  off: 0,
  on: 1
}

/** `enum llama_split_mode`. */
const SPLIT_MODE: Record<string, number> = {
  none: 0,
  layer: 1,
  row: 2
}

function parseOptionalInt(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return undefined
  return parsed
}

function lookup(table: Record<string, number>, value: string | undefined, label: string) {
  if (value === undefined) return undefined
  const mapped = table[value.toLowerCase()]
  if (mapped === undefined) {
    throw new TypeError(`Unsupported ${label} for in-process fit: ${value}`)
  }
  return mapped
}

function param(config: FitLlamaProcessConfig, ...keys: string[]) {
  for (const key of keys) {
    const value = config.params[key]
    if (value !== undefined) return value
  }
  return undefined
}

export function toFitConfig(config: FitLlamaProcessConfig) {
  const nCtx = parseOptionalInt(param(config, 'ctx_size', 'ctx-size'))
  const nGpuLayers = parseOptionalInt(
    param(config, 'gpu_layers', 'gpu-layers', 'n-gpu-layers', 'n_gpu_layers')
  )
  const nBatch = parseOptionalInt(param(config, 'batch_size', 'batch-size'))
  const mainGpu = parseOptionalInt(param(config, 'main-gpu', 'main_gpu'))
  const typeK = lookup(GGML_TYPE, param(config, 'cache-type-k'), 'KV cache type')
  const typeV = lookup(GGML_TYPE, param(config, 'cache-type-v'), 'KV cache type')
  const flashAttnType = lookup(
    FLASH_ATTN_TYPE,
    param(config, 'flash-attn', 'flash_attn'),
    'flash-attn'
  )
  const splitMode = lookup(SPLIT_MODE, param(config, 'split-mode', 'split_mode'), 'split-mode')
  // device, load_mode, parallel, and tensor-split are fit evidence on the
  // process path but are not fields on public FitConfig — omitting them here
  // is the API limit, not a silent default.
  return {
    modelPath: config.modelPath,
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir }),
    ...(config.marginMiB !== undefined && { marginMiB: config.marginMiB }),
    ...(config.nCtxMin !== undefined && { nCtxMin: config.nCtxMin }),
    ...(nCtx !== undefined && nCtx > 0 && { nCtx }),
    ...(nGpuLayers !== undefined && { nGpuLayers }),
    ...(nBatch !== undefined && { nBatch }),
    ...(mainGpu !== undefined && { mainGpu }),
    ...(typeK !== undefined && { typeK }),
    ...(typeV !== undefined && { typeV }),
    ...(flashAttnType !== undefined && { flashAttnType }),
    ...(splitMode !== undefined && { splitMode })
  }
}

function markerKey(config: FitConfig) {
  return generateShortHash(JSON.stringify(config))
}

function runningMarkerPath(stateDir: string, config: FitConfig) {
  return path.join(stateDir, `${markerKey(config)}.running`)
}

function crashedMarkerPathForConfig(stateDir: string, config: FitConfig) {
  return path.join(stateDir, `${markerKey(config)}.crashed`)
}

export function crashMarkerPath(stateDir: string, config: FitLlamaProcessConfig) {
  return runningMarkerPath(stateDir, toFitConfig(config))
}

export function crashedMarkerPath(stateDir: string, config: FitLlamaProcessConfig) {
  return crashedMarkerPathForConfig(stateDir, toFitConfig(config))
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

function persistCrash(running: string, crashed: string) {
  try {
    writeMarker(crashed)
    clearMarker(running)
  } catch {
    // Keep `.running` if `.crashed` could not be written so the next launch
    // still skips native instead of retrying the abort.
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
 * previous call aborted the process. That is converted to `.crashed` so later
 * launches skip native for the same path+config instead of retrying the abort.
 */
export async function runInProcessFit(
  _loadKind: LlamaLoadKind,
  config: FitLlamaProcessConfig,
  options: RunInProcessFitOptions = {}
) {
  if (options.signal?.aborted === true) {
    return unknown('cancelled', 'In-process fit was cancelled')
  }

  let fitConfig: FitConfig
  try {
    fitConfig = toFitConfig(config)
  } catch (error) {
    return unknown('invocation-error', formatError(error))
  }

  const stateDir = await resolveStateDir(options.stateDir)
  const running = runningMarkerPath(stateDir, fitConfig)
  const crashed = crashedMarkerPathForConfig(stateDir, fitConfig)

  if (exists(crashed) || exists(running)) {
    persistCrash(running, crashed)
    return unknown(
      'crashed',
      'Previous in-process fit did not finish; treating this model as unknown'
    )
  }

  try {
    writeMarker(running)
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
    clearMarker(running)
  }
}
