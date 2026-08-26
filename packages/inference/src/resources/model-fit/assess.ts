import type {
  AssessModelFitResult,
  ModelFitCandidate,
  ModelFitExecution,
  ModelFitModelResult,
  ModelFitVerdict
} from '@/schemas/assess-model-fit'
import type { SystemResources } from '@/schemas/system-resources'
import type { ModelResourceProfile } from '@/schemas/model-resource-profile'
import { getModelResourceProfile } from '@/models/registry/resource-profiles'
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

  const reasons: string[] = []
  const assumptions: string[] = [
    `execution mode '${execution}' is a declared assumption used for aggregation only; the SDK does not schedule, serialize, or reserve anything`,
    'the verdict is advisory and based on system memory alone; it does not block loadModel and makes no performance claim'
  ]

  const budget = resolveBudget(resources, platform, reasons)

  if (!platform) {
    reasons.push('the runtime platform is not one this assessment covers')
  } else if (!calibration) {
    reasons.push(`no validated calibration for ${platform}, so no estimate can be defended`)
  } else if (calibration.measuredAt) {
    assumptions.push(calibrationAssumption(platform, calibration))
  }

  const evaluated = models.map((candidate) =>
    evaluate(candidate, calibration, resources, resolveProfile)
  )

  for (const { result } of evaluated) {
    for (const assumption of result.assumptions ?? []) {
      if (!assumptions.includes(assumption)) assumptions.push(assumption)
    }
  }

  const modelResults: ModelFitModelResult[] = evaluated.map(({ candidate, result }) =>
    toModelResult(candidate, result, budget)
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
    !budget || !combined ? 'unknown' : compare(combined, budget.availableAfterReserveBytes)

  if (budget && combined) {
    reasons.push(
      execution === 'concurrent'
        ? 'all models counted as resident with every working peak added'
        : 'all models counted as resident with only the largest working peak added'
    )
  }

  return {
    verdict,
    basis: 'system-memory',
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
  calibration: PlatformCalibration | undefined,
  resources: SystemResources,
  resolveProfile: ProfileResolver
): { candidate: ModelFitCandidate; result: EstimatorResult } {
  if (!calibration) {
    return {
      candidate,
      result: {
        kind: 'unknown',
        estimatorVersion: 'none',
        reasons: ['no validated calibration for this platform']
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
 * Whether the device reports at least one GPU. Used only to decide which
 * KV-cache type the engine would default to — GPU memory is never part of the
 * budget, since those metrics are `unverified`-scoped by design.
 */
function hasGpu(resources: SystemResources): boolean {
  const gpus = resources.capabilities.gpus
  return gpus.status === 'supported' && gpus.value.length > 0
}

/**
 * Derives the memory budget from the sample.
 *
 * Only `sample.memory` is used: capabilities-only totals say nothing about what
 * is free right now, and a verdict without that is not worth giving.
 */
function resolveBudget(
  resources: SystemResources,
  platform: ModelFitPlatform | undefined,
  reasons: string[]
): AssessModelFitResult['budget'] {
  const sample = resources.sample
  if (!sample) {
    reasons.push('no system-memory sample was available')
    return undefined
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
  budget: AssessModelFitResult['budget']
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
    verdict: budget ? compare(total, budget.availableAfterReserveBytes) : 'unknown',
    estimate: { lowerBoundBytes: total.lower, upperBoundBytes: total.upper },
    estimatorVersion: result.estimatorVersion,
    reasons: budget
      ? [...result.reasons]
      : [...result.reasons, 'no usable system-memory sample, so this model has no verdict']
  }
}
