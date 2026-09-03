import type {
  AssessModelFitResult,
  ModelFitBasis,
  ModelFitCandidate,
  ModelFitExecution,
  ModelFitModelResult,
  ModelFitVerdict
} from '@/schemas/assess-model-fit'
import type { GPUResourceCapabilities, SystemResources } from '@/schemas/system-resources'
import type { ModelResourceProfile } from '@/schemas/model-resource-profile'
import { getModelResourceProfile } from '@/models/registry/resource-profiles'
import { getGpuCalibration } from '@/resources/model-fit/calibration/index'
import { estimateLlm } from '@/resources/model-fit/estimators/llm'
import { estimateWhisper } from '@/resources/model-fit/estimators/whisper'
import type {
  ByteRange,
  EstimatorResult,
  ModelFitPlatform,
  PlatformCalibration
} from '@/resources/model-fit/types'

const GIB = 1024 * 1024 * 1024

/** Engines phase 1 can estimate, and which estimator owns each. */
const ESTIMATORS = {
  'llamacpp-completion': estimateLlm,
  'llamacpp-embedding': estimateLlm,
  'whispercpp-transcription': estimateWhisper
} as const

const MOBILE_PLATFORMS: readonly ModelFitPlatform[] = ['android-arm64', 'ios-arm64']

/**
 * Platforms where a reported GPU means discrete device memory. There the
 * engine executes the model in VRAM, which system-memory evidence cannot
 * bound in either direction — and their calibration fixtures describe
 * CPU-resident execution (`device: 'cpu'`). A model on such a host assesses
 * as `unknown` when a GPU is present; GPU-memory admission is out of scope
 * for this phase. Apple silicon and mobile are unified memory and unaffected.
 */
const DISCRETE_GPU_PLATFORMS: readonly ModelFitPlatform[] = [
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64'
]

/** Resolves a checksum to its catalog resource profile. */
export type ProfileResolver = (sha256Checksum: string) => ModelResourceProfile | undefined

export interface AssessModelFitOptions {
  models: readonly ModelFitCandidate[]
  execution: ModelFitExecution
  resources: SystemResources
  /**
   * `undefined` when the runtime's platform/arch pair is not a calibration
   * target. Also selects the mobile headroom policy.
   */
  platform: ModelFitPlatform | undefined
  /** `undefined` when the platform has no validated coefficients. */
  calibration: PlatformCalibration | undefined
  /**
   * Resolves GPU-resident coefficients once the target backend is known.
   * Defaults to the built-in fixtures; injected in tests.
   */
  resolveGpuCalibration?: (
    platform: ModelFitPlatform,
    backend: string
  ) => PlatformCalibration | undefined
  /** Defaults to the generated catalog table; injected in tests. */
  resolveProfile?: ProfileResolver
}

/**
 * Turns catalog profiles plus a fresh system-memory sample into an advisory
 * verdict.
 *
 * Pure: every input is passed in, so the same call is testable without a worker,
 * a device, or a network. Sampling, platform detection and calibration lookup
 * happen in the handler.
 */
export function assessModelFitFromResources(options: AssessModelFitOptions): AssessModelFitResult {
  const { models, execution, resources, platform, calibration } = options
  const resolveProfile = options.resolveProfile ?? getModelResourceProfile
  const resolveGpuCalibration = options.resolveGpuCalibration ?? getGpuCalibration

  // On a discrete-GPU host the model executes in the GPU's own memory, so
  // system RAM cannot bound it. Assess against the device instead, but only
  // when that GPU's readings are device-scoped and its backend is calibrated.
  const gpuTarget =
    platform && DISCRETE_GPU_PLATFORMS.includes(platform) && hasGpu(resources)
      ? resolveGpuTarget(resources)
      : undefined
  const gpuCalibration =
    gpuTarget && platform ? resolveGpuCalibration(platform, gpuTarget.backend) : undefined
  const gpuMode = gpuTarget !== undefined && gpuCalibration !== undefined
  const effectiveCalibration = gpuMode ? gpuCalibration : calibration

  const basis: ModelFitBasis = gpuMode
    ? gpuTarget!.scope === 'budget'
      ? 'device-budget'
      : 'device-memory'
    : resolveBasis(platform)
  const reasons: string[] = []
  const assumptions: string[] = [
    `execution mode '${execution}' is a declared assumption used for aggregation only; the SDK does not schedule, serialize, or reserve anything`,
    `the verdict is advisory and based on ${basisEvidence(basis)} alone; it does not block loadModel and makes no performance claim`
  ]

  if (gpuMode && gpuTarget) {
    assumptions.push(
      `the model is assumed to execute on ${gpuTarget.device ?? 'the discrete GPU'} via ${gpuTarget.backend}, and the budget is that device's own memory`
    )
  }

  if (platform === 'android-arm64') {
    assumptions.push(
      'android budgets deliberately use system memory: the low-memory killer acts system-wide and native allocations carry no per-process cap like iOS jetsam'
    )
  }

  const budget =
    gpuMode && gpuTarget
      ? gpuBudget(gpuTarget, platform)
      : resolveBudget(resources, platform, basis, reasons)

  // A GPU load also consumes system RAM, so the system budget bounds it too.
  const alsoBoundBy = gpuMode ? resolveBudget(resources, platform, 'system-memory', []) : undefined

  if (!platform) {
    reasons.push('the runtime platform is not one this assessment covers')
  } else if (!effectiveCalibration) {
    reasons.push(
      gpuTarget
        ? `no validated calibration for ${platform} on ${gpuTarget.backend}, so no estimate can be defended`
        : `no validated calibration for ${platform}, so no estimate can be defended`
    )
  } else if (effectiveCalibration.measuredAt) {
    assumptions.push(calibrationAssumption(platform, effectiveCalibration))
  }

  const evaluated = models.map((candidate) =>
    evaluate(candidate, platform, effectiveCalibration, resources, resolveProfile, gpuMode)
  )

  for (const { result } of evaluated) {
    for (const assumption of result.assumptions ?? []) {
      if (!assumptions.includes(assumption)) assumptions.push(assumption)
    }
  }

  const modelResults: ModelFitModelResult[] = evaluated.map(({ candidate, result }) =>
    toModelResult(candidate, result, budget, alsoBoundBy)
  )

  const estimates = evaluated
    .map(({ result }) => result)
    .filter((result): result is Extract<EstimatorResult, { kind: 'estimate' }> => {
      return result.kind === 'estimate'
    })

  const anyUnknown = estimates.length !== evaluated.length
  const combined = anyUnknown ? undefined : aggregate(estimates, execution)

  if (anyUnknown) {
    reasons.push('at least one model could not be estimated, so the combined verdict is unknown')
  }

  const verdict: ModelFitVerdict =
    !budget || !combined ? 'unknown' : verdictAgainst(combined, budget, alsoBoundBy)

  if (gpuMode && combined && alsoBoundBy) {
    reasons.push(
      'a GPU load is also paid for in system RAM, so every verdict is the more pessimistic of the GPU and system budgets'
    )
  }

  if (budget && combined) {
    reasons.push(
      execution === 'concurrent'
        ? 'all models counted as resident with every working peak added'
        : 'all models counted as resident with only the largest working peak added'
    )
  }

  return {
    verdict,
    basis,
    execution,
    ...(budget && { budget }),
    ...(combined && {
      estimate: { lowerBoundBytes: combined.lower, upperBoundBytes: combined.upper }
    }),
    models: modelResults,
    reasons,
    assumptions
  }
}

function evaluate(
  candidate: ModelFitCandidate,
  platform: ModelFitPlatform | undefined,
  calibration: PlatformCalibration | undefined,
  resources: SystemResources,
  resolveProfile: ProfileResolver,
  gpuMode: boolean
): { candidate: ModelFitCandidate; result: EstimatorResult } {
  if (!calibration) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: [
          platform
            ? `no validated calibration for ${platform}`
            : 'the runtime platform is not one this assessment covers'
        ]
      }
    }
  }

  // The engine executes in the GPU's own memory here, which system-memory
  // evidence cannot bound and the platform's CPU coefficients do not describe.
  // In GPU mode both have been replaced by their device-scoped equivalents.
  if (!gpuMode && platform && DISCRETE_GPU_PLATFORMS.includes(platform) && hasGpu(resources)) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: [
          'a discrete GPU is present, so the model executes in GPU memory that system-memory evidence cannot bound; GPU-memory admission is out of scope in this phase'
        ]
      }
    }
  }

  const profile = resolveProfile(candidate.model.sha256Checksum)
  if (!profile) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: ['no resource profile in the catalog for this checksum']
      }
    }
  }

  const estimator = ESTIMATORS[profile.engine as keyof typeof ESTIMATORS]
  if (!estimator) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: [`engine '${profile.engine}' has no estimator in this phase`]
      }
    }
  }

  const extra = extraArtifactBytes(candidate, resolveProfile)
  if (extra === undefined) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: ['an entry in `artifacts` has no resource profile in the catalog']
      }
    }
  }

  return {
    candidate,
    result: estimator({
      profile,
      workload: candidate.workload,
      extraArtifactBytes: extra,
      calibration,
      hasGpu: hasGpu(resources)
    })
  }
}

/**
 * Sums the artifact bytes of companion constants.
 *
 * @returns The total, or `undefined` when any companion is not in the catalog —
 *   an incomplete artifact set must not be silently under-counted.
 */
function extraArtifactBytes(
  candidate: ModelFitCandidate,
  resolveProfile: ProfileResolver
): number | undefined {
  if (!candidate.artifacts || candidate.artifacts.length === 0) return 0

  let total = 0
  for (const artifact of candidate.artifacts) {
    const profile = resolveProfile(artifact.sha256Checksum)
    if (!profile) return undefined
    total += profile.artifactBytes
  }
  return total
}

/**
 * States when, and under what conditions, this platform's coefficients were
 * measured.
 *
 * The backend belongs in the result because the buffers these coefficients
 * cover are allocated by it, while the coefficients themselves are keyed by
 * platform alone — so a fixture measured on one backend is being applied to
 * every backend on that platform. That is a real caveat, and the caller is
 * entitled to see it rather than read the fixture.
 */
function calibrationAssumption(
  platform: ModelFitPlatform,
  calibration: PlatformCalibration
): string {
  const base = `${platform} coefficients were calibrated on ${calibration.measuredAt}`
  const on = calibration.measuredOn
  if (!on) return base

  const device = on.device ? ` (${on.device})` : ''
  return `${base} against a ${on.backend} backend${device}, at ${on.kvElementBytes} bytes per KV element`
}

/**
 * Whether the device reports at least one GPU. Decides which KV-cache type the
 * engine would default to, and whether a GPU budget is worth resolving.
 */
function hasGpu(resources: SystemResources): boolean {
  const gpus = resources.capabilities.gpus
  return gpus.status === 'supported' && gpus.value.length > 0
}

/** The GPU the engine would execute on, when its memory can carry a budget. */
interface GpuTarget {
  backend: string
  totalBytes: number
  usedBytes: number
  /** `device` is the card's own memory; `budget` is this process's allowance. */
  scope: 'device' | 'budget'
  device?: string
}

// An adapter too small to hold any model we assess is not a candidate for one.
// Windows classifies the Intel iGPU as dedicated because it declares 128 MiB of
// its own, which is otherwise indistinguishable from a real card by type.
const MIN_USABLE_GPU_BYTES = GIB

// Only excludes a card when the declared memory says so. An unreported total
// leaves it counted, so an unknown device makes the choice ambiguous rather
// than silently disappearing from it.
function tooSmallToHostAModel(gpu: GPUResourceCapabilities) {
  return (
    gpu.memoryTotalBytes.status === 'supported' && gpu.memoryTotalBytes.value < MIN_USABLE_GPU_BYTES
  )
}

// Ordered by the backends the addon actually builds, not by what the device's
// drivers advertise: the NVIDIA calibration host advertises both CUDA and
// Vulkan, and every load on it reports `ggml_vulkan`, never `ggml_cuda`. The
// engine's own choice is not observable from here (`chooseBackend` is C++ and
// only reaches the llama log), so this order has to track the addon's build.
const GPU_BACKENDS = ['metal', 'vulkan', 'rocm', 'cuda', 'levelZero', 'opencl'] as const

function backendOf(gpu: GPUResourceCapabilities): string | undefined {
  for (const name of GPU_BACKENDS) {
    const driver = gpu.drivers[name]
    if (driver.status === 'supported' && driver.value) return name
  }
  return undefined
}

/**
 * Picks the discrete GPU whose memory can carry a budget, or nothing.
 *
 * A unified-memory GPU is excluded: its allocation is system RAM, which the
 * system basis already bounds. The sample metrics are only `supported` when
 * the collector established they describe that device's own pool, so an
 * integrated GPU reporting the shared pool never reaches here.
 *
 * Refuses outright when more than one dedicated GPU qualifies. The engine
 * picks the first eligible ggml device (`chooseBackend`), an order this side
 * cannot see, so choosing between them here risks budgeting one card while
 * inference runs on another. One candidate is the only unambiguous case.
 */
function resolveGpuTarget(resources: SystemResources): GpuTarget | undefined {
  const gpus = resources.capabilities.gpus
  const samples = resources.sample?.gpus
  if (gpus.status !== 'supported' || samples?.status !== 'supported') return undefined

  // Count the cards first. Filtering on the readings would let a GPU with a
  // failed sample drop out of the count, leaving its neighbour looking like the
  // only candidate — while the engine remains free to use the one that dropped.
  // Only a device property may exclude a card from the count, never a reading:
  // an adapter that cannot hold a model is not a rival for one.
  const candidates = gpus.value.filter((gpu) => {
    if (gpu.unifiedMemory.status !== 'supported' || gpu.unifiedMemory.value) return false
    return !tooSmallToHostAModel(gpu)
  })
  if (candidates.length !== 1) return undefined

  const gpu = candidates[0]!
  const backend = backendOf(gpu)
  if (!backend) return undefined

  const sample = samples.value.find((entry) => entry.id === gpu.id)
  if (!sample) return undefined
  if (sample.memoryTotalBytes.status !== 'supported') return undefined
  if (sample.memoryUsedBytes.status !== 'supported') return undefined
  if (sample.memoryTotalBytes.value <= 0) return undefined
  if (sample.memoryUsedBytes.value > sample.memoryTotalBytes.value) return undefined

  const scope = sample.memoryTotalBytes.provenance.scope === 'budget' ? 'budget' : 'device'

  return {
    backend,
    totalBytes: sample.memoryTotalBytes.value,
    usedBytes: sample.memoryUsedBytes.value,
    scope,
    ...(gpu.name.status === 'supported' && { device: gpu.name.value })
  }
}

function gpuBudget(target: GpuTarget, platform: ModelFitPlatform | undefined) {
  const reserved = reserveBytes(target.totalBytes, platform)
  return {
    totalBytes: target.totalBytes,
    usedBytes: target.usedBytes,
    reservedBytes: reserved,
    availableAfterReserveBytes: Math.max(0, target.totalBytes - target.usedBytes - reserved)
  }
}

/**
 * A verdict against the GPU budget and, when one applies, system memory too.
 *
 * A GPU load is paid for in system RAM as well — a 2382 MiB model raised RSS
 * by 2918 MiB on win32 and 868 MiB on linux — so a host with the card for it
 * but not the RAM must not read as a fit. Applied to every verdict, per model
 * and combined alike, so the two can never disagree.
 */
function verdictAgainst(
  estimate: ByteRange,
  budget: NonNullable<AssessModelFitResult['budget']>,
  alsoBoundBy: AssessModelFitResult['budget']
): ModelFitVerdict {
  const primary = compare(estimate, budget.availableAfterReserveBytes)
  if (!alsoBoundBy) return primary
  return worst(primary, compare(estimate, alsoBoundBy.availableAfterReserveBytes))
}

/** The more pessimistic of two verdicts. */
function worst(a: ModelFitVerdict, b: ModelFitVerdict): ModelFitVerdict {
  if (a === 'likely-too-large' || b === 'likely-too-large') return 'likely-too-large'
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  return 'likely-fits'
}

/**
 * Picks the budget basis for a platform.
 *
 * iOS is the exception: jetsam terminates an app on its own footprint against
 * a per-process limit well below device RAM, so a system-memory budget there
 * would defend `likely-fits` verdicts the OS does not honor. Android's
 * low-memory killer acts system-wide and native allocations carry no
 * per-process cap, so it deliberately keeps the system basis with the mobile
 * reserve.
 */
function resolveBasis(platform: ModelFitPlatform | undefined): ModelFitBasis {
  return platform === 'ios-arm64' ? 'process-memory' : 'system-memory'
}

function basisEvidence(basis: ModelFitBasis) {
  if (basis === 'process-memory') return 'this process’s own memory ceiling'
  if (basis === 'device-memory') return 'the GPU’s own memory'
  if (basis === 'device-budget') return 'the GPU memory this process is budgeted'
  return 'system memory'
}

/**
 * Derives the memory budget from the sample, under the platform's basis.
 *
 * Only `sample.memory` is used: capabilities-only totals say nothing about what
 * is free right now, and a verdict without that is not worth giving. Under the
 * process basis the ceiling is reconstructed as allowance + footprint — the
 * relation the OS enforces — so every budget field keeps the same meaning
 * under either basis.
 */
function resolveBudget(
  resources: SystemResources,
  platform: ModelFitPlatform | undefined,
  basis: ModelFitBasis,
  reasons: string[]
): AssessModelFitResult['budget'] {
  const sample = resources.sample
  if (!sample) {
    reasons.push('no memory sample was available')
    return undefined
  }

  if (basis === 'process-memory') {
    const available = sample.memory.processAvailableBytes
    const used = sample.memory.processUsedBytes
    if (available.status !== 'supported' || used.status !== 'supported') {
      reasons.push(
        'iOS budgets are per-process (jetsam terminates on the app’s own footprint), and the per-process allowance metric is not available on this build'
      )
      return undefined
    }

    const total = available.value + used.value
    if (total <= 0) {
      reasons.push('process-memory metrics are inconsistent')
      return undefined
    }

    const reserved = reserveBytes(total, platform)
    return {
      totalBytes: total,
      usedBytes: used.value,
      reservedBytes: reserved,
      availableAfterReserveBytes: Math.max(0, available.value - reserved)
    }
  }

  const total = sample.memory.totalBytes
  const used = sample.memory.usedBytes
  if (total.status !== 'supported' || used.status !== 'supported') {
    reasons.push('system-memory metrics are not supported on this platform')
    return undefined
  }

  if (total.value <= 0 || used.value > total.value) {
    reasons.push('system-memory metrics are inconsistent')
    return undefined
  }

  const reserved = reserveBytes(total.value, platform)
  return {
    totalBytes: total.value,
    usedBytes: used.value,
    reservedBytes: reserved,
    availableAfterReserveBytes: Math.max(0, total.value - used.value - reserved)
  }
}

/** `interactive-v1`: 2 GiB or 15% on desktop, 1 GiB or 20% on mobile. */
function reserveBytes(totalBytes: number, platform: ModelFitPlatform | undefined): number {
  const mobile = platform !== undefined && MOBILE_PLATFORMS.includes(platform)
  return mobile ? Math.max(1 * GIB, totalBytes * 0.2) : Math.max(2 * GIB, totalBytes * 0.15)
}

/**
 * Combines per-model bounds under the declared execution mode.
 *
 * Every model is resident either way — what differs is the working peak:
 * `sequential` counts only the largest, `concurrent` counts them all.
 */
function aggregate(
  estimates: readonly Extract<EstimatorResult, { kind: 'estimate' }>[],
  execution: ModelFitExecution
): ByteRange {
  let persistentLower = 0
  let persistentUpper = 0
  let workingLower = 0
  let workingUpper = 0

  for (const estimate of estimates) {
    persistentLower += estimate.persistent.lower
    persistentUpper += estimate.persistent.upper

    if (execution === 'concurrent') {
      workingLower += estimate.working.lower
      workingUpper += estimate.working.upper
    } else {
      workingLower = Math.max(workingLower, estimate.working.lower)
      workingUpper = Math.max(workingUpper, estimate.working.upper)
    }
  }

  return { lower: persistentLower + workingLower, upper: persistentUpper + workingUpper }
}

function compare(estimate: ByteRange, budget: number): ModelFitVerdict {
  if (estimate.lower > budget) return 'likely-too-large'
  if (estimate.upper <= budget) return 'likely-fits'
  return 'unknown'
}

function toModelResult(
  candidate: ModelFitCandidate,
  result: EstimatorResult,
  budget: AssessModelFitResult['budget'],
  alsoBoundBy: AssessModelFitResult['budget']
): ModelFitModelResult {
  if (result.kind === 'unknown') {
    return {
      name: candidate.model.name,
      verdict: 'unknown',
      reasons: [...result.reasons]
    }
  }

  const total: ByteRange = {
    lower: result.persistent.lower + result.working.lower,
    upper: result.persistent.upper + result.working.upper
  }

  return {
    name: candidate.model.name,
    verdict: budget ? verdictAgainst(total, budget, alsoBoundBy) : 'unknown',
    estimate: { lowerBoundBytes: total.lower, upperBoundBytes: total.upper },
    estimatorVersion: result.estimatorVersion,
    reasons: budget
      ? [...result.reasons]
      : [...result.reasons, 'no usable system-memory sample, so this model has no verdict']
  }
}
