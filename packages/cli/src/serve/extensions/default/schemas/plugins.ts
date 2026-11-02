import { z } from 'zod'

export const pluginInvokeParams = z.strictObject({
  name: z.string().min(1).describe("The plugin's model type: the `type` of the `model` alias.")
})

/** Mirrors the SDK's `invokePlugin()` and `invokePluginStream()` arguments. */
export const pluginInvokeBody = z.strictObject({
  model: z.string().min(1).describe('A `serve.models` alias whose `type` is the plugin.'),
  handler: z.string().min(1).describe('The plugin handler to call.'),
  params: z
    .unknown()
    .optional()
    .describe('Passed to the handler as-is; the plugin validates it. Default: `{}`.'),
  stream: z
    .boolean()
    .optional()
    .describe('Call a streaming handler and answer with SSE. Default: `false`.')
})

export const pluginInvocation = z.object({
  object: z.literal('plugin.invocation'),
  model: z.string(),
  handler: z.string(),
  result: z.unknown().describe("The handler's result, validated by the plugin.")
})

export const PLUGINS_FIELD_CODES: Record<string, string> = {
  handler: 'missing_handler'
}
