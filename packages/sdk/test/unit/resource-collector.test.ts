import test from 'brittle'
import { createSystemResourceCollector } from '@/server/bare/resources/collector'
import {
  destroyWorkerResourceCollector,
  initializeWorkerResourceCollector
} from '@/server/bare/resources/worker-collector'
import { handleGetSystemResources } from '@/server/rpc/handlers/get-system-resources'
import { getSystemResourcesResponseSchema } from '@/schemas/system-resources'

const drivers = {
  vulkan: false,
  opencl: true,
  opengl: true,
  webgpu: false,
  metal: true,
  direct3d11: false,
  direct3d12: false,
  cuda: false,
  levelZero: false,
  rocm: false
}

function createFixture(options?: {
  failCPUInitialization?: boolean
  failGPUInitialization?: boolean
  failCPUSample?: boolean
  failCPUDestroy?: boolean
  missingCPUCollector?: boolean
  missingGPUCollector?: boolean
  cpuArchitecture?: number
  gpuType?: number
  cpuArchitectures?: readonly number[]
  gpuTypes?: readonly number[]
  gpuMemory?: number
  emptyGPUInventory?: boolean
}) {
  const calls = {
    createCPU: 0,
    createGPU: 0,
    cpuQuery: 0,
    cpuSample: 0,
    gpuQuery: 0,
    gpuSample: 0,
    cpuDestroy: 0,
    gpuDestroy: 0,
    gpuIds: 0
  }

  const cpu = {
    query() {
      calls.cpuQuery++
      return {
        name: 'Test CPU',
        vendor: 'Test Vendor',
        arch: options?.cpuArchitecture ?? 1,
        physicalCores: 4,
        logicalCores: 8,
        performanceCores: 4,
        efficiencyCores: 0,
        frequency: 3_000_000_000,
        cacheLine: 64,
        memory: 16_000
      }
    },
    sample() {
      calls.cpuSample++
      if (options?.failCPUSample) throw new Error('cpu sample failed')
      return {
        compute: 0,
        memoryUsed: 0,
        memoryTotal: 16_000
      }
    },
    destroy() {
      calls.cpuDestroy++
      if (options?.failCPUDestroy) throw new Error('cpu destroy failed')
    }
  }

  const gpu = {
    gpus() {
      calls.gpuQuery++
      if (options?.emptyGPUInventory) return []
      return [
        {
          name: 'Test GPU',
          vendor: 'GPU Vendor',
          driverName: 'Test Driver',
          driverVersion: '1.0',
          type: options?.gpuType ?? 2,
          drivers,
          vendorId: 123,
          deviceId: 456,
          subsystemId: 789,
          revision: 3,
          unifiedMemory: true,
          memory: options?.gpuMemory ?? 8_000
        }
      ]
    },
    sample(index: number) {
      calls.gpuSample++
      if (index !== 0) throw new Error('unexpected GPU index')
      return {
        compute: 0,
        encode: undefined,
        decode: undefined,
        memoryUsed: 0,
        memoryTotal: 8_000,
        power: undefined,
        temperature: 42
      }
    },
    destroy() {
      calls.gpuDestroy++
    }
  }

  const dependencies = {
    cpuArchitectures: options?.cpuArchitectures ?? [1, 2, 3, 4],
    gpuTypes: options?.gpuTypes ?? [1, 2, 3, 4],
    createCPUInfo() {
      calls.createCPU++
      if (options?.missingCPUCollector) return undefined
      if (options?.failCPUInitialization) throw new Error('cpu init failed')
      return cpu
    },
    createGPUInfo() {
      calls.createGPU++
      if (options?.missingGPUCollector) return undefined
      if (options?.failGPUInitialization) throw new Error('gpu init failed')
      return gpu
    },
    now() {
      return 1234
    },
    createGPUId() {
      calls.gpuIds++
      return `opaque-${calls.gpuIds}`
    }
  }

  return { calls, dependencies }
}

test('creates one context and caches static capabilities', (t) => {
  const { calls, dependencies } = createFixture()
  const collector = createSystemResourceCollector(dependencies)

  const first = collector.getCapabilities()
  const second = collector.getCapabilities()

  t.is(first, second)
  t.is(calls.createCPU, 1)
  t.is(calls.createGPU, 1)
  t.is(calls.cpuQuery, 1)
  t.is(calls.gpuQuery, 1)
  t.is(calls.cpuSample, 0)
  t.is(calls.gpuSample, 0)
})

test('samples live values only when requested', (t) => {
  const { calls, dependencies } = createFixture()
  const collector = createSystemResourceCollector(dependencies)

  const sample = collector.sample()

  t.is(sample.sampledAt, 1234)
  t.alike(sample.cpu, {
    status: 'supported',
    value: 0,
    provenance: { source: 'bare-cpu-info', scope: 'system' }
  })
  t.is(sample.memory.usedBytes.status, 'supported')
  t.is(sample.gpus.status, 'supported')
  if (sample.gpus.status === 'supported') {
    t.is(sample.gpus.value[0]?.compute.status, 'supported')
    t.is(sample.gpus.value[0]?.memoryUsedBytes.status, 'unverified')
  }
  t.is(calls.cpuSample, 1)
  t.is(calls.gpuSample, 1)
})

test('contains CPU and GPU initialization failures independently', (t) => {
  const cpuFailure = createSystemResourceCollector(
    createFixture({ failCPUInitialization: true }).dependencies
  ).getCapabilities()
  const gpuFailure = createSystemResourceCollector(
    createFixture({ failGPUInitialization: true }).dependencies
  ).getCapabilities()

  t.is(cpuFailure.cpu.status, 'failed')
  t.is(cpuFailure.memory.totalBytes.status, 'failed')
  t.is(cpuFailure.gpus.status, 'supported')
  t.is(gpuFailure.cpu.status, 'supported')
  t.is(gpuFailure.gpus.status, 'failed')
})

test('contains missing native collector modules independently', (t) => {
  const cpuMissing = createSystemResourceCollector(
    createFixture({ missingCPUCollector: true }).dependencies
  ).getCapabilities()
  const gpuMissing = createSystemResourceCollector(
    createFixture({ missingGPUCollector: true }).dependencies
  ).getCapabilities()

  t.is(cpuMissing.cpu.status, 'failed')
  t.is(cpuMissing.gpus.status, 'supported')
  t.is(gpuMissing.cpu.status, 'supported')
  t.is(gpuMissing.gpus.status, 'failed')
})

test('normalizes unknown and malformed hardware enums as unverified', (t) => {
  const unknown = createSystemResourceCollector(
    createFixture({ cpuArchitecture: 0, gpuType: 0 }).dependencies
  ).getCapabilities()
  const malformed = createSystemResourceCollector(
    createFixture({ cpuArchitecture: 1.5, gpuType: 99 }).dependencies
  ).getCapabilities()

  t.is(unknown.cpu.status, 'supported')
  t.is(unknown.gpus.status, 'supported')
  if (unknown.cpu.status === 'supported') {
    t.is(unknown.cpu.value.architecture.status, 'unverified')
  }
  if (unknown.gpus.status === 'supported') {
    t.is(unknown.gpus.value[0]?.type.status, 'unverified')
  }
  if (malformed.cpu.status === 'supported') {
    t.is(malformed.cpu.value.architecture.status, 'unverified')
  }
  if (malformed.gpus.status === 'supported') {
    t.is(malformed.gpus.value[0]?.type.status, 'unverified')
  }
})

test('normalizes hardware enums against native dependency constants', (t) => {
  const capabilities = createSystemResourceCollector(
    createFixture({
      cpuArchitecture: 1,
      gpuType: 2,
      cpuArchitectures: [2, 3, 4],
      gpuTypes: [1, 3, 4]
    }).dependencies
  ).getCapabilities()

  t.is(capabilities.cpu.status, 'supported')
  t.is(capabilities.gpus.status, 'supported')
  if (capabilities.cpu.status === 'supported') {
    t.is(capabilities.cpu.value.architecture.status, 'unverified')
  }
  if (capabilities.gpus.status === 'supported') {
    t.is(capabilities.gpus.value[0]?.type.status, 'unverified')
  }
})

test('distinguishes malformed GPU memory from ambiguous memory scope', (t) => {
  const valid = createSystemResourceCollector(createFixture().dependencies).getCapabilities()
  const malformed = createSystemResourceCollector(
    createFixture({ gpuMemory: -1 }).dependencies
  ).getCapabilities()

  t.is(valid.gpus.status, 'supported')
  t.is(malformed.gpus.status, 'supported')
  if (valid.gpus.status === 'supported' && malformed.gpus.status === 'supported') {
    t.alike(valid.gpus.value[0]?.memoryTotalBytes, {
      status: 'unverified',
      reason: 'GPU memory scope is unverified'
    })
    t.alike(malformed.gpus.value[0]?.memoryTotalBytes, {
      status: 'unverified',
      reason: 'Metric value could not be verified'
    })
  }
})

test('uses opaque GPU IDs that do not repeat across collectors', (t) => {
  const { dependencies } = createFixture()
  const first = createSystemResourceCollector(dependencies).getCapabilities()
  const second = createSystemResourceCollector(dependencies).getCapabilities()

  t.is(first.gpus.status, 'supported')
  t.is(second.gpus.status, 'supported')
  if (first.gpus.status === 'supported' && second.gpus.status === 'supported') {
    t.not(first.gpus.value[0]?.id, second.gpus.value[0]?.id)
  }
})

test('keeps raw GPU identities private', (t) => {
  const collector = createSystemResourceCollector(createFixture().dependencies)
  const capabilities = collector.getCapabilities()

  t.is(capabilities.gpus.status, 'supported')
  if (capabilities.gpus.status === 'supported') {
    const gpu = capabilities.gpus.value[0]
    t.absent(gpu && 'vendorId' in gpu)
    t.absent(gpu && 'deviceId' in gpu)
    t.absent(gpu && 'subsystemId' in gpu)
    t.absent(gpu && 'revision' in gpu)
  }
})

test('continues GPU sampling when CPU sampling fails', (t) => {
  const { calls, dependencies } = createFixture({ failCPUSample: true })
  const collector = createSystemResourceCollector(dependencies)

  const sample = collector.sample()

  t.is(sample.cpu.status, 'failed')
  t.is(sample.memory.usedBytes.status, 'failed')
  t.is(sample.gpus.status, 'supported')
  t.is(calls.gpuSample, 1)
})

test('destroys both contexts once even when one destroy fails', (t) => {
  const { calls, dependencies } = createFixture({ failCPUDestroy: true })
  const collector = createSystemResourceCollector(dependencies)

  t.execution(() => collector.destroy())
  t.execution(() => collector.destroy())

  t.is(calls.cpuDestroy, 1)
  t.is(calls.gpuDestroy, 1)
})

test('resource RPC returns cached capabilities and samples only on request', (t) => {
  destroyWorkerResourceCollector()
  const { calls, dependencies } = createFixture()
  initializeWorkerResourceCollector(dependencies)

  const capabilitiesOnly = handleGetSystemResources({
    type: 'getSystemResources'
  })
  t.is(capabilitiesOnly.type, 'getSystemResources')
  t.absent(capabilitiesOnly.sample)
  t.is(calls.cpuSample, 0)
  t.is(calls.gpuSample, 0)

  const withSample = handleGetSystemResources({
    type: 'getSystemResources',
    sample: true
  })
  t.is(withSample.sample?.sampledAt, 1234)
  t.is(calls.cpuSample, 1)
  t.is(calls.gpuSample, 1)
  t.execution(() => getSystemResourcesResponseSchema.parse(withSample))

  destroyWorkerResourceCollector()
})

test('resource RPC preserves an empty supported GPU inventory', (t) => {
  destroyWorkerResourceCollector()
  initializeWorkerResourceCollector(createFixture({ emptyGPUInventory: true }).dependencies)

  const response = handleGetSystemResources({
    type: 'getSystemResources',
    sample: true
  })

  t.is(response.capabilities.gpus.status, 'supported')
  if (response.capabilities.gpus.status === 'supported') {
    t.alike(response.capabilities.gpus.value, [])
  }
  t.is(response.sample?.gpus.status, 'supported')
  if (response.sample?.gpus.status === 'supported') {
    t.alike(response.sample.gpus.value, [])
  }

  destroyWorkerResourceCollector()
})

test('resource RPC reports failed metrics when the collector is unavailable', (t) => {
  destroyWorkerResourceCollector()

  const response = handleGetSystemResources({
    type: 'getSystemResources',
    sample: true
  })

  t.is(response.capabilities.cpu.status, 'failed')
  t.is(response.capabilities.memory.totalBytes.status, 'failed')
  t.is(response.capabilities.gpus.status, 'failed')
  t.is(response.sample?.cpu.status, 'failed')
  t.execution(() => getSystemResourcesResponseSchema.parse(response))
})
