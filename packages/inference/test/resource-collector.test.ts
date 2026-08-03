import test from 'brittle'
import { z } from 'zod'
import { nativeResourceCollectorDependencies } from '@/resources/native'
import {
  getResourceCollector,
  initializeResourceCollector,
  destroyResourceCollector
} from '@/resources/instance'
import { registerPlugin } from '@/plugins'
import { cleanupForTerminate } from '@/runtime/lifecycle'
import type { QvacPlugin } from '@/schemas/plugin'
import { getSystemResourcesResponseSchema } from '@/schemas/system-resources'
import { handleGetSystemResources } from '@/handlers/get-system-resources'

test('collects CPU and system memory in Bare', (t) => {
  destroyResourceCollector()
  const collector = initializeResourceCollector(nativeResourceCollectorDependencies)

  const capabilities = collector.getCapabilities()
  const sample = collector.sample()

  t.is(capabilities.cpu.status, 'supported')
  t.is(capabilities.memory.totalBytes.status, 'supported')
  t.is(sample.cpu.status, 'supported')
  t.is(sample.memory.usedBytes.status, 'supported')
  t.is(sample.memory.totalBytes.status, 'supported')

  destroyResourceCollector()
})

test('serves system resources through the local handler in Bare', (t) => {
  destroyResourceCollector()
  initializeResourceCollector(nativeResourceCollectorDependencies)

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

  destroyResourceCollector()
})

test('releases native contexts during cleanup', async (t) => {
  destroyResourceCollector()
  const collector = initializeResourceCollector(nativeResourceCollectorDependencies)
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
  t.is(getResourceCollector(), undefined)
  t.execution(() => destroyResourceCollector())
})
