export type ResourceScope = 'system' | 'process' | 'device' | 'budget' | 'shared-system'

export interface ResourceProvenance {
  source: string
  scope?: ResourceScope
}

export type ResourceMetric<T> =
  | {
      status: 'supported'
      value: T
      provenance: ResourceProvenance
    }
  | {
      status: 'unavailable' | 'unverified' | 'failed'
      reason?: string
    }

export type GraphicsDriver =
  | 'vulkan'
  | 'opencl'
  | 'opengl'
  | 'webgpu'
  | 'metal'
  | 'direct3d11'
  | 'direct3d12'
  | 'cuda'
  | 'levelZero'
  | 'rocm'

export type GraphicsDriverCapabilities = Record<GraphicsDriver, ResourceMetric<boolean>>

export interface CPUResourceCapabilities {
  name: ResourceMetric<string>
  vendor: ResourceMetric<string>
  architecture: ResourceMetric<number>
  physicalCores: ResourceMetric<number>
  logicalCores: ResourceMetric<number>
  performanceCores: ResourceMetric<number>
  efficiencyCores: ResourceMetric<number>
  frequencyHz: ResourceMetric<number>
  cacheLineBytes: ResourceMetric<number>
}

export interface GPUResourceCapabilities {
  id: string
  name: ResourceMetric<string>
  vendor: ResourceMetric<string>
  type: ResourceMetric<number>
  driverName: ResourceMetric<string>
  driverVersion: ResourceMetric<string>
  drivers: GraphicsDriverCapabilities
  unifiedMemory: ResourceMetric<boolean>
  memoryTotalBytes: ResourceMetric<number>
}

export interface SystemResourceCapabilities {
  cpu: ResourceMetric<CPUResourceCapabilities>
  memory: {
    totalBytes: ResourceMetric<number>
  }
  gpus: ResourceMetric<GPUResourceCapabilities[]>
}

export interface GPUResourceSample {
  id: string
  compute: ResourceMetric<number>
  encode: ResourceMetric<number>
  decode: ResourceMetric<number>
  memoryUsedBytes: ResourceMetric<number>
  memoryTotalBytes: ResourceMetric<number>
  powerWatts: ResourceMetric<number>
  temperatureCelsius: ResourceMetric<number>
}

export interface SystemResourceSample {
  sampledAt: number
  cpu: ResourceMetric<number>
  memory: {
    usedBytes: ResourceMetric<number>
    totalBytes: ResourceMetric<number>
  }
  gpus: ResourceMetric<GPUResourceSample[]>
}

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
