import type { HarnessToolBrokerPort } from '../tool-broker.ts'
import { createSandboxToolBroker } from './broker.ts'
import type { ToolSandboxRegistry } from './registry.ts'

export interface CreateDesktopSkillBrokerOptions {
  readonly registry: ToolSandboxRegistry
  readonly sharedBroker?: HarnessToolBrokerPort
}

export function createDesktopSkillBroker({
  registry,
  sharedBroker
}: CreateDesktopSkillBrokerOptions): HarnessToolBrokerPort {
  const routed = createSandboxToolBroker({
    registry,
    sandboxTools: ['http_request', 'exec'],
    ...(sharedBroker ? { sharedBroker } : {})
  })

  return {
    async execute(input) {
      // Approval is enforced once, by the agents tool gate. Enforcing it here
      // too would prompt the user twice for a single call. What stays is the
      // grant *scope* check, which the gate does not model.
      if (input.call.name === 'exec') {
        const granted = input.grants.some(
          (grant) => grant.name === 'exec' && grant.scope === 'obsidian'
        )
        if (!granted) throw new Error('Obsidian exec is not granted')
        if (input.signal.aborted) throw new Error('Obsidian invocation cancelled')
      }
      return routed.execute(input)
    },
    cancel(input) {
      return routed.cancel(input)
    },
    close() {
      return routed.close()
    }
  }
}
