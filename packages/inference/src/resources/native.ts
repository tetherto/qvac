import os from 'bare-os'
import { randomUUID } from 'bare-crypto'
import type { ResourceCollectorDependencies } from '@/resources/types'

// Load independently so one unavailable native addon cannot disable the other collector.
const [cpuModule, gpuModule] = await Promise.allSettled([
  import('bare-cpu-info'),
  import('bare-gpu-info')
])

function supportedEnumValues(values: Record<string, number>, unknownValue: number) {
  return Object.values(values).filter((value) => value !== unknownValue)
}

const cpuArchitectures =
  cpuModule.status === 'fulfilled'
    ? supportedEnumValues(
        cpuModule.value.default.constants.arch,
        cpuModule.value.default.constants.arch.UNKNOWN
      )
    : []

const gpuTypes =
  gpuModule.status === 'fulfilled'
    ? supportedEnumValues(
        gpuModule.value.default.constants.gpuType,
        gpuModule.value.default.constants.gpuType.UNKNOWN
      )
    : []

export const nativeResourceCollectorDependencies: ResourceCollectorDependencies = {
  cpuArchitectures,
  gpuTypes,
  createCPUInfo() {
    if (cpuModule.status !== 'fulfilled') return undefined
    return new cpuModule.value.default()
  },
  createGPUInfo() {
    if (gpuModule.status !== 'fulfilled') return undefined
    return new gpuModule.value.default()
  },
  createGPUId() {
    return randomUUID()
  },
  now() {
    return Date.now()
  },
  sampleProcessMemory() {
    let usedBytes: number | undefined
    try {
      const usage = os.memoryUsage()
      usedBytes = usage && usage.rss > 0 ? usage.rss : undefined
    } catch {
      usedBytes = undefined
    }
    // No platform exposes the per-process allowance yet. On iOS this is
    // `os_proc_available_memory()` — the limit jetsam actually enforces — and
    // it needs a native source before the metric can report a value.
    return { usedBytes, availableBytes: undefined }
  }
}
