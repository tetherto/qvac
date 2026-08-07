import { z } from 'zod'

const countSchema = z.number().int().nonnegative()
const nonnegativeNumberSchema = z.number().nonnegative()
const utilizationSchema = z.number().min(0).max(1)

export const resourceScopeSchema = z.enum([
  'system',
  'process',
  'device',
  'budget',
  'shared-system'
])

export const resourceProvenanceSchema = z.object({
  source: z.string(),
  scope: resourceScopeSchema.optional()
})

export function resourceMetricSchema<T extends z.ZodType>(valueSchema: T) {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('supported'),
      value: valueSchema,
      provenance: resourceProvenanceSchema
    }),
    z.object({
      status: z.literal('unavailable'),
      reason: z.string().optional()
    }),
    z.object({
      status: z.literal('unverified'),
      reason: z.string().optional()
    }),
    z.object({
      status: z.literal('failed'),
      reason: z.string().optional()
    })
  ])
}

export const graphicsDriverSchema = z.enum([
  'vulkan',
  'opencl',
  'opengl',
  'webgpu',
  'metal',
  'direct3d11',
  'direct3d12',
  'cuda',
  'levelZero',
  'rocm'
])

export const graphicsDriverCapabilitiesSchema = z.object({
  vulkan: resourceMetricSchema(z.boolean()),
  opencl: resourceMetricSchema(z.boolean()),
  opengl: resourceMetricSchema(z.boolean()),
  webgpu: resourceMetricSchema(z.boolean()),
  metal: resourceMetricSchema(z.boolean()),
  direct3d11: resourceMetricSchema(z.boolean()),
  direct3d12: resourceMetricSchema(z.boolean()),
  cuda: resourceMetricSchema(z.boolean()),
  levelZero: resourceMetricSchema(z.boolean()),
  rocm: resourceMetricSchema(z.boolean())
})

export const backendProbeResultSchema = z.object({
  status: z.enum(['compatible', 'incompatible', 'unknown']),
  backend: z.string().min(1),
  reason: z.string().optional()
})

export const backendDeviceSchema = z.enum(['cpu', 'gpu'])

export const backendDriverSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional()
})

export const backendFallbackSchema = z.object({
  requestedBackend: z.string().min(1).optional(),
  requestedDevice: backendDeviceSchema.optional(),
  reason: z.string().min(1)
})

export const inferenceBackendDiagnosticsSchema = z.object({
  selectedBackend: z.string().min(1),
  selectedDevice: backendDeviceSchema,
  graphicsApi: graphicsDriverSchema.optional(),
  driver: backendDriverSchema.optional(),
  gpuId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "GPU ID from the current worker's resource collector; stable only for that collector's lifetime."
    ),
  fallback: backendFallbackSchema.optional(),
  probe: backendProbeResultSchema.optional()
})

export const cpuResourceCapabilitiesSchema = z.object({
  name: resourceMetricSchema(z.string()),
  vendor: resourceMetricSchema(z.string()),
  architecture: resourceMetricSchema(countSchema),
  physicalCores: resourceMetricSchema(countSchema),
  logicalCores: resourceMetricSchema(countSchema),
  performanceCores: resourceMetricSchema(countSchema),
  efficiencyCores: resourceMetricSchema(countSchema),
  frequencyHz: resourceMetricSchema(nonnegativeNumberSchema),
  cacheLineBytes: resourceMetricSchema(countSchema)
})

export const gpuResourceCapabilitiesSchema = z.object({
  id: z.string(),
  name: resourceMetricSchema(z.string()),
  vendor: resourceMetricSchema(z.string()),
  type: resourceMetricSchema(countSchema),
  driverName: resourceMetricSchema(z.string()),
  driverVersion: resourceMetricSchema(z.string()),
  drivers: graphicsDriverCapabilitiesSchema,
  unifiedMemory: resourceMetricSchema(z.boolean()),
  memoryTotalBytes: resourceMetricSchema(nonnegativeNumberSchema)
})

export const systemResourceCapabilitiesSchema = z.object({
  cpu: resourceMetricSchema(cpuResourceCapabilitiesSchema),
  memory: z.object({
    totalBytes: resourceMetricSchema(nonnegativeNumberSchema)
  }),
  gpus: resourceMetricSchema(z.array(gpuResourceCapabilitiesSchema))
})

export const gpuResourceSampleSchema = z.object({
  id: z.string(),
  compute: resourceMetricSchema(utilizationSchema),
  encode: resourceMetricSchema(utilizationSchema),
  decode: resourceMetricSchema(utilizationSchema),
  memoryUsedBytes: resourceMetricSchema(nonnegativeNumberSchema),
  memoryTotalBytes: resourceMetricSchema(nonnegativeNumberSchema),
  powerWatts: resourceMetricSchema(nonnegativeNumberSchema),
  temperatureCelsius: resourceMetricSchema(z.number())
})

export const systemResourceSampleSchema = z.object({
  sampledAt: nonnegativeNumberSchema,
  cpu: resourceMetricSchema(utilizationSchema),
  memory: z.object({
    usedBytes: resourceMetricSchema(nonnegativeNumberSchema),
    totalBytes: resourceMetricSchema(nonnegativeNumberSchema)
  }),
  gpus: resourceMetricSchema(z.array(gpuResourceSampleSchema))
})

export const systemResourcesSchema = z.object({
  capabilities: systemResourceCapabilitiesSchema,
  sample: systemResourceSampleSchema.optional()
})

export const getSystemResourcesInputSchema = z.object({
  sample: z.boolean().optional()
})

export const getSystemResourcesRequestSchema = getSystemResourcesInputSchema.extend({
  type: z.literal('getSystemResources')
})

export const getSystemResourcesResponseSchema = systemResourcesSchema.extend({
  type: z.literal('getSystemResources')
})

export type ResourceScope = z.infer<typeof resourceScopeSchema>
export type ResourceProvenance = z.infer<typeof resourceProvenanceSchema>
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
export type GraphicsDriver = z.infer<typeof graphicsDriverSchema>
export type GraphicsDriverCapabilities = z.infer<typeof graphicsDriverCapabilitiesSchema>
export type BackendProbeResult = z.infer<typeof backendProbeResultSchema>
export type BackendDevice = z.infer<typeof backendDeviceSchema>
export type BackendDriver = z.infer<typeof backendDriverSchema>
export type BackendFallback = z.infer<typeof backendFallbackSchema>
export type InferenceBackendDiagnostics = z.infer<typeof inferenceBackendDiagnosticsSchema>
export type CPUResourceCapabilities = z.infer<typeof cpuResourceCapabilitiesSchema>
export type GPUResourceCapabilities = z.infer<typeof gpuResourceCapabilitiesSchema>
export type SystemResourceCapabilities = z.infer<typeof systemResourceCapabilitiesSchema>
export type GPUResourceSample = z.infer<typeof gpuResourceSampleSchema>
export type SystemResourceSample = z.infer<typeof systemResourceSampleSchema>
export type SystemResources = z.infer<typeof systemResourcesSchema>
export type GetSystemResourcesInput = z.infer<typeof getSystemResourcesInputSchema>
export type GetSystemResourcesRequest = z.infer<typeof getSystemResourcesRequestSchema>
export type GetSystemResourcesResponse = z.infer<typeof getSystemResourcesResponseSchema>
