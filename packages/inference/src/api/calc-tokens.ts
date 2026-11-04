import { send } from '@/dispatch'
import {
  calcTokensParamsSchema,
  calcTokensResponseSchema,
  type CalcTokensParams,
  type RPCOptions
} from '@/schemas/index'
import { InvalidResponseError } from '@/errors/index'
import { parseClientInput } from '@/api/parse-input'

/**
 * Counts tokens with a loaded language model without running generation.
 *
 * `text` alone is counted raw. Supplying `history` renders the conversation
 * with the model's chat template; `text`, when present, becomes its final user
 * turn. Tools are counted as part of that rendered prompt.
 */
export async function calcTokens(params: CalcTokensParams, options?: RPCOptions): Promise<number> {
  const input = parseClientInput(calcTokensParamsSchema, params)
  const response = await send({ ...input, type: 'calcTokens' }, options)
  if (response.type !== 'calcTokens') throw new InvalidResponseError('calcTokens')
  const parsed = calcTokensResponseSchema.safeParse(response)
  if (!parsed.success) throw new InvalidResponseError('calcTokens', parsed.error)
  return parsed.data.tokens
}
