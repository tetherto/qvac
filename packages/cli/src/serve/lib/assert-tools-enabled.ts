import { HttpError } from '@/serve/lib/http-error'

export function assertToolsEnabled(
  modelConfig: Record<string, unknown>,
  tools: { length: number } | undefined,
  modelAlias: string
): void {
  if (!tools || tools.length === 0) return
  if (modelConfig['tools'] === true) return
  throw new HttpError(
    400,
    'tools_not_enabled',
    `Model "${modelAlias}" was loaded without tool calling. Set serve.models.${modelAlias}.config.tools to true and reload the model.`
  )
}
