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
  dedicatedMemory: number | undefined
}

export interface NativeGPUUsage {
  compute: number | undefined
  encode: number | undefined
  decode: number | undefined
  memoryUsed: number | undefined
  memoryTotal: number | undefined
  dedicatedMemoryUsed: number | undefined
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
  /** Runtime platform, used to grade what a GPU memory reading can mean. */
  platform: string
  createCPUInfo(): CPUInfoContext | undefined
  createGPUInfo(): GPUInfoContext | undefined
  createGPUId(): string
  now(): number
  /**
   * The process's resident footprint (RSS), or `undefined` where the platform
   * does not expose it. Read apart from the allowance: a throw fails this
   * reading only.
   */
  sampleProcessUsedBytes(): number | undefined
  /**
   * How much more this process may allocate before the OS intervenes, or
   * `undefined` where the platform states no such limit. A throw fails this
   * reading only.
   */
  sampleProcessAvailableBytes(): number | undefined
}

export interface SystemResourceCollector {
  getCapabilities(): SystemResourceCapabilities
  sample(): SystemResourceSample
  destroy(): void
}
