import { send } from '@/client/rpc/rpc-client'
import {
  type DecideParams,
  type DecideRequest,
  type DecideResponse,
  type RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

/**
 * Scores typed questions against a state with a decision model.
 *
 * @param params - `modelId`, `state`, and `questions`. `images` is the optional extension hook.
 * @param options - Optional RPC options including per-call profiling.
 * @returns Answers and token usage. `usage.output_tokens` is always 0.
 * @throws {QvacErrorBase} When validation fails, the model is missing, or the addon fails.
 */
export function decide(
  params: DecideParams,
  options?: RPCOptions
): Promise<Pick<DecideResponse, 'answers' | 'usage'>> & { requestId: string } {
  const requestId = generateClientRequestId()
  const inner = runDecide(params, requestId, options)
  return decoratePromise(inner, { requestId })
}

async function runDecide(
  params: DecideParams,
  requestId: string,
  options?: RPCOptions
): Promise<Pick<DecideResponse, 'answers' | 'usage'>> {
  const request: DecideRequest = {
    type: 'decide',
    ...params,
    requestId
  }

  const response = await send(request, options)
  if (response.type !== 'decide') {
    throw new InvalidResponseError('decide')
  }

  return {
    answers: response.answers,
    usage: response.usage
  }
}
