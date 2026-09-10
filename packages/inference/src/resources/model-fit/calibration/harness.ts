// Calibration harness for assessModelFit. The caller registers plugins and owns
// process exit; see METHODOLOGY.md for what the numbers mean.

import os from 'bare-os'
import { loadModel } from '@/api/load-model'
import { completion } from '@/api/completion-stream'
import { unloadModel } from '@/api/unload-model'
import { getSystemResources } from '@/api/get-system-resources'
import * as catalog from '@/models/registry/index'
import { MODEL_RESOURCE_PROFILES } from '@/models/registry/resource-profiles'
import { kvElementBytes, kvCacheBytesForWidth } from '@/resources/model-fit/estimators/llm'
import {
  fitResidentMemory,
  kvObservation,
  type ResidentFit
} from '@/resources/model-fit/calibration/fit'
import type { GgufFacts } from '@/schemas/model-resource-profile'
import type { ModelDescriptor } from '@/schemas/model-src-utils'
import type { PlatformCalibration } from '@/resources/model-fit/types'

const SAMPLE_INTERVAL_MS = 25
const SETTLE_MS = 250

// Single-shot loads vary by up to ~100 MiB run to run; every repeat enters the fit.
const REPEATS = 3

// llama.cpp allocates the whole context at load, so the RSS delta during a
// completion should be near zero; above this the methodology needs re-checking.
const WORKING_DRIFT_WARN_BYTES = 64 * 1024 * 1024

// The KV cache grows by a known amount between contexts; a shortfall means the
// wrong KV width or a counter missing memory.
const KV_OBSERVATION_FLOOR = 0.9

// 1% is how far the fitted weight ratio moves between runs on one host.
const WEIGHT_UPPER_SLACK = 1.01

// Every phase is bounded so a stall cannot hold an exclusive host to the job timeout.
const DEFAULT_LOAD_TIMEOUT_MS = 30 * 60 * 1000
const COMPLETION_TIMEOUT_MS = 15 * 60 * 1000
const UNLOAD_TIMEOUT_MS = 5 * 60 * 1000

// `cpu` and `shared` read RSS, `gpu` reads device memory; `shared` is its own
// fixture because an integrated GPU allocates out of system RAM.
export type CalibrationPass = 'cpu' | 'gpu' | 'shared'

// Two contexts separate fixed overhead from the per-token slope; the held-out
// model checks that the derived upper bound holds.
export interface CalibrationProfile {
  name: 'desktop' | 'mobile'
  contexts: readonly [number, number]
  fitModels: readonly string[]
  heldOutModel: string
}

export const DESKTOP_CALIBRATION_PROFILE: CalibrationProfile = {
  name: 'desktop',
  contexts: [512, 8192],
  fitModels: ['QWEN3_600M_INST_Q4', 'LLAMA_3_2_1B_INST_Q4_0', 'QWEN3_4B_INST_Q4_K_M'],
  heldOutModel: 'QWEN3_8B_INST_Q4_K_M'
}

// Sized to stay under a phone's per-process ceiling: iOS jetsam kills near it.
export const MOBILE_CALIBRATION_PROFILE: CalibrationProfile = {
  name: 'mobile',
  contexts: [512, 4096],
  fitModels: ['QWEN3_600M_INST_Q4', 'LLAMA_3_2_1B_INST_Q4_0', 'QWEN3_1_7B_INST_Q4'],
  heldOutModel: 'QWEN3_4B_INST_Q4_K_M'
}

/** The `<platform>-<arch>` key fixtures are named after, for the running process. */
export function calibrationPlatform() {
  return `${os.platform()}-${os.arch()}`
}

export function isMobileCalibrationPlatform(platform: string) {
  return platform.startsWith('android') || platform.startsWith('ios')
}

export function calibrationProfileFor(platform: string): CalibrationProfile {
  return isMobileCalibrationPlatform(platform)
    ? MOBILE_CALIBRATION_PROFILE
    : DESKTOP_CALIBRATION_PROFILE
}

// RSS cannot observe VRAM, so these platforms calibrate CPU-resident execution.
// Must be `device`, not `gpu_layers: 0`: the KV default follows the backend
// `device` selects. Mobile is forced too: Android ran on a GPU the collector
// cannot see, so RSS missed the allocation and the subtracted KV width was wrong.
export function forcesCpu(platform: string) {
  return (
    platform.startsWith('linux') ||
    platform.startsWith('win32') ||
    platform === 'darwin-x64' ||
    isMobileCalibrationPlatform(platform)
  )
}

// Anonymous load wherever the CPU is forced: mapped pages are file-backed and
// RSS counts them differently per OS; the anonymous copy is what the system must find.
export function calibrationLoadMode(platform: string) {
  return forcesCpu(platform) ? 'none' : undefined
}

export type CalibrationAbortReason =
  | 'unknown-model'
  | 'no-gguf-facts'
  | 'kv-not-exact'
  | 'kv-observation-shortfall'
  | 'negative-residual'
  | 'degenerate-fit'
  | 'timeout'
  | 'gpu-counter-unavailable'
  | 'gpu-not-settled'
  | 'backend-device-mismatch'
  | 'shared-pass-unsupported'

// Every reason is a methodology tripwire, not a transient: re-running unchanged
// aborts again. `reason` is stable for callers; `message` says what to change.
export class CalibrationAbortedError extends Error {
  readonly reason: CalibrationAbortReason

  constructor(reason: CalibrationAbortReason, message: string) {
    super(message)
    this.name = 'CalibrationAbortedError'
    this.reason = reason
  }
}

export interface CalibrationMeasurement {
  name: string
  contextTokens: number
  artifactBytes: number
  facts: GgufFacts
  persistentBytes: number
  workingBytes: number
  kvBytes: number
  /** What the engine reported executing on, when the addon supplies it. */
  backendDevice?: 'cpu' | 'gpu'
}

export interface HeldOutCheck {
  model: string
  contextTokens: number
  worstTotalBytes: number
  predictedUpperBytes: number
  holds: boolean
}

export interface CalibrationRun {
  platform: string
  /** `platform`, `<platform>-<backend>` (gpu) or `<platform>-<backend>-shared`. */
  fixtureKey: string
  profile: CalibrationProfile
  pass: CalibrationPass
  /** `'none'` when weights were loaded anonymously; absent for the default mmap load. */
  loadMode?: 'none'
  backend: string
  device?: string
  cpuForced: boolean
  /** What the engine reported executing on, across the measured points. */
  backendDevices: readonly ('cpu' | 'gpu')[]
  measurements: readonly CalibrationMeasurement[]
  fit: ResidentFit
  calibration: PlatformCalibration
  heldOut: HeldOutCheck
  /** Busy-host and methodology warnings. A fixture from a warned run should not ship. */
  warnings: readonly string[]
  /** The `<fixtureKey>.ts` module source, ready to commit verbatim. */
  fixtureSource: string
}

export interface CalibrationRunOptions {
  /** Defaults to the running process's platform. */
  platform?: string
  /** Defaults to the profile for `platform`. */
  profile?: CalibrationProfile
  /** Defaults to `'cpu'`: the system-memory pass every platform has a fixture for. */
  pass?: CalibrationPass
  /** Receives progress and warnings as they happen; the run is long and silent otherwise. */
  log?: (line: string) => void
  loadTimeoutMs?: number
}

function rssBytes() {
  const usage = os.memoryUsage()
  return usage && usage.rss > 0 ? usage.rss : 0
}

function createSampler() {
  const samples: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  function tick() {
    if (!running) return
    const rss = rssBytes()
    if (rss > 0) samples.push(rss)
    timer = setTimeout(tick, SAMPLE_INTERVAL_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    start() {
      running = true
      tick()
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
      const rss = rssBytes()
      if (rss > 0) samples.push(rss)
      return samples.length > 0 ? Math.max(...samples) : 0
    }
  }
}

function settle() {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), SETTLE_MS))
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number, hint: string) {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new CalibrationAbortedError(
          'timeout',
          `${label} did not finish within ${timeoutMs / 60000} minutes; ${hint}`
        )
      )
    }, timeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Index-signature view of the collector's records: the helpers read whatever it reported.
type GpuRecord = Record<string, unknown>

function metricValue(metric: unknown) {
  const m = metric as { status?: string; value?: unknown } | undefined
  return m?.status === 'supported' ? m.value : undefined
}

// Windows types its Intel iGPU as dedicated with 128 MiB declared, so declared
// memory is what separates the two. Same floor as `assess.ts`.
const MIN_USABLE_GPU_BYTES = 1024 * 1024 * 1024

function isSharedMemoryGpu(gpu: GpuRecord) {
  // `=== true`: an unreported flag is not evidence of sharing (same as `assess.ts`).
  if (metricValue(gpu['unifiedMemory']) === true) return true
  const declared = metricValue(gpu['memoryTotalBytes'])
  return typeof declared === 'number' && declared < MIN_USABLE_GPU_BYTES
}

// `gpuType.VIRTUAL`: a paravirtual adapter with no compute backend (as in `assess.ts`).
const GPU_TYPE_VIRTUAL = 3

function isVirtualDisplayAdapter(gpu: GpuRecord) {
  return metricValue(gpu['type']) === GPU_TYPE_VIRTUAL
}

// Same order as `GPU_BACKENDS` in `assess.ts`: what the addon builds, not what drivers advertise.
const GPU_BACKENDS = ['metal', 'vulkan', 'rocm', 'cuda', 'levelZero', 'opencl'] as const

function gpuDrivers(gpu: GpuRecord) {
  return (gpu['drivers'] ?? {}) as Record<string, { status?: string; value?: unknown } | undefined>
}

function hasKnownBackend(gpu: GpuRecord) {
  const drivers = gpuDrivers(gpu)
  return GPU_BACKENDS.some((name) => drivers[name]?.status === 'supported' && drivers[name]?.value)
}

// Largest dedicated GPU first; a `shared` pass prefers the integrated device it pins.
function byCapability(gpuList: readonly GpuRecord[], preferShared = false) {
  function rank(gpu: GpuRecord) {
    const shared = isSharedMemoryGpu(gpu)
    return (preferShared ? shared : !shared) ? 1 : 0
  }
  function memory(gpu: GpuRecord) {
    const declared = metricValue(gpu['memoryTotalBytes'])
    return typeof declared === 'number' ? declared : 0
  }
  return [...gpuList].sort((a, b) => rank(b) - rank(a) || memory(b) - memory(a))
}

// Read through the collector so calibration and estimator agree on which device counts.
async function readGpuUsedBytes() {
  // `sample: true` is required: the default response carries capabilities only.
  const resources = await getSystemResources({ sample: true })
  const gpus = resources.capabilities.gpus
  const samples = resources.sample?.gpus
  if (gpus.status !== 'supported' || samples?.status !== 'supported') {
    throw new CalibrationAbortedError(
      'gpu-counter-unavailable',
      'no GPU sample is available, so a GPU pass cannot be measured.'
    )
  }

  for (const gpu of byCapability(gpus.value as unknown as GpuRecord[])) {
    const sample = samples.value.find((entry) => entry.id === (gpu['id'] as string))
    if (sample?.memoryUsedBytes.status === 'supported') return sample.memoryUsedBytes.value
  }

  // Returning 0 would read as "nothing allocated" and fit garbage.
  throw new CalibrationAbortedError(
    'gpu-counter-unavailable',
    'no GPU reports device-scoped used memory, so this host cannot be calibrated for GPU residency.'
  )
}

// Device memory frees asynchronously; wait for two readings to agree instead of a fixed settle.
const GPU_SETTLE_TOLERANCE_BYTES = 16 * 1024 * 1024
const GPU_SETTLE_ATTEMPTS = 40

// Polled, not sampled at 25 ms: the counter is only readable through an async call.
const GPU_SAMPLE_INTERVAL_MS = 250

function createGpuSampler() {
  let running = false
  let peak = 0
  let loop: Promise<void> | undefined

  return {
    start() {
      running = true
      loop = (async () => {
        while (running) {
          try {
            const used = await readGpuUsedBytes()
            if (used > peak) peak = used
          } catch {
            // One failed reading must not end the sample.
          }
          await new Promise<void>((resolve) => setTimeout(() => resolve(), GPU_SAMPLE_INTERVAL_MS))
        }
      })()
    },
    async stop() {
      running = false
      await loop
      return peak
    }
  }
}

async function settledGpuUsedBytes() {
  let previous = await readGpuUsedBytes()
  for (let attempt = 0; attempt < GPU_SETTLE_ATTEMPTS; attempt++) {
    await settle()
    const current = await readGpuUsedBytes()
    if (Math.abs(current - previous) <= GPU_SETTLE_TOLERANCE_BYTES) return current
    previous = current
  }
  throw new CalibrationAbortedError(
    'gpu-not-settled',
    `GPU memory did not settle within ${(GPU_SETTLE_ATTEMPTS * SETTLE_MS) / 1000}s; the device is not idle enough to calibrate.`
  )
}

// Must stay in step with `GPU_BACKENDS` in `assess.ts`: the estimator derives
// the fixture key the same way.
function detectBackend(gpuList: readonly GpuRecord[], preferShared = false) {
  for (const gpu of byCapability(gpuList, preferShared)) {
    const drivers = gpuDrivers(gpu)
    for (const name of GPU_BACKENDS) {
      if (drivers[name]?.status === 'supported' && drivers[name]?.value) return name
    }
  }
  return 'cpu'
}

function gpuName(gpuList: readonly GpuRecord[], preferShared = false) {
  for (const gpu of byCapability(gpuList, preferShared)) {
    const name = metricValue(gpu['name'])
    if (typeof name === 'string' && name) return name
  }
  return undefined
}

// Uses the estimator's own accounting. A cache the file does not size exactly
// cannot be subtracted, so calibration models must be dense.
function exactKvBytes(
  name: string,
  facts: GgufFacts,
  contextTokens: number,
  bytesPerElement: number
) {
  const kv = kvCacheBytesForWidth(facts, contextTokens, bytesPerElement)
  if (kv.lower !== kv.upper) {
    throw new CalibrationAbortedError(
      'kv-not-exact',
      `${name}'s KV cache is not exactly determined by the file (bounds span ${kv.lower}–${kv.upper} bytes); part of its layout is engine-owned, so it cannot be subtracted from a measurement. Use a dense model for calibration.`
    )
  }
  return kv.lower
}

type CatalogModel = ModelDescriptor & { sha256Checksum: string }

function catalogModel(name: string): CatalogModel {
  const entry = (catalog as Record<string, unknown>)[name]
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof (entry as Partial<CatalogModel>).sha256Checksum !== 'string'
  ) {
    throw new CalibrationAbortedError('unknown-model', `unknown catalog constant: ${name}`)
  }
  return entry as CatalogModel
}

interface MeasureContext {
  cpuForced: boolean
  loadMode: 'none' | undefined
  loadTimeoutMs: number
  pass: CalibrationPass
}

async function measure(name: string, contextTokens: number, ctx: MeasureContext) {
  const model = catalogModel(name)
  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  if (!profile?.ggufFacts) {
    throw new CalibrationAbortedError('no-gguf-facts', `no GGUF facts for ${name}`)
  }

  const gpuPass = ctx.pass === 'gpu'

  await settle()
  const before = gpuPass ? await settledGpuUsedBytes() : rssBytes()

  const modelId = await withTimeout(
    loadModel({
      modelSrc: model,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: contextTokens,
        ...(ctx.cpuForced && { device: 'cpu' }),
        // Pin the device class, not an index: `chooseBackend` then considers
        // only integrated devices.
        ...(ctx.pass === 'shared' && { 'main-gpu': 'integrated' as const }),
        ...(ctx.loadMode && { load_mode: ctx.loadMode })
      }
    }),
    `loading ${name}`,
    ctx.loadTimeoutMs,
    "a registry download has likely stalled. Check the registry's reachability from this host."
  )

  await settle()
  const afterLoad = gpuPass ? await settledGpuUsedBytes() : rssBytes()

  const sampler = gpuPass ? createGpuSampler() : createSampler()
  sampler.start()
  let peak = afterLoad
  let backendDevice: 'cpu' | 'gpu' | undefined
  try {
    const run = completion({
      modelId,
      history: [{ role: 'user', content: 'Summarize the history of cartography.' }],
      stream: false,
      generationParams: { predict: 128 }
    })
    // `final`, not `text`: it carries the stats and resolves when generation has finished.
    const final = await withTimeout(
      run.final,
      `completion for ${name}`,
      COMPLETION_TIMEOUT_MS,
      'the weights loaded, so this is a wedged engine call rather than a download stall.'
    )
    backendDevice = final.stats?.backendDevice
  } finally {
    peak = Math.max(afterLoad, await sampler.stop())
  }

  await withTimeout(
    unloadModel({ modelId }),
    `unloading ${name}`,
    UNLOAD_TIMEOUT_MS,
    'the engine call is wedged.'
  )
  await settle()

  return {
    name,
    contextTokens,
    artifactBytes: profile.artifactBytes,
    facts: profile.ggufFacts,
    persistentBytes: Math.max(0, afterLoad - before),
    workingBytes: Math.max(0, peak - afterLoad),
    ...(backendDevice && { backendDevice })
  }
}

export function fixtureSource(fixtureKey: string, calibration: PlatformCalibration) {
  // Unquote keys only; values stay JSON-quoted, which is valid TypeScript.
  const json = JSON.stringify(calibration, null, 2).replace(/"([a-zA-Z]+)":/g, '$1:')
  // Assembled so tsc-alias does not rewrite the `@/` specifier inside the string.
  const typesModule = ['@', 'resources', 'model-fit', 'types'].join('/')
  return `import type { PlatformCalibration } from '${typesModule}'

/**
 * ${fixtureKey} coefficients.
 *
 * Generated by the calibration harness; see \`METHODOLOGY.md\` next to this
 * file for how the numbers are derived and validated.
 */
export const ${fixtureKey.toUpperCase().replace(/-/g, '_')}_CALIBRATION: PlatformCalibration = ${json}
`
}

const mib = (n: number) => (n / 1024 / 1024).toFixed(0)

// ±20% bounds; `validated` starts false and the held-out check decides it.
export function deriveCalibration(
  fit: ResidentFit,
  provenance: {
    backend: string
    device?: string
    kvElementBytes: number
    worstWorkingBytes: number
    loadMode?: 'none'
    shared?: boolean
  }
): PlatformCalibration {
  const notes: string[] = []
  if (provenance.loadMode) {
    notes.push(
      `weights were loaded with load_mode '${provenance.loadMode}' so RSS counted them in full at load; a mapped weight set keeps at most the artifact size resident, so weightUpperCoeff remains an upper bound for the default mmap load`
    )
  }
  if (provenance.shared) {
    notes.push(
      "measured with 'main-gpu: integrated' and the SDK's default load mode, against process RSS: an integrated GPU allocates out of system RAM, so these coefficients belong to the system-memory basis and not to a device budget"
    )
  }

  return {
    weightUpperCoeff: Number((Math.max(1, fit.weightRatio) * WEIGHT_UPPER_SLACK).toFixed(3)),
    workingPeakBytes: { lower: 0, upper: Math.round(provenance.worstWorkingBytes * 1.2) },
    fixedOverheadBytes: {
      lower: Math.round(fit.fixedBytes * 0.8),
      // Floored at the worst point observed.
      upper: Math.round((fit.fixedBytes + fit.worstExcessBytes) * 1.2)
    },
    computeBufferBytesPerToken: {
      lower: Math.round(fit.perTokenBytes * 0.8),
      upper: Math.round(fit.perTokenBytes * 1.2)
    },
    // Audio needs a whisper pass; `estimateWhisper` refuses these zeros.
    audioWindowBytes: { lower: 0, upper: 0 },
    audioStreamingBytes: { lower: 0, upper: 0 },
    validated: false,
    ...(notes.length > 0 && { notes }),
    measuredAt: new Date().toISOString().slice(0, 10),
    measuredOn: {
      backend: provenance.backend,
      ...(provenance.device ? { device: provenance.device } : {}),
      kvElementBytes: provenance.kvElementBytes
    }
  }
}

/** The upper bound the coefficients predict for one load, as the estimator would compute it. */
export function predictedUpperBytes(
  calibration: PlatformCalibration,
  artifactBytes: number,
  contextTokens: number,
  kvBytes: number
) {
  return (
    artifactBytes * calibration.weightUpperCoeff +
    calibration.fixedOverheadBytes.upper +
    calibration.computeBufferBytesPerToken.upper * contextTokens +
    (calibration.workingPeakBytes?.upper ?? 0) +
    kvBytes
  )
}

// A pass that executed on the wrong device would file its numbers under the wrong key.
function checkBackendDevice(
  measurement: { name: string; backendDevice?: 'cpu' | 'gpu' },
  expected: 'cpu' | 'gpu' | undefined,
  warn: (line: string) => void
) {
  if (!expected) return
  if (!measurement.backendDevice) {
    warn(
      `the addon reported no backendDevice, so this run cannot confirm ${measurement.name} executed on the ${expected}`
    )
    return
  }
  if (measurement.backendDevice !== expected) {
    throw new CalibrationAbortedError(
      'backend-device-mismatch',
      `${measurement.name} executed on the ${measurement.backendDevice}, but this pass measures ${expected}-resident execution.`
    )
  }
}

// The LLM plugin must already be registered. Aborts throw; a failed held-out
// check returns `validated: false` so the coefficients can still be audited.
export async function runModelFitCalibration(
  options: CalibrationRunOptions = {}
): Promise<CalibrationRun> {
  const log = options.log ?? (() => {})
  const platform = options.platform ?? calibrationPlatform()
  const profile = options.profile ?? calibrationProfileFor(platform)
  const pass = options.pass ?? 'cpu'
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const warnings: string[] = []
  const warn = (line: string) => {
    warnings.push(line)
    log(`warning: ${line}`)
  }

  const passLabel = {
    cpu: '',
    gpu: ' (GPU-resident)',
    shared: ' (integrated GPU, system memory)'
  }[pass]
  log(
    `calibrating ${platform}${passLabel} (${profile.name} profile; fit: ${profile.fitModels.join(', ')}; held out: ${profile.heldOutModel}; contexts: ${profile.contexts.join('/')})`
  )

  const loadMode = pass === 'cpu' ? calibrationLoadMode(platform) : undefined
  if (loadMode) {
    log(`weights loaded with load_mode '${loadMode}' — see METHODOLOGY.md, "RSS and mmap"`)
  }

  // Subtract the cache the engine actually allocated: a fixed f16 assumption
  // over-subtracts ~2x on Metal or Vulkan and corrupts the per-token slope.
  const resources = await getSystemResources()
  const gpus = resources.capabilities.gpus
  const reported = gpus.status === 'supported' ? gpus.value : []
  const gpuRecords = (reported as unknown as GpuRecord[]).filter(
    (gpu) => !isVirtualDisplayAdapter(gpu) && hasKnownBackend(gpu)
  )
  if (gpuRecords.length < reported.length) {
    log(
      `ignoring ${reported.length - gpuRecords.length} reported GPU(s) the engine cannot use: a paravirtual display adapter, or no graphics API this build talks to`
    )
  }

  const cpuForced = pass === 'cpu' && forcesCpu(platform)
  // `device: 'cpu'` selects the CPU backend, and with it the f16 KV default.
  const hasGpu = gpuRecords.length > 0 && !cpuForced
  const shared = pass === 'shared'
  const backend = cpuForced ? 'cpu' : detectBackend(gpuRecords, shared)
  // No device on a CPU-forced fixture: the run did not use it.
  const device = cpuForced ? undefined : gpuName(gpuRecords, shared)
  log(
    `backend: ${backend}${device ? ` (${device})` : ''}${cpuForced ? ' — GPU offload disabled for calibration' : ''}`
  )

  // On unified memory a shared pass would duplicate the platform fixture.
  if (shared) {
    if (!forcesCpu(platform)) {
      throw new CalibrationAbortedError(
        'shared-pass-unsupported',
        `${platform} calibrates on its GPU already: its platform fixture is measured with the GPU active and RSS as the counter, because unified memory makes that the system basis. A separate integrated-GPU pass would measure the same thing.`
      )
    }
    if (gpuRecords.length === 0) {
      throw new CalibrationAbortedError(
        'shared-pass-unsupported',
        `no usable GPU is reported on this host, so there is nothing for 'main-gpu: integrated' to select.`
      )
    }
  }

  // Unconstrained only when nothing is forced and no GPU is reported.
  const expectedDevice: 'cpu' | 'gpu' | undefined = cpuForced
    ? 'cpu'
    : gpuRecords.length > 0
      ? 'gpu'
      : undefined

  const fixtureKey =
    pass === 'gpu'
      ? `${platform}-${backend}`
      : pass === 'shared'
        ? `${platform}-${backend}-shared`
        : platform

  const ctx: MeasureContext = { cpuForced, loadMode, loadTimeoutMs, pass }

  // The first load in a process reads high; these coefficients describe warm loads.
  const warmUpModel = profile.fitModels[0]
  if (warmUpModel) {
    log('warm-up load (not measured)')
    // Checked here too, so a host that cannot honour the pass fails early.
    const warmUp = await measure(warmUpModel, profile.contexts[0], ctx)
    log(`  warm-up executed on the ${warmUp.backendDevice ?? 'unreported device'}`)
    checkBackendDevice(warmUp, expectedDevice, warn)
  }

  const elementWidths = new Set<number>()
  const backendDevices = new Set<'cpu' | 'gpu'>()
  const measurements: CalibrationMeasurement[] = []
  for (const name of profile.fitModels) {
    for (const contextTokens of profile.contexts) {
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const measurement = await measure(name, contextTokens, ctx)
        checkBackendDevice(measurement, expectedDevice, warn)
        if (measurement.backendDevice) backendDevices.add(measurement.backendDevice)
        // `.lower` is the width the engine allocates for this backend.
        const bytesPerElement = kvElementBytes(measurement.facts, hasGpu).bytes.lower
        elementWidths.add(bytesPerElement)
        const kvBytes = exactKvBytes(name, measurement.facts, contextTokens, bytesPerElement)
        measurements.push({ ...measurement, kvBytes })
        log(
          `  ${name} @ ${contextTokens} (${repeat + 1}/${REPEATS}): persistent ${mib(measurement.persistentBytes)} MiB, working ${mib(measurement.workingBytes)} MiB, kv ${mib(kvBytes)} MiB, on ${measurement.backendDevice ?? '?'}`
        )
        if (measurement.workingBytes > WORKING_DRIFT_WARN_BYTES) {
          warn(
            `working delta is ${mib(measurement.workingBytes)} MiB for ${name} @ ${contextTokens} — the engine no longer allocates everything at load, so the persistent-based fit under-describes the peak`
          )
        }
      }
    }
  }

  if (elementWidths.size > 1) {
    warn(
      `the fit mixes KV element widths (${[...elementWidths].join(', ')} bytes), so the points do not describe a single cache type`
    )
  }

  // Judge the counter before the fit: every sound counter must see the KV growth.
  const observation = kvObservation(measurements)
  log('KV growth between contexts, computed vs observed:')
  for (const growth of observation.models) {
    const model = measurements.find((m) => m.artifactBytes === growth.artifactBytes)
    log(
      `  ${model?.name ?? mib(growth.artifactBytes) + ' MiB'}: kv +${mib(growth.kvDeltaBytes)} MiB, persistent +${mib(growth.observedDeltaBytes)} MiB (${((growth.observedDeltaBytes / growth.kvDeltaBytes) * 100).toFixed(0)}%)`
    )
  }
  if (observation.ratio < KV_OBSERVATION_FLOOR) {
    // Re-read against the other KV width: a ratio near 1 there names the cause.
    const width = Math.max(...elementWidths)
    const other = kvElementBytes(measurements[0]!.facts, !hasGpu).bytes.lower
    const otherRatio = (observation.ratio * width) / other
    const executedOn = [...backendDevices].join('/') || 'an unreported device'
    throw new CalibrationAbortedError(
      'kv-observation-shortfall',
      `the persistent deltas grew by ${(observation.ratio * 100).toFixed(0)}% of the KV cache computed at ${width} bytes per element (floor ${KV_OBSERVATION_FLOOR * 100}%); at ${other} bytes per element the same growth reads as ${(otherRatio * 100).toFixed(0)}%. The engine executed on ${executedOn}. Either it built a different cache type than the one subtracted, or the counter is missing allocation; nothing fitted on these points is an upper bound.`
    )
  }

  // A load smaller than its own KV cache means the assumed cache type is wrong.
  const negative = measurements.filter((m) => m.persistentBytes - m.kvBytes < 0)
  if (negative.length > 0) {
    // Weights far below artifact size with a GPU present: the model is in VRAM RSS cannot see.
    const offloaded = hasGpu && measurements.some((m) => m.persistentBytes < m.artifactBytes / 2)
    throw new CalibrationAbortedError(
      'negative-residual',
      offloaded
        ? `${negative.length} of ${measurements.length} points measured less persistent memory than the KV cache being subtracted: the model is in GPU memory this counter cannot observe. This methodology only calibrates unified-memory or CPU-resident hosts.`
        : `${negative.length} of ${measurements.length} points measured less persistent memory than the KV cache being subtracted: the assumed cache type does not match what the engine allocated.`
    )
  }

  const fit = fitResidentMemory(measurements)
  if (!fit) {
    throw new CalibrationAbortedError(
      'degenerate-fit',
      'the measurement design cannot separate the weight ratio, fixed overhead and per-token slope (degenerate fit).'
    )
  }
  log(
    `fit: weightRatio ${fit.weightRatio.toFixed(3)}, fixed ${mib(fit.fixedBytes)} MiB, perToken ${fit.perTokenBytes.toFixed(0)} B, worst excess ${mib(fit.worstExcessBytes)} MiB`
  )

  // Memory pressure evicts mapped pages and deflates the deltas, the dangerous
  // direction for an upper bound. Warn rather than abort: a platform may page lazily.
  if (fit.weightRatio < 0.9) {
    warn(
      `weightRatio ${fit.weightRatio.toFixed(3)} — resident weights landed well below artifact size. Either this platform pages weights lazily, or the host was under memory pressure during the run. Re-run on an idle host before trusting this fixture.`
    )
  }
  for (const name of profile.fitModels) {
    for (const contextTokens of profile.contexts) {
      const repeats = measurements.filter(
        (m) => m.name === name && m.contextTokens === contextTokens
      )
      const values = repeats.map((m) => m.persistentBytes)
      const spread = Math.max(...values) - Math.min(...values)
      const mean = values.reduce((total, v) => total + v, 0) / values.length
      if (mean > 0 && spread / mean > 0.15) {
        warn(
          `${name} @ ${contextTokens} repeats spread ${mib(spread)} MiB (${((spread / mean) * 100).toFixed(0)}% of mean) — the host does not look idle. Re-run on a quiet machine before trusting this fixture.`
        )
      }
    }
  }

  const worstWorking = Math.max(...measurements.map((m) => m.workingBytes))

  const calibration = deriveCalibration(fit, {
    backend,
    ...(device ? { device } : {}),
    kvElementBytes: Math.max(...elementWidths),
    worstWorkingBytes: worstWorking,
    ...(loadMode ? { loadMode } : {}),
    ...(shared ? { shared } : {})
  })
  log(`derived: ${JSON.stringify(calibration)}`)

  // Predict with the width this run allocated, not the estimator's f16 upper
  // end, so the gate tests the fit rather than the range's conservatism.
  const heldOutContext = profile.contexts[1]
  let worstTotalBytes = 0
  let heldOutKv = 0
  let heldOutArtifactBytes = 0
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    const heldOut = await measure(profile.heldOutModel, heldOutContext, ctx)
    checkBackendDevice(heldOut, expectedDevice, warn)
    const width = kvElementBytes(heldOut.facts, hasGpu).bytes.lower
    heldOutKv = exactKvBytes(profile.heldOutModel, heldOut.facts, heldOutContext, width)
    heldOutArtifactBytes = heldOut.artifactBytes
    worstTotalBytes = Math.max(worstTotalBytes, heldOut.persistentBytes + heldOut.workingBytes)
    log(
      `  held-out ${profile.heldOutModel} @ ${heldOutContext} (${repeat + 1}/${REPEATS}): persistent ${mib(heldOut.persistentBytes)} MiB, working ${mib(heldOut.workingBytes)} MiB`
    )
  }
  const predicted = predictedUpperBytes(
    calibration,
    heldOutArtifactBytes,
    heldOutContext,
    heldOutKv
  )
  const holds = worstTotalBytes <= predicted
  log(
    `held-out ${profile.heldOutModel}: worst measured ${(worstTotalBytes / 2 ** 30).toFixed(2)} GiB vs predicted upper ${(predicted / 2 ** 30).toFixed(2)} GiB — ${holds ? 'PASS' : 'FAIL'}`
  )
  if (!holds) log('the held-out peak exceeded the upper bound; do not ship these coefficients')
  calibration.validated = holds

  return {
    platform,
    fixtureKey,
    profile,
    pass,
    ...(loadMode ? { loadMode } : {}),
    backend,
    ...(device ? { device } : {}),
    cpuForced,
    backendDevices: [...backendDevices],
    measurements,
    fit,
    calibration,
    heldOut: {
      model: profile.heldOutModel,
      contextTokens: heldOutContext,
      worstTotalBytes,
      predictedUpperBytes: predicted,
      holds
    },
    warnings,
    fixtureSource: fixtureSource(fixtureKey, calibration)
  }
}
