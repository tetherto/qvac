import { parseClientInput } from '@/client/parse-input'
import { send } from '@/client/rpc/rpc-client'
import {
  decideParamsSchema,
  decideResponseSchema,
  type DecideParams,
  type LayaResult,
  type LayaResponse,
  type RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

/**
 * Answers typed Laya questions about one state or a batch of states.
 *
 * @param params - Model ID, states, questions, and optional token budgets.
 * @param options - RPC transport options.
 * @returns A promise with a synchronous requestId for cancel(). One state
 * resolves to one result; a batch resolves to results in input order.
 * @throws {RequestValidationFailedError} If the request is invalid.
 * @throws {InferenceCancelledError} If the request is cancelled.
 * @throws {RequestRejectedByPolicyError} If this model has an active decision request.
 * @throws {InvalidResponseError} If the worker returns a malformed result.
 */
export function decide(
  params: Extract<DecideParams, { state: unknown }>,
  options?: RPCOptions
): Promise<LayaResult> & { requestId: string }
export function decide(
  params: Extract<DecideParams, { states: unknown }>,
  options?: RPCOptions
): Promise<LayaResult[]> & { requestId: string }
export function decide(
  params: DecideParams,
  options?: RPCOptions
): Promise<LayaResponse> & { requestId: string }
export function decide(
  params: DecideParams,
  options?: RPCOptions
): Promise<LayaResponse> & { requestId: string } {
  return createDecisionCall(params, options)
}

export function createDecisionCall(
  params: DecideParams,
  options?: RPCOptions,
  sendRequest: typeof send = send
): Promise<LayaResponse> & { requestId: string } {
  const requestId = generateClientRequestId()
  return decoratePromise(runDecide(params, requestId, options, sendRequest), { requestId })
}

async function runDecide(
  params: DecideParams,
  requestId: string,
  options: RPCOptions | undefined,
  sendRequest: typeof send
): Promise<LayaResponse> {
  const input = parseClientInput(decideParamsSchema, params)
  const response = await sendRequest({ ...input, type: 'decide', requestId }, options)
  if (response.type !== 'decide') throw new InvalidResponseError('decide')
  const parsed = decideResponseSchema.safeParse(response)
  if (!parsed.success) throw new InvalidResponseError('decide', parsed.error)
  const { result } = parsed.data
  if (
    'states' in input
      ? !Array.isArray(result) || result.length !== input.states.length
      : Array.isArray(result)
  ) {
    throw new InvalidResponseError('decide')
  }
  return result
}
