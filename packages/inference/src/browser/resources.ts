// Browser replacement for resources/native.ts. The native CPU and GPU probes
// have no browser equivalent, so both collectors report `unavailable`.
import type { ResourceCollectorDependencies } from '@/resources/types'
import { browser } from './globals'

export const nativeResourceCollectorDependencies: ResourceCollectorDependencies = {
  cpuArchitectures: [],
  gpuTypes: [],
  platform: 'browser',
  createCPUInfo() {
    return undefined
  },
  createGPUInfo() {
    return undefined
  },
  createGPUId() {
    return browser.crypto.randomUUID()
  },
  now() {
    return Date.now()
  },
  sampleProcessMemory() {
    return { usedBytes: undefined, availableBytes: undefined }
  }
}
