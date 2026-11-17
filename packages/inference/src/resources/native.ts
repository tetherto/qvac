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
  // A throw from either reader is a sampling failure, not a platform gap: it
  // reaches the collector so that metric reports `failed` rather than
  // `unavailable`. `os.memoryUsage()` throws on JavaScriptCore, whose binding
  // has no heap statistics, and the allowance is read all the same.
  sampleProcessUsedBytes() {
    const usage = os.memoryUsage()
    return usage && usage.rss > 0 ? usage.rss : undefined
  },
  sampleProcessAvailableBytes() {
    if (!reportsProcessAllowance) return undefined
    const available = os.availableMemory()
    // Zero states no headroom, which is not a budget.
    return available > 0 ? available : undefined
  }
}
