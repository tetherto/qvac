import { randomUUID } from 'bare-crypto'
import type { ResourceCollectorDependencies } from '@/server/bare/resources/types'

// Load independently so one unavailable native addon cannot disable the other collector.
const [cpuModule, gpuModule] = await Promise.allSettled([
  import('bare-cpu-info'),
  import('bare-gpu-info')
])

export const nativeResourceCollectorDependencies: ResourceCollectorDependencies = {
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
