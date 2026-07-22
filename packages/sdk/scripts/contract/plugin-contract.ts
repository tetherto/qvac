import type { QvacPlugin } from '@/schemas'
import { toWireJsonSchema } from '@/scripts/contract/build-contract'

export interface PluginHandlerContract {
  name: string
  streaming: boolean
  requestSchema: unknown
  responseSchema: unknown
}

export interface PluginContract {
  modelType: string
  displayName?: string
  handlers: PluginHandlerContract[]
}

/**
 * Wire contract of one registered plugin: JSON Schema per handler, in the
 * same wire shape the built-in contract export uses (requests as input
 * shape, responses as output shape). Custom plugins register at runtime, so
 * unlike the built-in contract this isn't emitted by `contract:export` —
 * plugin authors (or app builds) run `scripts/export-plugin-contract.ts` on
 * their plugin module and feed the result to the Python generator's
 * `--plugin` input to get typed clients for their handlers.
 */
export function buildPluginContract(plugin: QvacPlugin): PluginContract {
  const handlers = Object.entries(plugin.handlers).map(function ([name, handler]) {
    return {
      name,
      streaming: handler.streaming === true,
      requestSchema: toWireJsonSchema(
        handler.requestSchema,
        'input',
        `${plugin.modelType}.${name}.request`
      ),
      responseSchema: toWireJsonSchema(
        handler.responseSchema,
        'output',
        `${plugin.modelType}.${name}.response`
      )
    }
  })
  handlers.sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return {
    modelType: plugin.modelType,
    ...(plugin.displayName && { displayName: plugin.displayName }),
    handlers
  }
}
