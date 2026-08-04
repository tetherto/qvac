import type { HarnessRuntimeInfo } from '../connect.ts'

export interface HarnessRuntimeHandshake {
  readonly component: 'harness'
  readonly contract: 'qvac.harness'
  readonly protocolVersion: 2
  readonly buildVersion: string
  readonly capabilities: readonly string[]
}

export const harnessCompatibility: HarnessRuntimeHandshake = {
  component: 'harness',
  contract: 'qvac.harness',
  protocolVersion: 2,
  buildVersion: '0.0.0-poc',
  capabilities: [
    'agent.register',
    'agent.run',
    'agent.cancel',
    'run.read',
    'work.watch',
    'state.port'
  ]
}

export function assertCompatibleHarness(info: HarnessRuntimeInfo) {
  if (
    info.component !== harnessCompatibility.component ||
    info.contract !== harnessCompatibility.contract ||
    info.protocolVersion !== harnessCompatibility.protocolVersion ||
    info.buildVersion !== harnessCompatibility.buildVersion
  ) {
    throw new Error(
      `incompatible Harness runtime: expected ${harnessCompatibility.contract} protocol ${harnessCompatibility.protocolVersion} build ${harnessCompatibility.buildVersion}`
    )
  }
}
