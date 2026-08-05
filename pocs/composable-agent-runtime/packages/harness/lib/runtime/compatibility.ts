import type { HarnessRuntimeInfo } from '../connect.ts'

export interface HarnessRuntimeHandshake {
  readonly component: 'harness'
  readonly contract: 'qvac.harness'
  readonly protocolVersion: 2
  readonly buildVersion: string
  readonly capabilities: readonly string[]
}

/**
 * Lives here rather than beside `createHarness` so the React Native entry can
 * export it without pulling the desktop launcher -- and its `import.meta` -- into
 * a Hermes bundle.
 */
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
    'state.port',
    'tool.approval'
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

export const HARNESS_HANDSHAKE = harnessCompatibility
