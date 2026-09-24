import type {
  AssessModelFitRequest,
  AssessModelFitResponse,
  ModelFitCandidate,
  ModelFitEstimateTarget,
  ModelFitModelRef,
  NativeProbeFit
} from '@/schemas/assess-model-fit'
import { isCanonicalModelType, normalizeModelType } from '@/schemas/index'
import { projectFitFromLoad } from '@/resources/model-fit/fit-stub/project-fit-from-load'
import type { SystemResources } from '@/schemas/system-resources'
import { getResourceCollector } from '@/resources/instance'
import { assessModelFitFromResources } from '@/resources/model-fit/assess'
import { getPlatformCalibration } from '@/resources/model-fit/calibration/index'
import { detectPlatform } from '@/resources/model-fit/platform'

/**
 * Runs a pre-download fit assessment worker-side.
 *
 * This lives on the worker because that is where the three things it needs
 * already are: the resource collector for a fresh memory sample, the runtime's
 * own platform/arch pair, and the registry client. No weights are read and
 * nothing is loaded — a single candidate additionally has the registry's
 * weightless description fetched, tens of KB, so the engine's own fitter can
 * answer instead of the coefficients modelling it.
 */
export async function handleAssessModelFit(
  request: AssessModelFitRequest
): Promise<AssessModelFitResponse> {
  const platform = detectPlatform()

  const result = assessModelFitFromResources({
    models: request.models.map(estimateTargetFor),
    execution: request.execution,
    resources: readResources(),
    platform,
    calibration: platform ? getPlatformCalibration(platform) : undefined,
    nativeFit: await resolveNativeFit(request.models)
  })

  return { type: 'assessModelFit', ...result }
}

/** The audio engines, whose estimator sizes a load by its window rather than a context. */
const AUDIO_ENGINES: readonly string[] = [
  'whispercpp-transcription',
  'parakeet-transcription',
  'bci-whispercpp-transcription'
]

/** The window the speech engines hold whole; longer audio is chunked into it. */
const AUDIO_WINDOW_MS = 30_000

/**
 * The audio a single call holds in memory. `duration_ms` is the longest clip
 * the caller will transcribe, not a per-call window, and the engine chunks
 * anything longer, so it never sizes working memory above one window.
 */
function audioWindowMs(config: Record<string, unknown>): number {
  const declared = config['duration_ms']
  if (typeof declared !== 'number' || declared <= 0) return AUDIO_WINDOW_MS
  return Math.min(declared, AUDIO_WINDOW_MS)
}

/** The catalog facts a source carries, where it carries them. */
function modelRefOf(value: unknown): ModelFitModelRef | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const src = value as Record<string, unknown>
  if (typeof src['sha256Checksum'] !== 'string') return undefined

  const name = src['name'] ?? src['modelId'] ?? src['registryPath']
  return {
    name: typeof name === 'string' ? name : '',
    sha256Checksum: src['sha256Checksum'],
    ...(typeof src['registryPath'] === 'string' && { registryPath: src['registryPath'] }),
    ...(typeof src['registrySource'] === 'string' && { registrySource: src['registrySource'] })
  }
}

/**
 * The companion sources a load carries in its config — a VAD model, a pivot,
 * an audiogen stage, a projector. Their bytes are part of what the set costs,
 * so the estimate counts them alongside the primary.
 */
function companionRefs(config: Record<string, unknown>): ModelFitModelRef[] {
  const refs: ModelFitModelRef[] = []
  const seen = new Set<string>()

  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    const ref = modelRefOf(value)
    if (ref !== undefined) {
      if (!seen.has(ref.sha256Checksum)) {
        seen.add(ref.sha256Checksum)
        refs.push(ref)
      }
      return
    }
    for (const inner of Object.values(value as Record<string, unknown>)) walk(inner)
  }

  for (const value of Object.values(config)) walk(value)
  return refs
}

/**
 * What the estimator is given for one candidate. The catalog facts come from
 * the source's checksum, and the workload from the settings the load carries;
 * a source outside the catalog resolves neither and assesses as `unknown`.
 *
 * A load whose sources are all config fields carries no checksum, so it has no
 * catalog profile and the engine's own fitter is its only evidence. The model
 * type stands in as the label.
 */
export function estimateTargetFor(candidate: ModelFitCandidate): ModelFitEstimateTarget {
  const descriptor = typeof candidate.modelSrc === 'string' ? undefined : candidate.modelSrc
  const location = typeof candidate.modelSrc === 'string' ? candidate.modelSrc : undefined
  const config = candidate.modelConfig ?? {}
  const modelType = normalizeModelType(candidate.modelType)

  const contextTokens = config['ctx_size']
  const artifacts = companionRefs(config)

  return {
    model: {
      name: descriptor?.name ?? descriptor?.modelId ?? location ?? modelType,
      sha256Checksum: descriptor?.sha256Checksum ?? '',
      ...(descriptor?.registryPath !== undefined && { registryPath: descriptor.registryPath }),
      ...(descriptor?.registrySource !== undefined && {
        registrySource: descriptor.registrySource
      })
    },
    ...(artifacts.length > 0 && { artifacts }),
    workload: AUDIO_ENGINES.includes(modelType)
      ? {
          kind: 'audio',
          windowMs: audioWindowMs(config),
          streaming: config['streaming'] === true
        }
      : {
          kind: 'llm',
          contextTokens: typeof contextTokens === 'number' && contextTokens > 0 ? contextTokens : 1
        }
  }
}

/**
 * The engine fitter's verdict for a single candidate, resolved through that
 * load's own plugin. Only for a one-candidate request: the probe measures one
 * model against the whole machine, which cannot be aggregated across a set.
 */
async function resolveNativeFit(
  candidates: readonly ModelFitCandidate[]
): Promise<NativeProbeFit | undefined> {
  if (candidates.length !== 1) return undefined

  const candidate = candidates[0]
  if (!candidate) return undefined

  const modelType = normalizeModelType(candidate.modelType)
  if (!isCanonicalModelType(modelType)) return undefined

  const outcome = await projectFitFromLoad(
    {
      modelType,
      ...(candidate.modelSrc !== undefined && { modelSrc: candidate.modelSrc }),
      ...(candidate.modelConfig !== undefined && { modelConfig: candidate.modelConfig })
    },
    estimateTargetFor(candidate).model.name
  )

  return outcome.status === 'projected' ? outcome.fit : undefined
}

function readResources(): SystemResources {
  const collector = getResourceCollector()
  if (!collector) {
    const failed = { status: 'failed', reason: 'resource collector is not initialized' } as const
    return {
      capabilities: {
        cpu: failed,
        memory: { totalBytes: failed },
        gpus: failed
      },
      sample: {
        sampledAt: Date.now(),
        cpu: failed,
        memory: {
          usedBytes: failed,
          totalBytes: failed,
          processUsedBytes: failed,
          processAvailableBytes: failed
        },
        gpus: failed
      }
    }
  }

  return { capabilities: collector.getCapabilities(), sample: collector.sample() }
}
