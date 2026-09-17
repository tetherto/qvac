import os from 'bare-os'
import type {
  AssessModelFitRequest,
  AssessModelFitResponse,
  ModelFitWorkload,
  NativeProbeFit
} from '@/schemas/assess-model-fit'
import { ModelType, type CanonicalModelType } from '@/schemas/index'
import { projectFitFromStub } from '@/resources/model-fit/fit-stub/project-fit-from-stub'
import type { SystemResources } from '@/schemas/system-resources'
import { getResourceCollector } from '@/resources/instance'
import { assessModelFitFromResources } from '@/resources/model-fit/assess'
import { getPlatformCalibration } from '@/resources/model-fit/calibration/index'
import type { ModelFitPlatform } from '@/resources/model-fit/types'

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
    models: request.models,
    execution: request.execution,
    resources: readResources(),
    platform,
    calibration: platform ? getPlatformCalibration(platform) : undefined,
    nativeFit: await resolveNativeFit(request)
  })

  return { type: 'assessModelFit', ...result }
}

/**
 * The engine fitter's verdict for a single candidate, read from the registry's
 * fit stub.
 *
 * Only for a one-candidate request: the probe measures one model against the
 * whole machine, which cannot be aggregated across a set. Everything else — no
 * stub published, an offline caller, an engine with no fit path — resolves to
 * `undefined` and the modelled assessment stands.
 */
async function resolveNativeFit(
  request: AssessModelFitRequest
): Promise<NativeProbeFit | undefined> {
  if (request.models.length !== 1) return undefined

  const candidate = request.models[0]
  if (!candidate) return undefined

  const modelType = fitModelType(candidate.workload)
  if (!modelType) return undefined

  const outcome = await projectFitFromStub({
    model: candidate.model,
    modelType,
    modelConfig: fitModelConfig(candidate.workload)
  })

  return outcome.status === 'projected' ? outcome.fit : undefined
}

/** The engine whose fitter covers a workload, where one does. */
function fitModelType(workload: ModelFitWorkload): CanonicalModelType | undefined {
  return workload.kind === 'llm' ? ModelType.llamacppCompletion : undefined
}

/** The intended load, in the spelling the llama.cpp config uses. */
function fitModelConfig(workload: ModelFitWorkload): Record<string, unknown> {
  return workload.kind === 'llm' ? { ctx_size: workload.contextTokens } : {}
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

/**
 * Maps the runtime's platform and architecture onto a calibration target.
 *
 * @returns `undefined` for any pair this feature has no calibration target for,
 *   which assesses as `unknown` rather than borrowing another platform's
 *   coefficients.
 */
function detectPlatform(): ModelFitPlatform | undefined {
  const key = `${os.platform()}-${os.arch()}`
  switch (key) {
    case 'darwin-arm64':
    case 'darwin-x64':
    case 'linux-arm64':
    case 'linux-x64':
    case 'win32-x64':
    // Listed for completeness rather than reach: no engine addon is built for
    // win32-arm64 (`@qvac/llm-llamacpp/prebuilds` has no such target, and no
    // windows-arm runner exists to build one), so nothing on that platform can
    // load a model today. Calibrating it needs that build first, not a fixture.
    case 'win32-arm64':
    case 'android-arm64':
    case 'ios-arm64':
      return key
    default:
      return undefined
  }
}
