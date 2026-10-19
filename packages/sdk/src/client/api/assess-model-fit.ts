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
 * Assesses, before anything is downloaded, whether the given models are likely
 * to fit in this device's memory.
 *
 * Advisory only: it does not download weights, block `loadModel`, reserve
 * memory, or make a performance claim. `unknown` is a real answer — it means
 * the available evidence does not support a verdict either way, and callers
 * should treat it as "cannot say", not "no".
 *
 * For each candidate it fetches the registry's weightless description of every
 * source that load names — tens of KB each, never the weights — and runs the
 * engine's own fitter against them, reported as `native-fit` evidence. Where
 * that is unavailable the computed floor stands, which can refuse a model but
 * never confirm one.
 *
 * @param input - Loads to assess in `loadModel`'s own parameters, the declared
 *   execution mode, and the headroom policy.
 * @returns Per-model and combined verdicts, with the budget and bounds they came
 *   from, plus every assumption that was made.
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

  // Rebuilt field by field rather than by rest-destructuring the discriminant,
  // matching the other client wrappers and keeping optionals absent rather than
  // explicitly undefined.
  return {
    verdict: response.verdict,
    basis: response.basis,
    execution: response.execution,
    ...(response.evidence && { evidence: response.evidence }),
    ...(response.budget && { budget: response.budget }),
    ...(response.floorBytes !== undefined && { floorBytes: response.floorBytes }),
    models: response.models,
    reasons: response.reasons,
    assumptions: response.assumptions
  }
}
