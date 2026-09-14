import { HttpError } from '@/serve/lib/http-error'

export function toolsRequested(tools: { length: number } | undefined): boolean {
  return Boolean(tools && tools.length > 0)
}

export function assertToolsEnabled(
  modelConfig: Record<string, unknown>,
  tools: { length: number } | undefined,
  modelAlias: string
): void {
  if (!toolsRequested(tools)) return
  if (modelConfig['tools'] === true) return
  throw new HttpError(
    400,
    'tools_not_enabled',
    `Model "${modelAlias}" was loaded without tool calling. Set serve.models.${modelAlias}.config.tools to true and reload the model.`
  )
}
