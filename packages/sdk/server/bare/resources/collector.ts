import {
  failedMetric,
  normalizeBooleanMetric,
  normalizeEnumMetric,
  normalizeNonNegativeIntegerMetric,
  normalizeNonNegativeMetric,
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
  SystemResourceCollector,
  SystemResourceSample
} from '@/server/bare/resources/types'

const CPU_SOURCE = 'bare-cpu-info'
const GPU_SOURCE = 'bare-gpu-info'
const CPU_ARCHITECTURES = [1, 2, 3, 4] as const
const GPU_TYPES = [1, 2, 3, 4] as const

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
  const normalized = normalizeNonNegativeMetric(value, gpuDeviceProvenance, true)
  if (normalized.status !== 'supported') return normalized

  return unverifiedMetric(reason)
}

function normalizeDriverCapabilities(
  drivers: NativeGPUCapabilities['drivers']
): GraphicsDriverCapabilities {
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
  }
}

function normalizeCPUCapabilities(cpu: ReturnType<CPUInfoContext['query']>) {
  const capabilities: CPUResourceCapabilities = {
    name: normalizeStringMetric(cpu.name, cpuProvenance),
    vendor: normalizeStringMetric(cpu.vendor, cpuProvenance),
    architecture: normalizeEnumMetric(cpu.arch, CPU_ARCHITECTURES, cpuProvenance),
    physicalCores: normalizeNonNegativeIntegerMetric(cpu.physicalCores, cpuProvenance, false),
    logicalCores: normalizeNonNegativeIntegerMetric(cpu.logicalCores, cpuProvenance, false),
    performanceCores: normalizeNonNegativeIntegerMetric(cpu.performanceCores, cpuProvenance, true),
    efficiencyCores: normalizeNonNegativeIntegerMetric(cpu.efficiencyCores, cpuProvenance, true),
    frequencyHz: normalizeNonNegativeIntegerMetric(cpu.frequency, cpuProvenance, false),
    cacheLineBytes: normalizeNonNegativeIntegerMetric(cpu.cacheLine, cpuProvenance, false)
  }

  return capabilities
}

function normalizeGPUCapabilities(gpu: NativeGPUCapabilities, id: string) {
  const capabilities: GPUResourceCapabilities = {
    id,
    name: normalizeStringMetric(gpu.name, gpuDeviceProvenance),
    vendor: normalizeStringMetric(gpu.vendor, gpuDeviceProvenance),
    type: normalizeEnumMetric(gpu.type, GPU_TYPES, gpuDeviceProvenance),
    driverName: normalizeStringMetric(gpu.driverName, gpuDeviceProvenance),
    driverVersion: normalizeStringMetric(gpu.driverVersion, gpuDeviceProvenance),
    drivers: normalizeDriverCapabilities(gpu.drivers),
    unifiedMemory: normalizeBooleanMetric(gpu.unifiedMemory, gpuDeviceProvenance),
    memoryTotalBytes: normalizeAmbiguousNonNegativeMetric(
      gpu.memory,
      'GPU memory scope is unverified'
    )
  }

  return capabilities
}

function failedGPUSample(id: string, reason: string): GPUResourceSample {
  return {
    id,
    compute: failedMetric(reason),
    encode: failedMetric(reason),
    decode: failedMetric(reason),
    memoryUsedBytes: failedMetric(reason),
    memoryTotalBytes: failedMetric(reason),
    powerWatts: failedMetric(reason),
    temperatureCelsius: failedMetric(reason)
  }
}

function normalizeGPUSample(id: string, usage: NativeGPUUsage): GPUResourceSample {
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
      'GPU memory scope is unverified'
    ),
    powerWatts: normalizeNonNegativeMetric(usage.power, gpuDeviceProvenance, true),
    temperatureCelsius: normalizeNonNegativeMetric(usage.temperature, gpuDeviceProvenance, true)
  }
}

export function createSystemResourceCollector(
  dependencies: ResourceCollectorDependencies
): SystemResourceCollector {
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
      cpuCapabilities = supportedMetric(normalizeCPUCapabilities(cpu), cpuProvenance)
      memoryCapabilities = {
        totalBytes: normalizeNonNegativeIntegerMetric(cpu.memory, cpuSystemProvenance, false)
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
        normalizeGPUCapabilities(gpu, dependencies.createGPUId())
      )
      gpuIds = normalized.map((gpu) => gpu.id)
      gpuCapabilities = supportedMetric(normalized, gpuProvenance)
    }
  } catch {
    gpuCapabilities = failedMetric('GPU collector initialization failed')
  }

  const capabilities: SystemResourceCapabilities = {
    cpu: cpuCapabilities,
    memory: memoryCapabilities,
    gpus: gpuCapabilities
  }

  function getCapabilities() {
    return capabilities
  }

  function sampleCPU() {
    if (!cpuContext) {
      const failure = failedMetric<number>('CPU collector is unavailable')
      return {
        cpu: failure,
        memory: {
          usedBytes: failure,
          totalBytes: failure
        }
      }
    }

    try {
      const usage = cpuContext.sample()
      return {
        cpu: normalizeUtilizationMetric(usage.compute, cpuSystemProvenance),
        memory: {
          usedBytes: normalizeNonNegativeIntegerMetric(usage.memoryUsed, cpuSystemProvenance, true),
          totalBytes: normalizeNonNegativeIntegerMetric(
            usage.memoryTotal,
            cpuSystemProvenance,
            false
          )
        }
      }
    } catch {
      const failure = failedMetric<number>('CPU resource sampling failed')
      return {
        cpu: failure,
        memory: {
          usedBytes: failure,
          totalBytes: failure
        }
      }
    }
  }

  function sampleGPUs(): SystemResourceSample['gpus'] {
    if (!gpuContext) return failedMetric('GPU collector is unavailable')
    if (gpuCapabilities.status !== 'supported') {
      return failedMetric('GPU inventory is unavailable')
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

    try {
      cpuContext?.destroy()
    } catch {}

    try {
      gpuContext?.destroy()
    } catch {}

    cpuContext = undefined
    gpuContext = undefined
    gpuIds = []
  }

  return {
    getCapabilities,
    sample,
    destroy
  }
}
