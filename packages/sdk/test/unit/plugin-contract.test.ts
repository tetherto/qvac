import test from 'brittle'
import { z } from 'zod'
import { definePlugin, defineHandler } from '@/schemas'
import { buildPluginContract } from '@/scripts/contract/plugin-contract'

const plugin = definePlugin({
  modelType: 'echo-test',
  displayName: 'Echo (unit)',
  addonPackage: 'echo-test',
  loadConfigSchema: z.object({}).passthrough(),
  createModel() {
    return { model: { async load() {}, unload() {} } }
  },
  handlers: {
    echoStream: defineHandler({
      requestSchema: z.object({ message: z.string() }),
      responseSchema: z.object({ chunk: z.string() }),
      streaming: true,
      async *handler(request: { message: string }) {
        yield { chunk: request.message }
      }
    }),
    echo: defineHandler({
      requestSchema: z.object({ message: z.string(), times: z.number().int().optional() }),
      responseSchema: z.object({ message: z.string() }),
      streaming: false,
      async handler(request: { message: string }) {
        return { message: request.message }
      }
    })
  }
})

test('buildPluginContract: JSON Schema per handler, sorted, streaming flagged', (t) => {
  const contract = buildPluginContract(plugin)

  t.is(contract.modelType, 'echo-test')
  t.is(contract.displayName, 'Echo (unit)')
  t.alike(
    contract.handlers.map((handler) => handler.name),
    ['echo', 'echoStream'],
    'handlers sorted by name'
  )

  const echo = contract.handlers[0]!
  t.is(echo.streaming, false)
  const request = echo.requestSchema as {
    properties: Record<string, unknown>
    required?: string[]
  }
  t.alike(Object.keys(request.properties).sort(), ['message', 'times'])
  t.alike(request.required, ['message'], 'optional fields stay out of required')

  const echoStream = contract.handlers[1]!
  t.is(echoStream.streaming, true)
  const response = echoStream.responseSchema as { properties: Record<string, unknown> }
  t.alike(Object.keys(response.properties), ['chunk'])
})
