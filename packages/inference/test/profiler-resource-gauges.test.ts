import test from 'brittle'
import { OPERATION_EVENT_KEY } from '@/schemas'
import { profileReplyHandler } from '@/profiling'
import type { ProfilingEvent } from '@/profiling/types'
import { initializeResourceCollector, destroyResourceCollector } from '@/resources/instance'

test('operation profiling: resource gauges sample only when requested', async (t) => {
  let sampleCalls = 0
  destroyResourceCollector()

  const withoutCollector = await profileReplyHandler(
    {
      op: 'resourceTest',
      request: {},
      perCall: { enabled: true, includeResourceGauges: true }
    },
    async () => ({ ok: true })
  )
  const eventWithoutCollector = (withoutCollector as { [OPERATION_EVENT_KEY]?: ProfilingEvent })[
    OPERATION_EVENT_KEY
  ]
  t.absent(eventWithoutCollector?.resources, 'an uninitialized collector produces no gauge block')

  initializeResourceCollector({
    cpuArchitectures: [1],
    platform: 'linux',
    gpuTypes: [1],
    createCPUInfo: () => ({
      query: () => ({
        name: 'CPU',
        vendor: 'Vendor',
        arch: 1,
        physicalCores: 4,
        logicalCores: 8,
        performanceCores: 4,
        efficiencyCores: 0,
        frequency: 1,
        cacheLine: 64,
        memory: 4096
      }),
      sample: () => {
        sampleCalls++
        return { compute: 0.25, memoryUsed: 1024, memoryTotal: 4096 }
      },
      destroy: () => {}
    }),
    createGPUInfo: () => undefined,
    createGPUId: () => 'gpu-1',
    now: () => 123,
    sampleProcessMemory: () => ({ usedBytes: 512, availableBytes: undefined })
  })

  const unprofiled = await profileReplyHandler(
    { op: 'resourceTest', request: {}, perCall: { enabled: false } },
    async () => ({ ok: true })
  )
  t.is(sampleCalls, 0, 'disabled profiling does not sample')
  t.absent(
    (unprofiled as { [OPERATION_EVENT_KEY]?: ProfilingEvent })[OPERATION_EVENT_KEY],
    'disabled profiling has no operation event'
  )

  const profiledWithoutResources = await profileReplyHandler(
    {
      op: 'resourceTest',
      request: {},
      perCall: { enabled: true }
    },
    async () => ({ ok: true })
  )
  const operationWithoutResources = (
    profiledWithoutResources as { [OPERATION_EVENT_KEY]?: ProfilingEvent }
  )[OPERATION_EVENT_KEY]
  t.is(sampleCalls, 0, 'profiling without resource opt-in does not sample')
  t.absent(operationWithoutResources?.resources)

  const profiled = await profileReplyHandler(
    {
      op: 'resourceTest',
      request: {},
      perCall: { enabled: true, includeResourceGauges: true }
    },
    async () => ({ ok: true })
  )
  const operationEvent = (profiled as { [OPERATION_EVENT_KEY]?: ProfilingEvent })[
    OPERATION_EVENT_KEY
  ]
  t.is(sampleCalls, 1, 'opt-in profiling samples once')
  t.ok(
    operationEvent?.resources?.sampledAt !== undefined &&
      operationEvent.resources.sampledAt >= operationEvent.ts,
    'resource sample uses the event monotonic clock'
  )
  t.is(operationEvent?.resources?.cpu.status, 'supported')
  t.is(operationEvent?.resources?.memory.usedBytes.status, 'supported')
  t.is(operationEvent?.resources?.gpus.status, 'failed')

  destroyResourceCollector()
})
