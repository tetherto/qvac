import test from 'brittle'
import { z } from 'zod'
import { nativeResourceCollectorDependencies } from '@/server/bare/resources/native'
import {
  getWorkerResourceCollector,
  initializeWorkerResourceCollector,
  destroyWorkerResourceCollector
} from '@/server/bare/resources/worker-collector'
import { registerPlugin } from '@/server/plugins'
import { cleanupForTerminate } from '@/server/worker-core'
import type { QvacPlugin } from '@/schemas/plugin'
import { getSystemResourcesResponseSchema } from '@/schemas/system-resources'
import { handleGetSystemResources } from '@/server/rpc/handlers/get-system-resources'

test('collects CPU and system memory in Bare', (t) => {
  destroyWorkerResourceCollector()
  const collector = initializeWorkerResourceCollector(nativeResourceCollectorDependencies)

  const capabilities = collector.getCapabilities()
  const sample = collector.sample()

  t.is(capabilities.cpu.status, 'supported')
  t.is(capabilities.memory.totalBytes.status, 'supported')
  t.is(sample.cpu.status, 'supported')
  t.is(sample.memory.usedBytes.status, 'supported')
  t.is(sample.memory.totalBytes.status, 'supported')

  destroyWorkerResourceCollector()
})

test('serves system resources through the local RPC handler in Bare', (t) => {
  destroyWorkerResourceCollector()
  initializeWorkerResourceCollector(nativeResourceCollectorDependencies)

  const capabilitiesOnly = handleGetSystemResources({
    type: 'getSystemResources'
  })
  const withSample = handleGetSystemResources({
    type: 'getSystemResources',
    sample: true
  })

  t.absent(capabilitiesOnly.sample)
  t.ok(withSample.sample)
  t.execution(() => getSystemResourcesResponseSchema.parse(capabilitiesOnly))
  t.execution(() => getSystemResourcesResponseSchema.parse(withSample))

  destroyWorkerResourceCollector()
})

test('releases native contexts during worker cleanup', async (t) => {
  destroyWorkerResourceCollector()
  const collector = initializeWorkerResourceCollector(nativeResourceCollectorDependencies)
  registerPlugin({
    modelType: 'resource-cleanup-test',
    displayName: 'Resource cleanup test',
    addonPackage: 'resource-cleanup-test',
    loadConfigSchema: z.object({}),
    async createModel() {
      return undefined
    },
    handlers: {},
    logging: {
      module: {
        setLogger() {},
        releaseLogger() {
          throw new Error('plugin cleanup failed')
        }
      }
    }
  } as unknown as QvacPlugin)

  t.execution(() => collector.getCapabilities())
  await cleanupForTerminate()
  t.is(getWorkerResourceCollector(), undefined)
  t.execution(() => destroyWorkerResourceCollector())
})
