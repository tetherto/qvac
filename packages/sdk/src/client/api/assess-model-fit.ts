import {
  assessModelFitInputSchema,
  inferModelTypeFromModelSrc,
  type AssessModelFitInput,
  type AssessModelFitRequest,
  type AssessModelFitResult
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError, ModelTypeRequiredError } from '@/utils/errors-client'

/**
 * Names the engine a candidate omitted, from the source it carries.
 *
 * @throws {ModelTypeRequiredError} When the source names no engine either.
 */
function withModelType(candidate: AssessModelFitInput['models'][number]) {
  if (candidate.modelType !== undefined) return candidate

  const inferred = inferModelTypeFromModelSrc(candidate.modelSrc)
  if (inferred === undefined) throw new ModelTypeRequiredError()

  return { ...candidate, modelType: inferred }
}

/**
 * Whether a set of models fits in this device's memory when loaded together,
 * without downloading them.
 *
 * @throws The error `loadModel` would throw for a load it refuses: no plugin
 *   for the model type, a config the plugin refuses, or a model the fitter
 *   cannot read.
 */
export async function assessModelFit(input: AssessModelFitInput): Promise<AssessModelFitResult> {
  const parsed = assessModelFitInputSchema.parse({
    ...input,
    models: input.models.map(withModelType)
  })

  const request: AssessModelFitRequest = { type: 'assessModelFit', ...parsed }

  const response = await send(request)
  if (response.type !== 'assessModelFit') {
    throw new InvalidResponseError('assessModelFit')
  }

  return { verdict: response.verdict, pools: response.pools, models: response.models }
}
