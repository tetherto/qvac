import type {
  HarnessToolApprovalPort,
  HarnessToolBrokerPort
} from '../tool-broker.ts'
import { createSandboxToolBroker } from './broker.ts'
import type { ToolSandboxRegistry } from './registry.ts'

export interface CreateDesktopSkillBrokerOptions {
  readonly registry: ToolSandboxRegistry
  readonly approval?: HarnessToolApprovalPort
  readonly sharedBroker?: HarnessToolBrokerPort
}

export function createDesktopSkillBroker({
  registry,
  approval,
  sharedBroker
}: CreateDesktopSkillBrokerOptions): HarnessToolBrokerPort {
  const routed = createSandboxToolBroker({
    registry,
    sandboxTools: ['http_request', 'exec'],
    ...(sharedBroker ? { sharedBroker } : {})
  })

  return {
    async execute(input) {
      if (input.call.name === 'exec') {
        const granted = input.grants.some(
          (grant) => grant.name === 'exec' && grant.scope === 'obsidian'
        )
        if (!granted) throw new Error('Obsidian exec is not granted')
        const approved = approval ? await approval.approve(input) : false
        if (!approved) throw new Error('Obsidian approval denied')
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
