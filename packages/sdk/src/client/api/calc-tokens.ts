import { parseClientInput } from '@/client/parse-input'
import { send } from '@/client/rpc/rpc-client'
import {
  calcTokensParamsSchema,
  calcTokensResponseSchema,
  type CalcTokensParams,
  type RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Counts tokens with a loaded language model without running generation.
 *
 * `text` alone is counted raw. Supplying `history` renders the conversation
 * with the model's chat template; `text`, when present, becomes its final user
 * turn. Tools are counted as part of that rendered prompt.
 */
export async function calcTokens(params: CalcTokensParams, options?: RPCOptions): Promise<number> {
  return createCalcTokensCall(params, options)
}

export async function createCalcTokensCall(
  params: CalcTokensParams,
  options?: RPCOptions,
  sendRequest: typeof send = send
): Promise<number> {
  const input = parseClientInput(calcTokensParamsSchema, params)
  const response = await sendRequest({ ...input, type: 'calcTokens' }, options)
  if (response.type !== 'calcTokens') throw new InvalidResponseError('calcTokens')
  const parsed = calcTokensResponseSchema.safeParse(response)
  if (!parsed.success) throw new InvalidResponseError('calcTokens', parsed.error)
  return parsed.data.tokens
}
