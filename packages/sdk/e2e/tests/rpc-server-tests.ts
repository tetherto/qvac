import type { TestDefinition } from '@qvac/test-suite'

export const rpcServerLifecycle = {
  testId: 'rpc-server-lifecycle',
  params: {},
  expectation: {
    validation: 'contains-all',
    contains: ['distinct IDs', 'TCP only', 'stop confirmed']
  },
  metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 20000 }
} as const satisfies TestDefinition
export const rpcServerEmptyDiscovery = {
  testId: 'rpc-server-empty-discovery',
  params: {},
  expectation: { validation: 'contains-all', contains: ['no candidates'] },
  metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 5000 }
} as const satisfies TestDefinition
export const rpcServerUnknownStop = {
  testId: 'rpc-server-unknown-stop',
  params: {},
  expectation: { validation: 'throws-error', errorContains: 'Unknown RPC server' },
  metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 5000 }
} as const satisfies TestDefinition
export const rpcServerUnsafeAdvertisement = {
  testId: 'rpc-server-unsafe-advertisement',
  params: {},
  expectation: { validation: 'throws-error', errorContains: 'private IPv4' },
  metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 5000 }
} as const satisfies TestDefinition
export const rpcServerTests = [
  rpcServerLifecycle,
  rpcServerEmptyDiscovery,
  rpcServerUnknownStop,
  rpcServerUnsafeAdvertisement
] as const
