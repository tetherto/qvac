import test from 'brittle'
import {
  BACKEND_DIAGNOSTICS_KEY,
  OPERATION_EVENT_KEY,
  PROFILING_KEY,
  sourceTypeSchema,
  type OperationEvent
} from '@/schemas'
import { buildOperationEvent, profileReplyHandler } from '@/server/rpc/profiling'
import type { ProfilingEvent } from '@/profiling/types'
import { forwardBackendDiagnostics } from '@/profiling/backend-diagnostics'
import { injectProfilingIntoString } from '@/server/rpc/profiling/context'
import {
  attachBackendDiagnostics,
  createDelegatedProfilingMeta,
  extractProfilingMeta
} from '@/profiling'
import { clearAggregator, getAggregates, recordEvent } from '@/profiling/aggregator'
import {
  destroyWorkerResourceCollector,
  initializeWorkerResourceCollector
} from '@/server/bare/resources/worker-collector'
import { readBackendDiagnostics } from '@/server/rpc/profiling/backend-diagnostics'

test('sourceType: accepts expected values and rejects unknown', (t) => {
  const expected = ['hyperdrive', 'http', 'registry', 'filesystem']
  for (const value of expected) {
    t.ok(sourceTypeSchema.safeParse(value).success, `${value} is valid`)
  }

  t.absent(sourceTypeSchema.safeParse('unknown').success, 'unknown is invalid')
})

test('delegated profiling metadata forwards resource opt-in explicitly', (t) => {
  const defaultMeta = createDelegatedProfilingMeta('default')
  const optedInMeta = createDelegatedProfilingMeta('opted-in', {
    includeResources: true
  })

  t.is(defaultMeta.includeResources, false)
  t.is(defaultMeta.resourceOrigin, 'provider')
  t.is(optedInMeta.includeResources, true)
  t.is(optedInMeta.resourceOrigin, 'provider')
})

test('operation metrics: loadModel extracts gauges and tags', (t) => {
  const event = buildOperationEvent(
    'loadModel',
    'profile-1',
    100,
    500,
    { modelType: 'llamacpp-completion' },
    {
      __profilingMeta: {
        sourceType: 'registry',
        downloadStats: {
          downloadTimeMs: 220,
          totalBytesDownloaded: 4096,
          downloadSpeedBps: 18618
        },
        modelInitializationTimeMs: 130,
        totalLoadTimeMs: 500
      }
    }
  )

  t.ok(event, 'event is built')
  t.alike(event!.tags, { modelType: 'llamacpp-completion', sourceType: 'registry' })
  t.is(event!.gauges?.downloadTime, 220)
  t.is(event!.gauges?.totalBytesDownloaded, 4096)
  t.is(event!.gauges?.downloadSpeedBps, 18618)
  t.is(event!.gauges?.modelInitializationTime, 130)
  t.is(event!.gauges?.totalLoadTime, 500)
})

test('operation metrics: omits unavailable gauges (no fabrication)', (t) => {
  const event = buildOperationEvent(
    'loadModel',
    'profile-2',
    100,
    90,
    { modelType: 'llamacpp-completion' },
    {
      __profilingMeta: {
        sourceType: 'filesystem',
        totalLoadTimeMs: 90
      }
    }
  )

  t.ok(event, 'event is built')
  const gauges = event!.gauges ?? {}
  t.is(gauges.totalLoadTime, 90, 'keeps provided metric')
  t.is('downloadTime' in gauges, false, 'does not fabricate downloadTime')
  t.is('totalBytesDownloaded' in gauges, false, 'does not fabricate totalBytesDownloaded')
  t.is('modelInitializationTime' in gauges, false, 'does not fabricate modelInitializationTime')
})

test('operation metrics: attaches backend selection diagnostics', (t) => {
  const diagnostics = {
    selectedBackend: 'llama.cpp-metal',
    selectedDevice: 'gpu',
    graphicsApi: 'metal',
    driver: { name: 'Metal', version: '3' },
    gpuId: 'gpu-opaque-1',
    fallback: {
      requestedBackend: 'llama.cpp-vulkan',
      requestedDevice: 'gpu',
      reason: 'Vulkan backend is unavailable'
    },
    probe: {
      status: 'compatible',
      backend: 'llama.cpp-metal'
    }
  } as const
  const response = attachBackendDiagnostics({}, diagnostics)

  const event = buildOperationEvent(
    'unregisteredBackendOp',
    'profile-backend',
    100,
    50,
    {},
    response
  )

  t.alike(event?.backend, diagnostics)
})

test('backend diagnostics helper rejects malformed producer metadata', (t) => {
  t.exception(() =>
    attachBackendDiagnostics(
      {},
      {
        selectedBackend: '',
        selectedDevice: 'gpu'
      }
    )
  )
})

test('backend diagnostics survive model-factory result forwarding', (t) => {
  const diagnostics = {
    selectedBackend: 'llama.cpp-metal',
    selectedDevice: 'gpu'
  } as const
  const pluginResult = attachBackendDiagnostics({ model: {} }, diagnostics)
  const loadResult = forwardBackendDiagnostics({}, pluginResult)

  t.alike(readBackendDiagnostics(loadResult), diagnostics)
})

test('operation metrics: drops malformed backend diagnostics', (t) => {
  const response = {
    [BACKEND_DIAGNOSTICS_KEY]: {
      selectedBackend: '',
      selectedDevice: 'gpu'
    }
  }

  const event = buildOperationEvent('completionStream', 'profile-backend', 100, 50, {}, response)

  t.absent(event?.backend)
})

test('transport: operation event survives injection/extraction round-trip', (t) => {
  const operation: OperationEvent = {
    op: 'loadModel',
    kind: 'handler',
    ms: 500,
    profileId: 'round-trip-test',
    gauges: { totalLoadTime: 500, downloadTime: 200 },
    resources: {
      origin: 'local',
      sampledAt: 123,
      cpu: {
        status: 'supported',
        value: 0.25,
        provenance: { source: 'bare-cpu-info', scope: 'system' }
      },
      memory: {
        usedBytes: {
          status: 'supported',
          value: 1024,
          provenance: { source: 'bare-cpu-info', scope: 'system' }
        },
        totalBytes: {
          status: 'supported',
          value: 4096,
          provenance: { source: 'bare-cpu-info', scope: 'system' }
        }
      },
      gpus: {
        status: 'supported',
        value: [],
        provenance: { source: 'bare-gpu-info', scope: 'system' }
      }
    },
    backend: {
      selectedBackend: 'llama.cpp-cpu',
      selectedDevice: 'cpu',
      fallback: {
        requestedDevice: 'gpu',
        reason: 'No compatible GPU backend was found'
      },
      probe: {
        status: 'unknown',
        backend: 'llama.cpp-cpu',
        reason: 'The addon does not provide a compatibility probe yet'
      }
    },
    tags: { modelType: 'llamacpp-completion', sourceType: 'registry', cacheHit: 'true' }
  }

  const baseJson = '{"type":"loadModel","success":true}'
  const injected = injectProfilingIntoString(baseJson, { operation })
  const parsed = JSON.parse(injected)
  const extracted = extractProfilingMeta(parsed)

  t.ok(extracted, 'meta extracted')
  t.ok(extracted!.operation, 'operation present')
  t.is(extracted!.operation!.op, 'loadModel')
  t.is(extracted!.operation!.kind, 'handler')
  t.is(extracted!.operation!.ms, 500)
  t.is(extracted!.operation!.profileId, 'round-trip-test')
  t.alike(extracted!.operation!.gauges, { totalLoadTime: 500, downloadTime: 200 })
  t.alike(extracted!.operation!.resources, operation.resources)
  t.alike(extracted!.operation!.backend, operation.backend)
  t.alike(extracted!.operation!.tags, {
    modelType: 'llamacpp-completion',
    sourceType: 'registry',
    cacheHit: 'true'
  })
})

test('operation profiling: resource gauges sample only when requested', async (t) => {
  let sampleCalls = 0
  destroyWorkerResourceCollector()

  const withoutCollector = await profileReplyHandler(
    {
      op: 'resourceTest',
      request: {},
      perCall: { enabled: true, includeResourceGauges: true }
    },
    async () => ({ ok: true })
  )
  const eventWithoutCollector = (withoutCollector as { [OPERATION_EVENT_KEY]?: OperationEvent })[
    OPERATION_EVENT_KEY
  ]
  t.absent(eventWithoutCollector?.resources, 'an uninitialized collector produces no gauge block')

  initializeWorkerResourceCollector({
    cpuArchitectures: [1],
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
    now: () => 123
  })

  const unprofiled = await profileReplyHandler(
    { op: 'resourceTest', request: {}, perCall: { enabled: false } },
    async () => ({ ok: true })
  )
  t.is(sampleCalls, 0, 'disabled profiling does not sample')
  t.absent(
    (unprofiled as { [OPERATION_EVENT_KEY]?: OperationEvent })[OPERATION_EVENT_KEY],
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
    profiledWithoutResources as { [OPERATION_EVENT_KEY]?: OperationEvent }
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
  const operationEvent = (profiled as { [OPERATION_EVENT_KEY]?: OperationEvent })[
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
  t.is(operationEvent?.resources?.origin, 'local')

  const providerProfiled = await profileReplyHandler(
    {
      op: 'resourceTest',
      request: {
        [PROFILING_KEY]: createDelegatedProfilingMeta('provider-profile', {
          includeResources: true
        })
      }
    },
    async () => ({ ok: true })
  )
  const providerOperation = (providerProfiled as { [OPERATION_EVENT_KEY]?: OperationEvent })[
    OPERATION_EVENT_KEY
  ]
  t.is(sampleCalls, 2, 'delegated resource opt-in samples once')
  t.is(providerOperation?.resources?.origin, 'provider')

  destroyWorkerResourceCollector()
})

test('cacheHit: cache-hit path omits download metrics', (t) => {
  clearAggregator()

  const cacheHitEvent: OperationEvent = {
    op: 'loadModel',
    kind: 'handler',
    ms: 500,
    gauges: {
      totalLoadTime: 500,
      modelInitializationTime: 400
    },
    tags: { sourceType: 'registry', cacheHit: 'true' }
  }

  recordEvent({ ...cacheHitEvent, ts: Date.now() } as ProfilingEvent)

  const aggregates = getAggregates()
  t.ok(aggregates['loadModel.totalLoadTime'], 'totalLoadTime aggregated')
  t.ok(aggregates['loadModel.modelInitializationTime'], 'modelInitializationTime aggregated')
  t.absent(aggregates['loadModel.downloadSpeedBps'], 'downloadSpeedBps omitted on cache hit')
  t.absent(aggregates['loadModel.downloadTime'], 'downloadTime omitted on cache hit')
  t.absent(
    aggregates['loadModel.totalBytesDownloaded'],
    'totalBytesDownloaded omitted on cache hit'
  )

  clearAggregator()
})

test('cacheHit: cache-miss path includes download metrics', (t) => {
  clearAggregator()

  const cacheMissEvent: OperationEvent = {
    op: 'loadModel',
    kind: 'handler',
    ms: 2000,
    gauges: {
      totalLoadTime: 2000,
      modelInitializationTime: 400,
      downloadTime: 1500,
      totalBytesDownloaded: 1000000,
      downloadSpeedBps: 666666
    },
    tags: { sourceType: 'registry', cacheHit: 'false' }
  }

  recordEvent({ ...cacheMissEvent, ts: Date.now() } as ProfilingEvent)

  const aggregates = getAggregates()
  t.ok(aggregates['loadModel.totalLoadTime'], 'totalLoadTime aggregated')
  t.ok(aggregates['loadModel.modelInitializationTime'], 'modelInitializationTime aggregated')
  t.ok(aggregates['loadModel.downloadTime'], 'downloadTime aggregated')
  t.ok(aggregates['loadModel.totalBytesDownloaded'], 'totalBytesDownloaded aggregated')
  t.ok(aggregates['loadModel.downloadSpeedBps'], 'downloadSpeedBps aggregated')

  clearAggregator()
})
