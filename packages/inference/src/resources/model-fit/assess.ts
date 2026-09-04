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
import { getGpuCalibration, getSharedGpuCalibration } from '@/resources/model-fit/calibration/index'
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
 * Platforms whose fixture describes CPU-resident execution (`device: 'cpu'`),
 * so a reported GPU sends the host through `resolveGpuPlacement` instead.
 * Apple silicon and mobile calibrate on their GPU already.
 */
const CPU_CALIBRATED_PLATFORMS: readonly ModelFitPlatform[] = [
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
  /** Integrated-GPU coefficients, spent against the system budget. */
  resolveSharedGpuCalibration?: (
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
  const resolveSharedGpuCalibration = options.resolveSharedGpuCalibration ?? getSharedGpuCalibration

  // Where the model would execute decides which evidence can bound it, and
  // which fixture describes the load. See METHODOLOGY.md, "Which fixture a
  // host gets".
  const mustPlaceGpu =
    platform !== undefined && CPU_CALIBRATED_PLATFORMS.includes(platform) && hasGpu(resources)
  const placement = mustPlaceGpu && platform ? resolveGpuPlacement(resources, platform) : undefined
  const gpuCalibration =
    placement && platform
      ? placement.kind === 'device'
        ? resolveGpuCalibration(platform, placement.backend)
        : resolveSharedGpuCalibration(platform, placement.backend)
      : undefined

  // A mode only engages with coefficients measured for it.
  const onDevice = placement?.kind === 'device' && gpuCalibration ? placement : undefined
  const onIntegrated = placement?.kind === 'shared' && gpuCalibration ? placement : undefined
  const gpuMode = onDevice !== undefined || onIntegrated !== undefined
  const effectiveCalibration = gpuMode ? gpuCalibration : calibration

  const basis: ModelFitBasis = onDevice
    ? onDevice.targets[0]!.scope === 'budget'
      ? 'device-budget'
      : 'device-memory'
    : resolveBasis(platform)
  const reasons: string[] = []
  const assumptions: string[] = [
    `execution mode '${execution}' is a declared assumption used for aggregation only; the SDK does not schedule, serialize, or reserve anything`,
    `the verdict is advisory and based on ${basisEvidence(basis)} alone; it does not block loadModel and makes no performance claim`
  ]

  if (onDevice) {
    const { targets, backend } = onDevice
    assumptions.push(
      targets.length === 1
        ? `the model is assumed to execute on ${targets[0]!.device ?? 'the discrete GPU'} via ${backend}, and the budget is that device's own memory`
        : `${targets.length} usable GPUs are reported and the engine pins the model to one of them, an order this side cannot observe; the verdict holds for whichever it picks, and the budget shown is the tightest of them`
    )
  }

  if (onIntegrated) {
    assumptions.push(
      `the model is assumed to execute on ${onIntegrated.device ?? 'the integrated GPU'} via ${onIntegrated.backend}; an integrated GPU allocates out of system RAM, so system memory is the budget it draws on`
    )
  }

  if (platform === 'android-arm64') {
    assumptions.push(
      'android budgets deliberately use system memory: the low-memory killer acts system-wide and native allocations carry no per-process cap like iOS jetsam'
    )
  }

  // Every candidate card carries its own budget; the tightest is reported and
  // the verdict is taken across all of them.
  const deviceBudgets = onDevice?.targets.map((target) => gpuBudget(target, platform))
  const budget = deviceBudgets
    ? tightest(deviceBudgets)
    : resolveBudget(resources, platform, basis, reasons)

  // A discrete-GPU load is paid for in system RAM too. In shared mode the
  // system budget already *is* the budget.
  const alsoBoundBy = onDevice ? resolveBudget(resources, platform, 'system-memory', []) : undefined

  if (!platform) {
    reasons.push('the runtime platform is not one this assessment covers')
  } else if (mustPlaceGpu && !gpuMode) {
    // Name the missing fixture: the platform's own coefficients exist here,
    // they are just the wrong ones.
    reasons.push(
      !placement
        ? 'a GPU is reported but its readings cannot say where the model would execute, so no estimate can be defended'
        : placement.kind === 'device'
          ? `no validated calibration for ${platform} on ${placement.backend}, so no estimate can be defended`
          : `no validated calibration for ${platform} on an integrated ${placement.backend} GPU, so no estimate can be defended`
    )
  } else if (!effectiveCalibration) {
    reasons.push(`no validated calibration for ${platform}, so no estimate can be defended`)
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
    toModelResult(candidate, result, budget, deviceBudgets, alsoBoundBy)
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
    !budget || !combined
      ? 'unknown'
      : verdictAgainst(combined, deviceBudgets ?? [budget], alsoBoundBy)

  if (onDevice && combined && alsoBoundBy) {
    reasons.push(
      'a GPU load is also paid for in system RAM, so every verdict is the more pessimistic of the GPU and system budgets'
    )
  }

  if (deviceBudgets && deviceBudgets.length > 1 && combined) {
    reasons.push(
      'more than one usable GPU is reported, so a fit has to hold on the smallest of them and a refusal on the largest'
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

  // A GPU is present and neither GPU mode engaged, so the only coefficients
  // left were measured with the offload disabled — not how this host runs.
  if (!gpuMode && platform && CPU_CALIBRATED_PLATFORMS.includes(platform) && hasGpu(resources)) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: [
          'a GPU is present, so the model executes on it rather than on the CPU this platform’s coefficients were measured against'
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
 * The GPUs the engine could actually execute on: `chooseBackend` passes over a
 * paravirtual adapter and a device with no graphics API this build talks to,
 * and falls back to the CPU. The driver flags are library-presence checks, and
 * ggml's own backend needs the same libraries to load.
 */
function usableGpus(resources: SystemResources): readonly GPUResourceCapabilities[] {
  const gpus = resources.capabilities.gpus
  if (gpus.status !== 'supported') return []
  return gpus.value.filter((gpu) => !isVirtualDisplayAdapter(gpu) && backendOf(gpu) !== undefined)
}

/** Whether a GPU the engine would use is present. Sets the KV-cache default. */
function hasGpu(resources: SystemResources): boolean {
  return usableGpus(resources).length > 0
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

/**
 * Where the engine would put the model. `device` carries every card it could
 * pin to, since which one it picks is not observable here; `shared` is the
 * ordinary laptop, where the GPU allocates out of system RAM.
 */
type GpuPlacement =
  | { kind: 'device'; backend: string; targets: readonly GpuTarget[] }
  | { kind: 'shared'; backend: string; device?: string }

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

// `gpuType.VIRTUAL`: the virtio / VMware / Hyper-V adapter a VM exposes. It
// has no compute backend, so counting it as a GPU would deny every VM the
// platform's own coefficients.
const GPU_TYPE_VIRTUAL = 3

function isVirtualDisplayAdapter(gpu: GPUResourceCapabilities) {
  return gpu.type.status === 'supported' && gpu.type.value === GPU_TYPE_VIRTUAL
}

/**
 * Whether this GPU's allocations come out of system RAM. `unifiedMemory` says
 * so directly; the Windows iGPU does not, being typed dedicated for a 128 MiB
 * carve-out, so the usable-memory floor is what identifies it.
 */
function allocatesFromSystemMemory(gpu: GPUResourceCapabilities) {
  if (gpu.unifiedMemory.status === 'supported' && gpu.unifiedMemory.value) return true
  return tooSmallToHostAModel(gpu)
}

/**
 * Whether the collector's dedicated/integrated call is trustworthy for this
 * device. On linux it is inferred from amdgpu's `mem_info_vram_total`, which an
 * APU also exposes for its carve-out — a Ryzen 5000U reported `dedicated` with
 * over a gigabyte of "VRAM". Vulkan calls the same device INTEGRATED_GPU, but
 * that is not in the collector, so an AMD GPU on linux cannot be placed and
 * assesses as `unknown` until the engine's own device type is exposed.
 */
function integratedIsIndistinguishable(gpu: GPUResourceCapabilities, platform: ModelFitPlatform) {
  if (!platform.startsWith('linux')) return false
  return gpu.driverName.status === 'supported' && gpu.driverName.value === 'amdgpu'
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
 * Classifies the reported GPUs: any card with its own memory ⇒ `device`,
 * otherwise ⇒ `shared`. That preference is the engine's own.
 *
 * @returns `undefined` when the readings support neither, or when the cards
 *   disagree on backend or scope.
 */
function resolveGpuPlacement(
  resources: SystemResources,
  platform: ModelFitPlatform
): GpuPlacement | undefined {
  const gpus = usableGpus(resources)
  if (gpus.length === 0) return undefined
  if (gpus.some((gpu) => integratedIsIndistinguishable(gpu, platform))) return undefined

  // Classify on device properties only, never on a reading. A card whose
  // sample failed must still count as a card the engine could choose;
  // filtering it out here would leave its neighbour looking unambiguous.
  const deviceBacked = gpus.filter((gpu) => !allocatesFromSystemMemory(gpu))

  if (deviceBacked.length === 0) {
    const shared = gpus[0]!
    const backend = backendOf(shared)!
    // Two integrated devices on different backends would need two fixtures and
    // the engine picks one, so the same rule applies as for cards: no single
    // set of coefficients, no estimate. They share the budget either way.
    if (gpus.some((gpu) => backendOf(gpu) !== backend)) return undefined
    return {
      kind: 'shared',
      backend,
      ...(shared.name.status === 'supported' && { device: shared.name.value })
    }
  }

  const samples = resources.sample?.gpus
  if (samples?.status !== 'supported') return undefined

  const targets: GpuTarget[] = []
  for (const gpu of deviceBacked) {
    const backend = backendOf(gpu)
    if (!backend) return undefined

    const sample = samples.value.find((entry) => entry.id === gpu.id)
    if (!sample) return undefined
    if (sample.memoryTotalBytes.status !== 'supported') return undefined
    if (sample.memoryUsedBytes.status !== 'supported') return undefined
    if (sample.memoryTotalBytes.value <= 0) return undefined
    if (sample.memoryUsedBytes.value > sample.memoryTotalBytes.value) return undefined

    targets.push({
      backend,
      totalBytes: sample.memoryTotalBytes.value,
      usedBytes: sample.memoryUsedBytes.value,
      scope: sample.memoryTotalBytes.provenance.scope === 'budget' ? 'budget' : 'device',
      ...(gpu.name.status === 'supported' && { device: gpu.name.value })
    })
  }

  // One fixture covers one backend, and one basis: cards that disagree on
  // either cannot be assessed under a single set of coefficients.
  const backend = targets[0]!.backend
  if (targets.some((target) => target.backend !== backend)) return undefined
  if (targets.some((target) => target.scope !== targets[0]!.scope)) return undefined

  return { kind: 'device', backend, targets }
}

function gpuBudget(target: GpuTarget, platform: ModelFitPlatform | undefined) {
  const available = target.totalBytes - target.usedBytes
  const reserved = reserveBytes(available, platform)
  return {
    totalBytes: target.totalBytes,
    usedBytes: target.usedBytes,
    reservedBytes: reserved,
    availableAfterReserveBytes: available - reserved
  }
}

/** The budget with the least room left, which is the one worth reporting. */
function tightest(budgets: readonly NonNullable<AssessModelFitResult['budget']>[]) {
  return budgets.reduce((least, budget) =>
    budget.availableAfterReserveBytes < least.availableAfterReserveBytes ? budget : least
  )
}

/**
 * `candidates` are alternatives — the engine pins the model to one of them, and
 * which one is not observable here — so a fit has to hold on the smallest and a
 * refusal on the largest. `alsoBoundBy` is a conjunction: a GPU load is paid
 * for in system RAM too, so both bounds apply.
 */
function verdictAgainst(
  estimate: ByteRange,
  candidates: readonly NonNullable<AssessModelFitResult['budget']>[],
  alsoBoundBy: AssessModelFitResult['budget']
): ModelFitVerdict {
  const room = candidates.map((budget) => budget.availableAfterReserveBytes)
  const primary: ModelFitVerdict =
    estimate.upper <= Math.min(...room)
      ? 'likely-fits'
      : estimate.lower > Math.max(...room)
        ? 'likely-too-large'
        : 'unknown'

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

    const reserved = reserveBytes(available.value, platform)
    return {
      totalBytes: total,
      usedBytes: used.value,
      reservedBytes: reserved,
      availableAfterReserveBytes: available.value - reserved
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

  const available = total.value - used.value
  const reserved = reserveBytes(available, platform)
  return {
    totalBytes: total.value,
    usedBytes: used.value,
    reservedBytes: reserved,
    availableAfterReserveBytes: available - reserved
  }
}

/**
 * `interactive-v1`: 20% of what is available right now, capped at 2 GiB on
 * desktop and 1 GiB on mobile.
 *
 * The reserve is taken from available memory, not total: a share of total is
 * subtracted from a figure that already excludes what is in use, so on a busy
 * host it double-counts and can exceed the whole headroom — a 24 GiB Mac with
 * 3.3 GiB free ended up with a zero budget and called a 2 GiB model too large.
 */
function reserveBytes(availableBytes: number, platform: ModelFitPlatform | undefined): number {
  const mobile = platform !== undefined && MOBILE_PLATFORMS.includes(platform)
  return Math.min(mobile ? 1 * GIB : 2 * GIB, Math.floor(availableBytes * 0.2))
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
  /** Every candidate GPU budget, when the host has more than one. */
  deviceBudgets: readonly NonNullable<AssessModelFitResult['budget']>[] | undefined,
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
    verdict: budget ? verdictAgainst(total, deviceBudgets ?? [budget], alsoBoundBy) : 'unknown',
    estimate: { lowerBoundBytes: total.lower, upperBoundBytes: total.upper },
    estimatorVersion: result.estimatorVersion,
    reasons: budget
      ? [...result.reasons]
      : [...result.reasons, 'no usable system-memory sample, so this model has no verdict']
  }
}
