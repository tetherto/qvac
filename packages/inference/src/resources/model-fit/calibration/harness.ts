// Calibration harness for assessModelFit, as a module.
//
// Loads representative catalog models, measures resident and peak memory around
// real operations, and derives the coefficients that live in
// `calibration/<platform>.ts`. Two hosts run it: `scripts/calibrate-model-fit.ts`
// on a desktop runner (which registers the LLM plugin, then writes the fixture),
// and the SDK e2e consumer's calibration plugin inside the worker on a phone
// (where the plugins are already registered and the result travels back as the
// test output). Neither host is assumed here: the caller registers plugins,
// decides what to do with the result, and owns process exit.
//
// See METHODOLOGY.md next to this file for what the numbers mean.

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

// Every point is measured this many times. Single-shot loads were observed to
// vary by up to ~100 MiB run to run; all repeats enter the fit, and the upper
// bound is floored at the worst point seen.
const REPEATS = 3

// llama.cpp allocates the whole context at load — KV cache, engine overhead
// and compute buffers included — so the RSS delta during a completion should
// be near zero. A working delta above this threshold means the engine's
// allocation behaviour changed and this methodology needs re-checking.
const WORKING_DRIFT_WARN_BYTES = 64 * 1024 * 1024

// The KV cache grows by a known amount between the two contexts, so the deltas
// must too. A shortfall means the wrong KV width, or a counter missing memory.
const KV_OBSERVATION_FLOOR = 0.9

// The ratio multiplies the largest term and used to ship with no margin, which
// cost linux-x64 a held-out failure. 1% is how far the fitted slope moves
// between runs on one host. See METHODOLOGY.md.
const WEIGHT_UPPER_SLACK = 1.01

// A stalled download or a wedged engine call would otherwise run to the job
// timeout while holding an exclusive drained host, so every phase is bounded.
const DEFAULT_LOAD_TIMEOUT_MS = 30 * 60 * 1000
const COMPLETION_TIMEOUT_MS = 15 * 60 * 1000
const UNLOAD_TIMEOUT_MS = 5 * 60 * 1000

/**
 * What the run measures, and against which counter: `cpu` and `shared` read
 * RSS, `gpu` reads device memory. `shared` is a separate fixture from `gpu`
 * because an integrated GPU allocates out of system RAM.
 */
export type CalibrationPass = 'cpu' | 'gpu' | 'shared'

/**
 * What one platform family's run measures: two contexts per model so fixed
 * overhead and the per-token slope can be separated (a single point cannot
 * tell them apart), fit models spanning small–large artifact sizes to pin the
 * weight ratio, and one model held out of the fit entirely to check that the
 * derived upper bound actually holds.
 */
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

// Everything must stay well under a phone's per-process ceiling (iOS jetsam
// kills near it, and a killed harness measures nothing): smaller models, and
// the upper context halved so the held-out 4B load stays inside what a 6 GB
// device grants.
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
// Must be `device`, not `gpu_layers: 0`: the addon takes its KV default from the
// backend `device` selects, so a GPU device builds q8_0 against a subtracted f16.
//
// Mobile is here for a different reason than the desktops. Its memory is
// unified, so a GPU allocation is system RAM and RSS ought to see it — but on
// Android it does not: a run left to choose its own device executed on the GPU
// and measured flat persistent deltas, with KV growth at -3% of computed. The
// collector cannot even name the device (`bare-gpu-info` has no Android backend
// at the pinned libgpuinfo), so `hasGpu` reads false and the harness subtracts
// f16 while the engine builds q8_0. Forcing the CPU makes both consistent
// again. Coefficients from it describe CPU-resident execution, exactly as on
// the desktops; covering a phone's GPU needs a collector that can see it.
export function forcesCpu(platform: string) {
  return (
    platform.startsWith('linux') ||
    platform.startsWith('win32') ||
    platform === 'darwin-x64' ||
    isMobileCalibrationPlatform(platform)
  )
}

// Load anonymously wherever the CPU backend is forced. It copies mapped weights
// into its own buffers, so RSS counts them twice — linux read 1.7x the artifact
// — while win32 prefetches to the standby list and counts almost none. The
// anonymous copy is the memory the system must actually find; the mapped pages
// the default keeps are file-backed and evictable.
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

/**
 * The run stopped before producing coefficients. Every reason is a methodology
 * tripwire, not a transient: re-running without changing something will abort
 * again. `reason` is stable for callers; `message` says what to change.
 */
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
  /**
   * What the fixture module is named: `platform` for a system-memory run,
   * `<platform>-<backend>` for a GPU-resident one and `<platform>-<backend>-shared`
   * for an integrated-GPU one, so no two passes collide.
   */
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

/**
 * The collector's own records, read through an index-signature view. The metric
 * helpers below take whatever the collector reported rather than the normalized
 * type, exactly as `scripts/calibrate-model-fit.ts` does, so the two stay
 * trivially comparable.
 */
type GpuRecord = Record<string, unknown>

function metricValue(metric: unknown) {
  const m = metric as { status?: string; value?: unknown } | undefined
  return m?.status === 'supported' ? m.value : undefined
}

// An adapter this small holds no model: Windows types its Intel iGPU as
// dedicated because it declares 128 MiB of its own, so declared memory is the
// only field that separates the two there. Same floor as `MIN_USABLE_GPU_BYTES`
// in `assess.ts`.
const MIN_USABLE_GPU_BYTES = 1024 * 1024 * 1024

// Whether this device's memory is system RAM: an integrated GPU, or the
// Windows iGPU case above.
function isSharedMemoryGpu(gpu: GpuRecord) {
  // `=== true`, not `!== false`: an unreported flag is not evidence of sharing,
  // and `allocatesFromSystemMemory` in `assess.ts` reads it the same way.
  if (metricValue(gpu['unifiedMemory']) === true) return true
  const declared = metricValue(gpu['memoryTotalBytes'])
  return typeof declared === 'number' && declared < MIN_USABLE_GPU_BYTES
}

// `gpuType.VIRTUAL`: a VM's paravirtual adapter, which has no compute backend.
// Mirrors `assess.ts`, so both agree on which devices count.
const GPU_TYPE_VIRTUAL = 3

function isVirtualDisplayAdapter(gpu: GpuRecord) {
  return metricValue(gpu['type']) === GPU_TYPE_VIRTUAL
}

// Ordered as `GPU_BACKENDS` in `assess.ts` is: by what the addon actually
// builds, not by what the drivers advertise.
const GPU_BACKENDS = ['metal', 'vulkan', 'rocm', 'cuda', 'levelZero', 'opencl'] as const

function gpuDrivers(gpu: GpuRecord) {
  return (gpu['drivers'] ?? {}) as Record<string, { status?: string; value?: unknown } | undefined>
}

function hasKnownBackend(gpu: GpuRecord) {
  const drivers = gpuDrivers(gpu)
  return GPU_BACKENDS.some((name) => drivers[name]?.status === 'supported' && drivers[name]?.value)
}

// Largest dedicated GPU first. The win25 runner reports an Intel iGPU ahead of
// its RTX 4000, and first-wins named the iGPU as the device on every fixture.
// A `shared` pass wants the opposite order: it pins the integrated device, so
// the backend and name recorded on the fixture have to be that device's.
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

/**
 * Bytes resident on the GPU the engine would pick. Read through the collector
 * so the calibration and the estimator agree on which device counts and on
 * whether its readings are device-scoped at all.
 */
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

  // Returning 0 here would read as "nothing allocated" and quietly fit garbage.
  throw new CalibrationAbortedError(
    'gpu-counter-unavailable',
    'no GPU reports device-scoped used memory, so this host cannot be calibrated for GPU residency.'
  )
}

// The driver frees device memory asynchronously, so a fixed settle can read a
// baseline that still holds the previous load: one repeat measured 1781 MiB
// against 690 for the same model. Wait for two readings to agree instead.
const GPU_SETTLE_TOLERANCE_BYTES = 16 * 1024 * 1024
const GPU_SETTLE_ATTEMPTS = 40

// Device memory during a completion, polled rather than sampled at 25 ms: the
// counter is only readable through an async collector call.
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

/**
 * Label for the backend in play, recorded with the coefficients because the
 * buffers they measure are allocated by the backend, and used as the GPU
 * fixture key. Must stay in step with `GPU_BACKENDS` in `assess.ts`: the
 * estimator derives the same key the same way, and a fixture filed under a
 * backend the engine does not use would be served to hosts it never measured.
 */
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

/**
 * KV-cache bytes the engine allocated for one model at one context, computed
 * by the estimator's own exported accounting rather than a local copy — a copy
 * drifted from `estimators/llm.ts` once already.
 *
 * The residuals this harness fits describe everything *except* the cache, so a
 * cache whose size the file does not state exactly (an engine-owned layer
 * pattern or hybrid block choice) cannot be subtracted. That surfaces as a
 * non-degenerate range, and the harness stops: calibration models must be
 * dense.
 */
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
        // Pin the class of device rather than an index: `chooseBackend` then
        // considers only integrated ggml devices, so a host with a discrete
        // card as well still measures the integrated one.
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

  // Both passes sample across the completion, against their own counter.
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
    // `final`, not `text`: it carries the stats the device check reads, and it
    // is the promise that resolves when generation has actually finished.
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
  // Unquote the keys only. Values stay JSON-quoted, which is already valid
  // TypeScript; replacing every quote breaks any value containing one, and
  // prettier settles the house quote style afterwards anyway.
  const json = JSON.stringify(calibration, null, 2).replace(/"([a-zA-Z]+)":/g, '$1:')
  // Assembled so tsc-alias leaves it alone: it rewrites `@/` specifiers inside
  // string literals too, and the fixture must import the alias, not a path
  // relative to wherever this module compiled to.
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

/**
 * Turns a fit into shippable coefficients: ±20% bounds, with the fixed-overhead
 * upper bound floored at the worst point observed above the fitted plane.
 * `validated` starts false; the held-out check decides it.
 */
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
      // Floored at the worst point observed: an upper bound that does not
      // cover a measurement is not an upper bound.
      upper: Math.round((fit.fixedBytes + fit.worstExcessBytes) * 1.2)
    },
    computeBufferBytesPerToken: {
      lower: Math.round(fit.perTokenBytes * 0.8),
      upper: Math.round(fit.perTokenBytes * 1.2)
    },
    // Audio coefficients need a whisper pass; left at zero until that runs.
    // `estimateWhisper` refuses to consume the zeros, so audio workloads
    // assess as unknown rather than as a confident under-estimate.
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

/**
 * Aborts when the engine did not execute where the pass assumes: a `shared`
 * pass on a host with no integrated device falls back to the CPU, and would
 * file CPU numbers under a GPU backend key.
 */
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

/**
 * Runs the whole procedure on this host and returns the coefficients with
 * everything needed to judge them. The LLM plugin must already be registered.
 *
 * Aborts throw `CalibrationAbortedError`; a failed held-out check does not —
 * it returns with `validated: false`, because the coefficients are still
 * worth auditing even though they must not ship.
 */
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

  // The fit subtracts the KV cache from each load's persistent delta, so the
  // cache subtracted has to be the one the engine actually allocated. A fixed
  // f16 assumption over-subtracts by nearly 2x on a Metal or Vulkan backend —
  // and since the error scales with context, it lands in the per-token slope
  // rather than the intercept, corrupting the very coefficient the two-context
  // design exists to isolate.
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
  // No device on a CPU-forced fixture: naming a card the run deliberately did
  // not use would misdescribe what the coefficients cover.
  const device = cpuForced ? undefined : gpuName(gpuRecords, shared)
  log(
    `backend: ${backend}${device ? ` (${device})` : ''}${cpuForced ? ' — GPU offload disabled for calibration' : ''}`
  )

  // A shared pass needs an integrated device to select, and a platform whose
  // own fixture is CPU-resident. On unified memory it would duplicate it.
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

  // What the engine must report executing on for the counter this pass reads to
  // be the right one. Left unconstrained only where the platform fixture is not
  // CPU-forced and no GPU is reported at all.
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

  // The first load in a process reads high — arenas and caches that later loads
  // reuse — and these coefficients describe warm loads. Left in, it landed as a
  // 30% spread the repeat check reported as a busy host, and skewed the linux
  // weight ratio to 1.7. Warm up on the smallest model and throw it away.
  const warmUpModel = profile.fitModels[0]
  if (warmUpModel) {
    log('warm-up load (not measured)')
    // Checked on the warm-up too, so a host that cannot honour this pass fails
    // before spending half an hour measuring the wrong thing.
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
        // `.lower` is the width a GPU backend defaults to (q8_0), and equals
        // f16 when no GPU is reported — what the engine allocates in each
        // case, not an optimistic bound borrowed from the estimator's range.
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

  // Judge the counter before the fit: the KV cache grows by an exactly known
  // amount between the two contexts, and every sound counter has to see it.
  const observation = kvObservation(measurements)
  log('KV growth between contexts, computed vs observed:')
  for (const growth of observation.models) {
    const model = measurements.find((m) => m.artifactBytes === growth.artifactBytes)
    log(
      `  ${model?.name ?? mib(growth.artifactBytes) + ' MiB'}: kv +${mib(growth.kvDeltaBytes)} MiB, persistent +${mib(growth.observedDeltaBytes)} MiB (${((growth.observedDeltaBytes / growth.kvDeltaBytes) * 100).toFixed(0)}%)`
    )
  }
  if (observation.ratio < KV_OBSERVATION_FLOOR) {
    // The same shortfall read against the other width the engine could have
    // chosen: a ratio near 1 there names the cause outright.
    const width = Math.max(...elementWidths)
    const other = kvElementBytes(measurements[0]!.facts, !hasGpu).bytes.lower
    const otherRatio = (observation.ratio * width) / other
    const executedOn = [...backendDevices].join('/') || 'an unreported device'
    throw new CalibrationAbortedError(
      'kv-observation-shortfall',
      `the persistent deltas grew by ${(observation.ratio * 100).toFixed(0)}% of the KV cache computed at ${width} bytes per element (floor ${KV_OBSERVATION_FLOOR * 100}%); at ${other} bytes per element the same growth reads as ${(otherRatio * 100).toFixed(0)}%. The engine executed on ${executedOn}. Either it built a different cache type than the one subtracted, or the counter is missing allocation; nothing fitted on these points is an upper bound.`
    )
  }

  // Fail loudly rather than fitting nonsense: a load that measured smaller
  // than the KV cache it supposedly allocated means the assumed cache type
  // does not match what the engine did.
  const negative = measurements.filter((m) => m.persistentBytes - m.kvBytes < 0)
  if (negative.length > 0) {
    // Weights far below artifact size with a GPU present means the model went
    // to discrete GPU memory, which process RSS cannot observe; RSS-based
    // calibration only works on unified-memory or CPU-resident hosts.
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

  // Busy-host tripwires. Co-scheduled work cannot inflate this process's RSS,
  // but memory pressure can evict its mapped pages and DEFLATE the persistent
  // deltas — the dangerous direction for an upper bound. Deflation shows up as
  // a weight ratio well below 1 (quiet-host runs measured ~1.0) or as repeats
  // of the same point disagreeing; neither aborts, because a platform could
  // legitimately page weights lazily, but a fixture from a warned run should
  // not ship without a quiet re-run.
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

  // The peak a completion adds on top of the load: measured directly, since
  // the fit reads persistent deltas only.
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

  // Predict with the width this run actually allocated, not the estimator's f16
  // upper end. Using f16 here on a q8_0 backend would pad the prediction by the
  // whole cache-type spread and let weak coefficients through the gate; the
  // point is to test the fit, not the conservatism of the range. The held-out
  // model is measured as many times as a fit point, against the worst total.
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
