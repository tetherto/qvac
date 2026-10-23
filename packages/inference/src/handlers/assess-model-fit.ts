import type { AssessModelFitRequest, AssessModelFitResponse } from '@/schemas/assess-model-fit'
import { assessModelFit } from '@/model-fit/assess'

/**
 * Runs a fit assessment worker-side, where the plugins, the registry client
 * and the memory sample are. No weights are read and nothing is loaded.
 */
export async function handleAssessModelFit(
  request: AssessModelFitRequest
): Promise<AssessModelFitResponse> {
  return { type: 'assessModelFit', ...(await assessModelFit(request.models)) }
}
