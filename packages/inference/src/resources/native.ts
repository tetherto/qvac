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

// `availableMemory()` reports the constrained memory on iOS.
const reportsProcessAllowance = os.platform() === 'ios'

export const nativeResourceCollectorDependencies: ResourceCollectorDependencies = {
  cpuArchitectures,
  gpuTypes,
  platform: os.platform(),
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
    // A throw here is a sampling failure, not a platform gap: let it reach the
    // collector so the metric reports `failed` rather than `unavailable`.
    const usage = os.memoryUsage()
    const available = reportsProcessAllowance ? os.availableMemory() : 0
    return {
      usedBytes: usage && usage.rss > 0 ? usage.rss : undefined,
      // Zero states no headroom, which is not a budget.
      availableBytes: available > 0 ? available : undefined
    }
  }
}
