import { parseClientInput } from '@/client/parse-input'
import { send } from '@/client/rpc/rpc-client'
import {
  calcTokensParamsSchema,
  calcTokensResponseSchema,
  type CalcTokensParams,
  type RPCOptions,
  type Tool
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'
import { validateTools, type ToolInput } from '@/utils/tool-helpers'

type OmitTools<T> = T extends unknown ? Omit<T, 'tools'> : never

export type CalcTokensClientParams = OmitTools<CalcTokensParams> & {
  tools?: Tool[] | ToolInput[]
}

/**
 * Counts tokens with a loaded language model without running generation.
 *
 * When neither `history` nor enabled tools are supplied, `text` is counted raw.
 * Otherwise, the conversation is rendered with the model's chat template and
 * `text`, when present, becomes its final user turn. Tools are counted only when
 * the model was loaded with `modelConfig.tools: true`.
 * Attachments are not supported.
 * The count uses every supplied tool and the load-time reasoning setting. A named
 * `generationParams.tool_choice` or `generationParams.reasoning_budget` override on
 * `completion()` can render a different prompt.
 *
 * @param params - Loaded model ID and at least one prompt source: `text` or non-empty `history`.
 * @param options - RPC transport options.
 * @returns The number of tokens in the prompt under the model's load-time settings.
 * @throws {RequestValidationFailedError} If the request is invalid.
 * @throws {ModelNotFoundError} If `modelId` is not loaded.
 * @throws {ModelOperationNotSupportedError} If the loaded model is not a language model.
 * @throws {InvalidResponseError} If the worker returns a malformed result.
 */
export async function calcTokens(
  params: CalcTokensClientParams,
  options?: RPCOptions
): Promise<number> {
  return createCalcTokensCall(params, options)
}

export async function createCalcTokensCall(
  params: CalcTokensClientParams,
  options?: RPCOptions,
  sendRequest: typeof send = send
): Promise<number> {
  const tools = params.tools ? validateTools(params.tools).tools : undefined
  const input = parseClientInput(calcTokensParamsSchema, {
    ...params,
    ...(tools !== undefined && { tools })
  })
  const response = await sendRequest({ ...input, type: 'calcTokens' }, options)
  if (response.type !== 'calcTokens') throw new InvalidResponseError('calcTokens')
  const parsed = calcTokensResponseSchema.safeParse(response)
  if (!parsed.success) throw new InvalidResponseError('calcTokens', parsed.error)
  return parsed.data.tokens
}
