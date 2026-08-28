import {
  assessModelFitInputSchema,
  type AssessModelFitInput,
  type AssessModelFitRequest,
  type AssessModelFitResult
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Assesses, before anything is downloaded, whether the given models are likely
 * to fit in this device's memory.
 *
 * Advisory only: it does not download weights, run a native fit probe, block
 * `loadModel`, reserve memory, or make a performance claim. `unknown` is a real
 * answer — it means the available evidence does not support a verdict either
 * way, and callers should treat it as "cannot say", not "no".
 *
 * @param input - Candidates with their intended workloads, the declared
 *   execution mode, and the headroom policy.
 * @returns Per-model and combined verdicts, with the budget and bounds they came
 *   from, plus every assumption that was made.
 */
export async function assessModelFit(input: AssessModelFitInput): Promise<AssessModelFitResult> {
  const parsed = assessModelFitInputSchema.parse(input)

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
    ...(response.budget && { budget: response.budget }),
    ...(response.estimate && { estimate: response.estimate }),
    models: response.models,
    reasons: response.reasons,
    assumptions: response.assumptions
  }
}
