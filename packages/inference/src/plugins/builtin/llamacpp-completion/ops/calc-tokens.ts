import type { CalcTokensInput } from '@qvac/llm-llamacpp'
import type { CalcTokensRequest, CalcTokensResponse, Tool } from '@/schemas/index'
import { getModel, getModelConfig } from '@/runtime/model-registry'
import {
  seedConfiguredSystemPrompt,
  transformMessages
} from '@/plugins/builtin/llamacpp-completion/ops/completion-stream'
import { resolveDeferredTools, toWireTool } from '@/utils/tools/defer'

interface TokenCountingModel {
  calcTokens(input: CalcTokensInput): Promise<number>
}

export async function calcTokens(request: CalcTokensRequest): Promise<CalcTokensResponse> {
  const modelConfig = getModelConfig(request.modelId)
  const rendersPrompt = request.history !== undefined || (request.tools?.length ?? 0) > 0
  const history = rendersPrompt
    ? seedConfiguredSystemPrompt(request.history ?? [], modelConfig)
    : undefined
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true
  const deferred = toolsEnabled ? resolveDeferredTools(request.tools, history ?? []) : null
  const tools: Tool[] | undefined = toolsEnabled
    ? (deferred?.toolsToRender ?? request.tools?.map(toWireTool))
    : undefined
  const model = getModel(request.modelId) as unknown as TokenCountingModel
  const transformedHistory = history
    ? (transformMessages(history) as NonNullable<CalcTokensInput['history']>)
    : undefined
  const input: CalcTokensInput = {
    ...(request.text !== undefined && { text: request.text }),
    ...(transformedHistory !== undefined && { history: transformedHistory }),
    ...(tools !== undefined && tools.length > 0 && { tools })
  }

  return { type: 'calcTokens', tokens: await model.calcTokens(input) }
}
