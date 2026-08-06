import { randomUUID } from 'bare-crypto'
import type { ResourceCollectorDependencies } from '@/server/bare/resources/types'

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
  }
}
