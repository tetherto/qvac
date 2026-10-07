import { send } from '@/dispatch'
import {
  decideParamsSchema,
  decideResponseSchema,
  type DecideParams,
  type LayaResult,
  type LayaResponse,
  type RPCOptions
} from '@/schemas/index'
import { InvalidResponseError } from '@/errors/index'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateRequestId } from '@/runtime/request-id'
import { parseClientInput } from '@/api/parse-input'

/**
 * Answers typed Laya questions about one state or a batch of states.
 *
 * @param params - Model ID, states, questions, and optional token budgets.
 * @param options - Dispatch options.
 * @returns A promise with a synchronous requestId for cancel(). One state
 * resolves to one result; a batch resolves to results in input order.
 * @throws {RequestValidationFailedError} If the request is invalid.
 * @throws {InferenceCancelledError} If the request is cancelled.
 * @throws {RequestRejectedByPolicyError} If this model has an active decision request.
 * @throws {InvalidResponseError} If the handler returns a malformed result.
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
  const requestId = generateRequestId()
  return decoratePromise(runDecide(params, requestId, options), { requestId })
}

async function runDecide(
  params: DecideParams,
  requestId: string,
  options?: RPCOptions
): Promise<LayaResponse> {
  const input = parseClientInput(decideParamsSchema, params)
  const response = await send({ ...input, type: 'decide', requestId }, options)
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
