import type {
  AssessModelFitRequest,
  AssessModelFitResponse,
  ModelFitCandidate,
  ModelFitEstimateTarget,
  ModelFitModelRef
} from '@/schemas/assess-model-fit'
import { isCanonicalModelType, normalizeModelType, ModelType } from '@/schemas/index'
import { inferModelTypeFromModelSrc } from '@/schemas/model-src-utils'
import { ModelTypeRequiredError } from '@/errors/index'
import { projectFitFromLoad } from '@/resources/model-fit/fit-stub/project-fit-from-load'
import type { SystemResources } from '@/schemas/system-resources'
import { getResourceCollector } from '@/resources/instance'
import { getConfig } from '@/runtime/state'
import { assessModelFitFromResources, type NativeCandidateFit } from '@/resources/model-fit/assess'
import { detectPlatform } from '@/resources/model-fit/platform'

/**
 * Runs a pre-download fit assessment worker-side.
 *
 * This lives on the worker because that is where the three things it needs
 * already are: the resource collector for a fresh memory sample, the runtime's
 * own platform/arch pair, and the registry client. No weights are read and
 * nothing is loaded — each candidate additionally has the registry's weightless
 * description fetched, tens of KB, so the engine's own fitter can answer.
 */
export async function handleAssessModelFit(
  request: AssessModelFitRequest
): Promise<AssessModelFitResponse> {
  const platform = detectPlatform()
  const nativeFits = await resolveNativeFits(request.models)

  const result = assessModelFitFromResources({
    models: request.models.map(estimateTargetFor),
    execution: request.execution,
    resources: readResources(),
    platform,
    nativeFits
  })

  return { type: 'assessModelFit', ...result }
}

/**
 * The engine that would run this load, named outright or read off the source,
 * as `loadModel` resolves it.
 *
 * @throws {ModelTypeRequiredError} When neither names one.
 */
function modelTypeOf(candidate: ModelFitCandidate): string {
  if (candidate.modelType !== undefined) return normalizeModelType(candidate.modelType)

  const inferred = inferModelTypeFromModelSrc(candidate.modelSrc)
  if (inferred === undefined) throw new ModelTypeRequiredError()

  return normalizeModelType(inferred)
}

/** The audio engines, whose estimator sizes a load by its window rather than a context. */
const AUDIO_ENGINES: readonly string[] = [
  'whispercpp-transcription',
  'parakeet-transcription',
  'bci-whispercpp-transcription'
]

/**
 * Engines that name a device outright, in llama's own `gpu` / `cpu` spelling.
 * Both default to the GPU.
 */
const DEVICE_NAMED: readonly string[] = [ModelType.llamacppCompletion, ModelType.llamacppEmbedding]

function contextUsesGpu(config: Record<string, unknown>): unknown {
  const contextParams = config['contextParams']
  if (contextParams === null || typeof contextParams !== 'object') return undefined
  return (contextParams as Record<string, unknown>)['use_gpu']
}

/**
 * Engines that carry a GPU switch, each read at the key its own config spells
 * it under. These are the keys the fit builders read in `native-probe/engines`,
 * so a projection and a device never disagree. Only bci defaults to on.
 */
const GPU_SWITCH: Record<string, (config: Record<string, unknown>) => boolean> = {
  [ModelType.ttsGgml]: (config) => config['useGPU'] === true,
  [ModelType.audiogenGgml]: (config) => config['useGPU'] === true,
  [ModelType.parakeetTranscription]: (config) => config['useGPU'] === true,
  [ModelType.whispercppTranscription]: (config) => contextUsesGpu(config) === true,
  [ModelType.bciWhispercppTranscription]: (config) => contextUsesGpu(config) !== false
}

/**
 * Where a load resolved to run. `dispatch` applies the host's device defaults
 * before any handler sees the config, so what arrives here is the resolved one.
 *
 * `nGpuLayers` wins over `useGPU` on tts, and the config schema rejects the two
 * disagreeing, so reading it first is safe.
 */
function resolvedDevice(modelType: string, config: Record<string, unknown>): string | undefined {
  if (DEVICE_NAMED.includes(modelType)) {
    const device = config['device']
    return typeof device === 'string' ? device.toLowerCase() : 'gpu'
  }

  const layers = config['nGpuLayers']
  if (modelType === ModelType.ttsGgml && typeof layers === 'number') {
    return layers === 0 ? 'cpu' : 'gpu'
  }

  const usesGpu = GPU_SWITCH[modelType]
  if (usesGpu === undefined) return undefined

  return usesGpu(config) ? 'gpu' : 'cpu'
}

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

  const add = (ref: ModelFitModelRef): void => {
    if (seen.has(ref.sha256Checksum)) return
    seen.add(ref.sha256Checksum)
    refs.push(ref)
  }

  const walk = (key: string, value: unknown): void => {
    const ref = modelRefOf(value)
    if (ref !== undefined) {
      add(ref)
      return
    }
    if (key.endsWith('ModelSrc')) {
      add({ name: typeof value === 'string' ? value : key, sha256Checksum: '' })
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
      walk(inner, nested)
    }
  }

  for (const [key, value] of Object.entries(config)) walk(key, value)
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
  const modelType = modelTypeOf(candidate)

  const contextTokens = config['ctx_size']
  const artifacts = companionRefs(config)
  const device = resolvedDevice(modelType, config)

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
    ...(device !== undefined && { device }),
    workload: AUDIO_ENGINES.includes(modelType)
      ? {
          kind: 'audio',
          windowMs: audioWindowMs(config),
          streaming: config['streaming'] === true
        }
      : {
          kind: 'llm',
          ...(typeof contextTokens === 'number' && contextTokens > 0 && { contextTokens })
        }
  }
}

/** The engine fitter's verdict for one candidate, through that load's plugin. */
async function resolveNativeFit(candidate: ModelFitCandidate): Promise<NativeCandidateFit> {
  const modelType = modelTypeOf(candidate)
  if (!isCanonicalModelType(modelType)) {
    return { unavailable: `no plugin handles model type ${modelType}` }
  }

  const budgetMs = getConfig().fitStubBudgetMs

  const outcome = await projectFitFromLoad(
    {
      modelType,
      ...(candidate.modelSrc !== undefined && { modelSrc: candidate.modelSrc }),
      ...(candidate.modelConfig !== undefined && { modelConfig: candidate.modelConfig })
    },
    estimateTargetFor(candidate).model.name,
    budgetMs === undefined ? {} : { stub: { budgetMs } }
  )

  if (outcome.status === 'projected') return { fit: outcome.fit }
  if (outcome.status === 'unsupported-load') return { unavailable: outcome.detail }

  return {
    unavailable:
      outcome.message === undefined
        ? `no registry description (${outcome.reason})`
        : `no registry description (${outcome.reason}): ${outcome.message}`
  }
}

/**
 * One verdict per candidate, in request order. Each probe measures its own
 * model against the whole machine, so the bytes compose where the verdicts do
 * not, and `assess` combines them under one budget.
 *
 * Run one at a time, so a set never holds several fitters open at once.
 */
async function resolveNativeFits(
  candidates: readonly ModelFitCandidate[]
): Promise<NativeCandidateFit[]> {
  const fits: NativeCandidateFit[] = []
  for (const candidate of candidates) {
    fits.push(await resolveNativeFit(candidate))
  }
  return fits
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
