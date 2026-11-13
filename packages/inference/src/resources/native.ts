import os from 'bare-os'
import { randomUUID } from 'bare-crypto'
import type { ResourceCollectorDependencies } from '@/resources/types'
import { cpuModule, gpuModule } from '@/resources/native-modules.cjs'

function supportedEnumValues(values: Record<string, number>, unknownValue: number) {
  return Object.values(values).filter((value) => value !== unknownValue)
}

const cpuArchitectures =
  cpuModule.status === 'fulfilled'
    ? supportedEnumValues(cpuModule.value.constants.arch, cpuModule.value.constants.arch.UNKNOWN)
    : []

const gpuTypes =
  gpuModule.status === 'fulfilled'
    ? supportedEnumValues(
        gpuModule.value.constants.gpuType,
        gpuModule.value.constants.gpuType.UNKNOWN
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
    return new cpuModule.value()
  },
  createGPUInfo() {
    if (gpuModule.status !== 'fulfilled') return undefined
    return new gpuModule.value()
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
