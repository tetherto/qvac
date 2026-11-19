import {
  assessModelFitInputSchema,
  inferModelTypeFromModelSrc,
  type AssessModelFitInput,
  type AssessModelFitRequest,
  type AssessModelFitResult,
  type RPCOptions
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
 * Each model's engine fitter runs against the registry's weightless description
 * of the model, or the model itself when it is on disk. The memory each load
 * takes is summed per memory pool and compared against what is free. Each
 * model's status is its verdict alone, which counts its rows that share one
 * pool, such as a Metal GPU and the CPU, together. A single model's verdict is
 * its status; a set does not fit when any model does not fit alone.
 *
 * `unknown` is the answer for a load that would start but cannot be sized: an
 * engine with no fitter, a load the fitter cannot project, a model with no
 * registry description that is not on disk, or a device that reported no free
 * memory.
 *
 * @param input - The models, each as `loadModel` takes it.
 * @returns The verdict for the set, the memory pools it was judged on, and
 *   each model's addon result: its status, device rows and stats, and a
 *   reason when its status is `unknown` or a shared pool makes it
 *   `does-not-fit`.
 * @throws The error `loadModel` would throw for a load it refuses: no plugin
 *   for the model type, or a config the plugin refuses.
 * @throws {QvacErrorBase} With code `MODEL_FIT_REJECTED` when the engine
 *   fitter cannot assess the load, such as a model it cannot read or an engine
 *   that fails to run it. A companion file, such as a projector, VAE or codec,
 *   does not load on its own: assess the model that loads it.
 */
export async function assessModelFit(
  input: AssessModelFitInput,
  options?: RPCOptions
): Promise<AssessModelFitResult> {
  const parsed = assessModelFitInputSchema.parse({
    ...input,
    models: input.models.map(withModelType)
  })

  const request: AssessModelFitRequest = { type: 'assessModelFit', ...parsed }

  const response = await send(request, options)
  if (response.type !== 'assessModelFit') {
    throw new InvalidResponseError('assessModelFit')
  }

  return { verdict: response.verdict, pools: response.pools, models: response.models }
}
