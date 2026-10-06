import type { TestDefinition } from '@qvac/test-suite'

// No declarative bodies: `getRpcDeviceMap` is a JS-only helper, and cancelling a discovery needs the
// in-flight call's request id, which `start` does not expose.

export const rpcServerLifecycle = {
  testId: 'rpc-server-lifecycle',
  params: {},
  expectation: {
    validation: 'contains-all',
    contains: ['distinct IDs', 'transport reported', 'stop confirmed']
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
export const rpcServerCancelDiscovery = {
  testId: 'rpc-server-cancel-discovery',
  params: {},
  expectation: {
    validation: 'contains-all',
    contains: ['discovery cancelled', 'other discovery completed', 'completed cancel harmless']
  },
  metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 5000 }
} as const satisfies TestDefinition
export const rpcServerTests = [
  rpcServerLifecycle,
  rpcServerEmptyDiscovery,
  rpcServerUnknownStop,
  rpcServerUnsafeAdvertisement,
  rpcServerCancelDiscovery,
  {
    testId: 'rpc-server-device-map',
    params: {},
    expectation: {
      validation: 'contains-all',
      contains: ['RDMA preferred', 'RPC0,RPC1,RPC2', 'second endpoint RPC2']
    },
    metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 1000 }
  },
  {
    testId: 'rpc-server-device-map-empty',
    params: {},
    expectation: { validation: 'contains-all', contains: ['no devices'] },
    metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 1000 }
  },
  {
    testId: 'rpc-server-device-map-invalid',
    params: {},
    expectation: { validation: 'throws-error', errorContains: 'native device order' },
    metadata: { category: 'rpc-server', dependency: 'none', estimatedDurationMs: 1000 }
  }
] as const satisfies readonly TestDefinition[]
