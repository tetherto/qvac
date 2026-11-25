import { z } from 'zod'

export const runtimeState = z.object({
  object: z.literal('runtime.state'),
  state: z.enum(['active', 'suspending', 'suspended', 'resuming'])
})

// The on-disk path and fit probe are left out: this list is open to every
// client, not only admins.
export const runtimeModel = z.object({
  object: z.literal('runtime.model'),
  model: z.string().describe('The `serve.models` alias.'),
  modelId: z.string().describe('The SDK model ID behind the alias.'),
  modelType: z.string(),
  handlers: z.array(z.string()).describe('SDK operations the loaded model accepts.'),
  displayName: z.string().optional(),
  addonPackage: z.string().optional(),
  name: z.string().optional(),
  loadedAt: z.number().describe('Load time, in milliseconds since the epoch.')
})

export type RuntimeModel = z.infer<typeof runtimeModel>

export const runtimeModelsResult = z.object({
  object: z.literal('list'),
  data: z.array(runtimeModel)
})

export const runtimeCapability = z.object({
  id: z
    .string()
    .describe(
      'Capability contract ID, such as `transcription`. A dotted ID names a contract a third-party plugin defines.'
    ),
  version: z.number().int().min(1).describe('Major version of the contract.'),
  operations: z
    .array(z.string())
    .describe('Operations every registered plugin that declares the contract implements.'),
  partialOperations: z
    .array(z.string())
    .describe(
      'Optional operations only some of those plugins implement. A call uses the plugin of the selected model.'
    )
})

export const runtimeCapabilitiesResult = z.object({
  object: z.literal('list'),
  data: z.array(runtimeCapability)
})
