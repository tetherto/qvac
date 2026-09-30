import { llamacppCompletionConfigSchema } from '@qvac/sdk/schemas'
import { HttpError } from '@/serve/lib/http-error'

const toolsFlagSchema = llamacppCompletionConfigSchema.pick({ tools: true })

export function toolsRequested(tools: { length: number } | undefined): boolean {
  return Boolean(tools && tools.length > 0)
}

function modelLoadedWithTools(modelConfig: Record<string, unknown>): boolean {
  const parsed = toolsFlagSchema.safeParse(modelConfig)
  return parsed.success && parsed.data.tools === true
}

export function assertToolsEnabled(
  modelConfig: Record<string, unknown>,
  tools: { length: number } | undefined,
  modelAlias: string
): void {
  if (!toolsRequested(tools)) return
  if (modelLoadedWithTools(modelConfig)) return
  throw new HttpError(
    400,
    'tools_not_enabled',
    `Model "${modelAlias}" was loaded without tool calling. Set serve.models.${modelAlias}.config.tools to true and reload the model.`
  )
}
