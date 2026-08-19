import type {
  GraphicsDriver,
  SystemResourceCapabilities,
  SystemResourceSample
} from '@/schemas/system-resources'

export type {
  CPUResourceCapabilities,
  GPUResourceCapabilities,
  GPUResourceSample,
  GraphicsDriver,
  GraphicsDriverCapabilities,
  ResourceMetric,
  ResourceProvenance,
  ResourceScope,
  SystemResourceCapabilities,
  SystemResourceSample
} from '@/schemas/system-resources'

export interface NativeCPUCapabilities {
  name: string | null
  vendor: string | null
  arch: number
  physicalCores: number
  logicalCores: number
  performanceCores: number
  efficiencyCores: number
  frequency: number | undefined
  cacheLine: number | undefined
  memory: number | undefined
}

export interface NativeCPUUsage {
  compute: number | undefined
  memoryUsed: number | undefined
  memoryTotal: number | undefined
}

export interface CPUInfoContext {
  query(): NativeCPUCapabilities
  sample(): NativeCPUUsage
  destroy(): void
}

export interface NativeGPUCapabilities {
  name: string | null
  vendor: string | null
  driverName: string | null
  driverVersion: string | null
  type: number
  drivers: Record<GraphicsDriver, boolean>
  vendorId: number | undefined
  deviceId: number | undefined
  subsystemId: number | undefined
  revision: number
  unifiedMemory: boolean
  memory: number | undefined
}

export interface NativeGPUUsage {
  compute: number | undefined
  encode: number | undefined
  decode: number | undefined
  memoryUsed: number | undefined
  memoryTotal: number | undefined
  power: number | undefined
  temperature: number | undefined
}

export interface GPUInfoContext {
  gpus(): NativeGPUCapabilities[]
  sample(index: number): NativeGPUUsage
  destroy(): void
}

export interface ResourceCollectorDependencies {
  cpuArchitectures: readonly number[]
  gpuTypes: readonly number[]
  createCPUInfo(): CPUInfoContext | undefined
  createGPUInfo(): GPUInfoContext | undefined
  createGPUId(): string
  now(): number
}

export interface SystemResourceCollector {
  getCapabilities(): SystemResourceCapabilities
  sample(): SystemResourceSample
  destroy(): void
}
