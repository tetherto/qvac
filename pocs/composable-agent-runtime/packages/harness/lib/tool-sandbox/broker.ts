import type {
  HarnessToolBrokerPort,
  HarnessToolInvocation
} from '../tool-broker.ts'
import type { ToolSandboxRegistry } from './registry.ts'

export interface CreateSandboxToolBrokerOptions {
  readonly registry: ToolSandboxRegistry
  readonly sandboxTools: readonly string[]
  readonly sharedBroker?: HarnessToolBrokerPort
}

type Route = 'sandbox' | 'shared'

export function createSandboxToolBroker({
  registry,
  sandboxTools,
  sharedBroker
}: CreateSandboxToolBrokerOptions): HarnessToolBrokerPort {
  const isolated = new Set(sandboxTools)
  const routes = new Map<string, Route>()

  return {
    async execute(input) {
      const key = invocationKey(input)
      if (isolated.has(input.call.name)) {
        routes.set(key, 'sandbox')
        try {
          const result = await registry.invoke({
            agentId: input.agentId,
            invocationId: input.operationId,
            toolName: input.call.name,
            input: input.call.arguments
          })
          if (result.status === 'success') return result.value
          const error = new Error(result.error.message)
          Reflect.set(error, 'code', result.error.code)
          throw error
        } finally {
          routes.delete(key)
        }
      }

      if (!sharedBroker) {
        throw new Error(`no shared tool broker configured for ${input.call.name}`)
      }
      routes.set(key, 'shared')
      try {
        return await sharedBroker.execute(input)
      } finally {
        routes.delete(key)
      }
    },
    async cancel(input) {
      const route = routes.get(invocationKey(input))
      if (route === 'sandbox') {
        await registry.cancel({
          agentId: input.agentId,
          invocationId: input.operationId
        })
      } else if (route === 'shared') {
        await sharedBroker?.cancel(input)
      }
    },
    async close() {
      await Promise.all([registry.close(), sharedBroker?.close()])
    }
  }
}

function invocationKey(
  input: Pick<
    HarnessToolInvocation,
    'agentId' | 'runId' | 'operationId'
  >
) {
  return `${input.agentId}\0${input.runId}\0${input.operationId}`
}
