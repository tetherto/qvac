import os from 'bare-os'
import type { AssessModelFitRequest, AssessModelFitResponse } from '@/schemas/assess-model-fit'
import type { SystemResources } from '@/schemas/system-resources'
import { getResourceCollector } from '@/resources/instance'
import { assessModelFitFromResources } from '@/resources/model-fit/assess'
import { getPlatformCalibration } from '@/resources/model-fit/calibration/index'
import type { ModelFitPlatform } from '@/resources/model-fit/types'

/**
 * Runs a pre-download fit assessment worker-side.
 *
 * This lives on the worker because that is where the two things it needs
 * already are: the resource collector for a fresh memory sample, and the
 * runtime's own platform/arch pair. No model bytes are read and nothing is
 * loaded.
 */
export function handleAssessModelFit(request: AssessModelFitRequest): AssessModelFitResponse {
  const platform = detectPlatform()

  const result = assessModelFitFromResources({
    models: request.models,
    execution: request.execution,
    resources: readResources(),
    platform,
    calibration: platform ? getPlatformCalibration(platform) : undefined
  })

  return { type: 'assessModelFit', ...result }
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
        memory: { usedBytes: failed, totalBytes: failed },
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
    case 'android-arm64':
    case 'ios-arm64':
      return key
    default:
      return undefined
  }
}
