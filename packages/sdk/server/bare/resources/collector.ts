import {
  failedMetric,
  normalizeBooleanMetric,
  normalizeEnumMetric,
  normalizeNonNegativeIntegerMetric,
  normalizeNonNegativeMetric,
  normalizePositiveIntegerMetric,
  normalizeStringMetric,
  normalizeUtilizationMetric,
  unavailableMetric,
  unverifiedMetric
} from '@/server/bare/resources/normalize'
import type {
  CPUInfoContext,
  CPUResourceCapabilities,
  GPUInfoContext,
  GPUResourceCapabilities,
  GPUResourceSample,
  GraphicsDriverCapabilities,
  NativeGPUCapabilities,
  NativeGPUUsage,
  ResourceCollectorDependencies,
  ResourceMetric,
  ResourceProvenance,
  SystemResourceCapabilities,
  SystemResourceCollector
} from '@/server/bare/resources/types'

const CPU_SOURCE = 'bare-cpu-info'
const GPU_SOURCE = 'bare-gpu-info'
const GPU_MEMORY_SCOPE_REASON = 'GPU memory scope is unverified'

const cpuSystemProvenance = {
  source: CPU_SOURCE,
  scope: 'system'
} as const

const cpuProvenance = {
  source: CPU_SOURCE
} as const

const gpuDeviceProvenance = {
  source: GPU_SOURCE,
  scope: 'device'
} as const

const gpuProvenance = {
  source: GPU_SOURCE
} as const

function supportedMetric<T>(value: T, provenance: ResourceProvenance): ResourceMetric<T> {
  return { status: 'supported', value, provenance }
}

function normalizeAmbiguousNonNegativeMetric(
  value: unknown,
  reason: string
): ResourceMetric<number> {
  if (value === undefined || value === null) return unavailableMetric()
  const normalized = normalizeNonNegativeMetric(value, gpuDeviceProvenance)
  if (normalized.status !== 'supported') return normalized

  return unverifiedMetric(reason)
}

function normalizeDriverCapabilities(drivers: NativeGPUCapabilities['drivers']) {
  return {
    vulkan: normalizeBooleanMetric(drivers.vulkan, gpuProvenance),
    opencl: normalizeBooleanMetric(drivers.opencl, gpuProvenance),
    opengl: normalizeBooleanMetric(drivers.opengl, gpuProvenance),
    webgpu: normalizeBooleanMetric(drivers.webgpu, gpuProvenance),
    metal: normalizeBooleanMetric(drivers.metal, gpuProvenance),
    direct3d11: normalizeBooleanMetric(drivers.direct3d11, gpuProvenance),
    direct3d12: normalizeBooleanMetric(drivers.direct3d12, gpuProvenance),
    cuda: normalizeBooleanMetric(drivers.cuda, gpuProvenance),
    levelZero: normalizeBooleanMetric(drivers.levelZero, gpuProvenance),
    rocm: normalizeBooleanMetric(drivers.rocm, gpuProvenance)
  } satisfies GraphicsDriverCapabilities
}

function normalizeCPUCapabilities(
  cpu: ReturnType<CPUInfoContext['query']>,
  architectures: readonly number[]
) {
  return {
    name: normalizeStringMetric(cpu.name, cpuProvenance),
    vendor: normalizeStringMetric(cpu.vendor, cpuProvenance),
    architecture: normalizeEnumMetric(cpu.arch, architectures, cpuProvenance),
    physicalCores: normalizePositiveIntegerMetric(cpu.physicalCores, cpuProvenance),
    logicalCores: normalizePositiveIntegerMetric(cpu.logicalCores, cpuProvenance),
    performanceCores: normalizeNonNegativeIntegerMetric(cpu.performanceCores, cpuProvenance),
    efficiencyCores: normalizeNonNegativeIntegerMetric(cpu.efficiencyCores, cpuProvenance),
    frequencyHz: normalizePositiveIntegerMetric(cpu.frequency, cpuProvenance),
    cacheLineBytes: normalizePositiveIntegerMetric(cpu.cacheLine, cpuProvenance)
  } satisfies CPUResourceCapabilities
}

function normalizeGPUCapabilities(
  gpu: NativeGPUCapabilities,
  id: string,
  gpuTypes: readonly number[]
) {
  return {
    id,
    name: normalizeStringMetric(gpu.name, gpuDeviceProvenance),
    vendor: normalizeStringMetric(gpu.vendor, gpuDeviceProvenance),
    type: normalizeEnumMetric(gpu.type, gpuTypes, gpuDeviceProvenance),
    driverName: normalizeStringMetric(gpu.driverName, gpuDeviceProvenance),
    driverVersion: normalizeStringMetric(gpu.driverVersion, gpuDeviceProvenance),
    drivers: normalizeDriverCapabilities(gpu.drivers),
    unifiedMemory: normalizeBooleanMetric(gpu.unifiedMemory, gpuDeviceProvenance),
    memoryTotalBytes: normalizeAmbiguousNonNegativeMetric(gpu.memory, GPU_MEMORY_SCOPE_REASON)
  } satisfies GPUResourceCapabilities
}

function failedCPUSample(reason: string) {
  const failure = failedMetric<number>(reason)
  return {
    cpu: failure,
    memory: {
      usedBytes: failure,
      totalBytes: failure
    }
  }
}

function failedGPUSample(id: string, reason: string) {
  return {
    id,
    compute: failedMetric(reason),
    encode: failedMetric(reason),
    decode: failedMetric(reason),
    memoryUsedBytes: failedMetric(reason),
    memoryTotalBytes: failedMetric(reason),
    powerWatts: failedMetric(reason),
    temperatureCelsius: failedMetric(reason)
  } satisfies GPUResourceSample
}

function normalizeGPUSample(id: string, usage: NativeGPUUsage) {
  return {
    id,
    compute: normalizeUtilizationMetric(usage.compute, gpuDeviceProvenance),
    encode: normalizeUtilizationMetric(usage.encode, gpuDeviceProvenance),
    decode: normalizeUtilizationMetric(usage.decode, gpuDeviceProvenance),
    memoryUsedBytes: normalizeAmbiguousNonNegativeMetric(
      usage.memoryUsed,
      'GPU memory usage scope is unverified'
    ),
    memoryTotalBytes: normalizeAmbiguousNonNegativeMetric(
      usage.memoryTotal,
      GPU_MEMORY_SCOPE_REASON
    ),
    powerWatts: normalizeNonNegativeMetric(usage.power, gpuDeviceProvenance),
    temperatureCelsius: normalizeNonNegativeMetric(usage.temperature, gpuDeviceProvenance)
  } satisfies GPUResourceSample
}

function destroyContext(context: { destroy(): void } | undefined) {
  try {
    context?.destroy()
  } catch {
    // Teardown must continue so every native context gets a release attempt.
  }
}

export function createSystemResourceCollector(dependencies: ResourceCollectorDependencies) {
  let cpuContext: CPUInfoContext | undefined
  let gpuContext: GPUInfoContext | undefined
  let gpuIds: string[] = []
  let destroyed = false

  let cpuCapabilities: SystemResourceCapabilities['cpu']
  let memoryCapabilities: SystemResourceCapabilities['memory']
  let gpuCapabilities: SystemResourceCapabilities['gpus']

  try {
    const context = dependencies.createCPUInfo()
    if (!context) {
      cpuCapabilities = failedMetric('CPU collector module is unavailable')
      memoryCapabilities = {
        totalBytes: failedMetric('CPU collector module is unavailable')
      }
    } else {
      cpuContext = context
      const cpu = context.query()
      cpuCapabilities = supportedMetric(
        normalizeCPUCapabilities(cpu, dependencies.cpuArchitectures),
        cpuProvenance
      )
      memoryCapabilities = {
        totalBytes: normalizePositiveIntegerMetric(cpu.memory, cpuSystemProvenance)
      }
    }
  } catch {
    cpuCapabilities = failedMetric('CPU collector initialization failed')
    memoryCapabilities = {
      totalBytes: failedMetric('CPU collector initialization failed')
    }
  }

  try {
    const context = dependencies.createGPUInfo()
    if (!context) {
      gpuCapabilities = failedMetric('GPU collector module is unavailable')
    } else {
      gpuContext = context
      const gpus = context.gpus()
      const normalized = gpus.map((gpu) =>
        normalizeGPUCapabilities(gpu, dependencies.createGPUId(), dependencies.gpuTypes)
      )
      gpuIds = normalized.map((gpu) => gpu.id)
      gpuCapabilities = supportedMetric(normalized, gpuProvenance)
    }
  } catch {
    gpuCapabilities = failedMetric('GPU collector initialization failed')
  }

  const capabilities = {
    cpu: cpuCapabilities,
    memory: memoryCapabilities,
    gpus: gpuCapabilities
  } satisfies SystemResourceCapabilities

  function getCapabilities() {
    return capabilities
  }

  function sampleCPU() {
    if (!cpuContext) {
      return failedCPUSample('CPU collector is unavailable')
    }

    try {
      const usage = cpuContext.sample()
      return {
        cpu: normalizeUtilizationMetric(usage.compute, cpuSystemProvenance),
        memory: {
          usedBytes: normalizeNonNegativeIntegerMetric(usage.memoryUsed, cpuSystemProvenance),
          totalBytes: normalizePositiveIntegerMetric(usage.memoryTotal, cpuSystemProvenance)
        }
      }
    } catch {
      return failedCPUSample('CPU resource sampling failed')
    }
  }

  function sampleGPUs() {
    if (!gpuContext) return failedMetric<GPUResourceSample[]>('GPU collector is unavailable')
    if (gpuCapabilities.status !== 'supported') {
      return failedMetric<GPUResourceSample[]>('GPU inventory is unavailable')
    }

    const context = gpuContext
    const samples = gpuIds.map((id, index) => {
      try {
        return normalizeGPUSample(id, context.sample(index))
      } catch {
        return failedGPUSample(id, 'GPU resource sampling failed')
      }
    })

    return supportedMetric(samples, gpuProvenance)
  }

  function sample() {
    const cpuSample = sampleCPU()
    return {
      sampledAt: dependencies.now(),
      cpu: cpuSample.cpu,
      memory: cpuSample.memory,
      gpus: sampleGPUs()
    }
  }

  function destroy() {
    if (destroyed) return
    destroyed = true

    destroyContext(cpuContext)
    destroyContext(gpuContext)

    cpuContext = undefined
    gpuContext = undefined
    gpuIds = []
  }

  return {
    getCapabilities,
    sample,
    destroy
  } satisfies SystemResourceCollector
}
