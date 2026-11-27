import type { RunOptions } from '@qvac/llm-llamacpp'
import type { GenerationParams, ResponseFormat } from '@/schemas/index'
import { getResponseFormatJsonSchema } from '@/utils/response-format'

export type NativeGenerationParams = NonNullable<RunOptions['generationParams']>

export function toNativeGenerationParams(
  params: GenerationParams | undefined,
  responseFormat?: ResponseFormat
): NativeGenerationParams {
  const jsonSchema = responseFormat ? getResponseFormatJsonSchema(responseFormat) : undefined
  return {
    ...(params?.temperature !== undefined && { temp: params.temperature }),
    ...(params?.topP !== undefined && { top_p: params.topP }),
    ...(params?.topK !== undefined && { top_k: params.topK }),
    ...(params?.predict !== undefined && { predict: params.predict }),
    ...(params?.seed !== undefined && { seed: params.seed }),
    ...(params?.frequencyPenalty !== undefined && { frequency_penalty: params.frequencyPenalty }),
    ...(params?.presencePenalty !== undefined && { presence_penalty: params.presencePenalty }),
    ...(params?.repeatPenalty !== undefined && { repeat_penalty: params.repeatPenalty }),
    ...(params?.reasoningBudget !== undefined && { reasoning_budget: params.reasoningBudget }),
    ...(params?.toolChoice !== undefined && { tool_choice: params.toolChoice }),
    ...(jsonSchema !== undefined && { json_schema: jsonSchema }),
    parallel_tool_calls: params?.parallelToolCalls ?? true
  }
}
