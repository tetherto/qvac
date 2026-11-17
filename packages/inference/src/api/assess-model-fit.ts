import {
  assessModelFitInputSchema,
  type AssessModelFitInput,
  type AssessModelFitRequest,
  type AssessModelFitResult
} from '@/schemas/index'
import { send } from '@/dispatch'
import { InvalidResponseError } from '@/errors/index'

/**
 * Whether a set of models fits in this device's memory when loaded together,
 * without downloading them.
 *
 * Each model's engine fitter runs against the registry's weightless description
 * of the model, or the model itself when it is on disk. The memory each load
 * takes is summed per device and compared against what is free.
 *
 * `unknown` is the answer for a load that would start but cannot be sized: an
 * engine with no fitter, a load the fitter cannot project, a model with no
 * registry description that is not on disk, or a device that reported no free
 * memory.
 *
 * @param input - The models, each as `loadModel` takes it.
 * @returns The verdict for the set, and each model's own verdict and stats.
 * @throws The error `loadModel` would throw for a load it refuses: no plugin
 *   for the model type, a config the plugin refuses, or a model the fitter
 *   cannot read.
 */
export async function assessModelFit(input: AssessModelFitInput): Promise<AssessModelFitResult> {
  const parsed = assessModelFitInputSchema.parse(input)

  const request: AssessModelFitRequest = { type: 'assessModelFit', ...parsed }

  const response = await send(request)
  if (response.type !== 'assessModelFit') {
    throw new InvalidResponseError('assessModelFit')
  }

  const { type: _type, ...result } = response
  return result
}
