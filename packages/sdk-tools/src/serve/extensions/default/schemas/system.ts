import { z } from 'zod'

export const systemQuery = z.object({
  sample: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .describe('Also take a utilization sample: CPU, memory in use, and per-GPU load.')
})

// Loose throughout, so a field the SDK adds later still reaches the client
// through the response serializer.
function metric<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('status', [
    z.looseObject({
      status: z.literal('supported'),
      value,
      provenance: z.looseObject({ source: z.string(), scope: z.string().optional() })
    }),
    z.looseObject({
      status: z.enum(['unavailable', 'unverified', 'failed']),
      reason: z.string().optional()
    })
  ])
}

const numeric = metric(z.number())
const flag = metric(z.boolean())
const text = metric(z.string())

const cpuCapabilities = z.looseObject({
  name: text,
  vendor: text,
  architecture: numeric,
  physicalCores: numeric,
  logicalCores: numeric,
  performanceCores: numeric,
  efficiencyCores: numeric,
  frequencyHz: numeric,
  cacheLineBytes: numeric
})

const gpuCapabilities = z.looseObject({
  id: z.string(),
  name: text,
  vendor: text,
  type: numeric,
  driverName: text,
  driverVersion: text,
  drivers: z.record(z.string(), flag),
  unifiedMemory: flag,
  memoryTotalBytes: numeric
})

const capabilities = z.looseObject({
  cpu: metric(cpuCapabilities),
  memory: z.looseObject({ totalBytes: numeric }),
  gpus: metric(z.array(gpuCapabilities))
})

const gpuSample = z.looseObject({
  id: z.string(),
  compute: numeric,
  encode: numeric,
  decode: numeric,
  memoryUsedBytes: numeric,
  memoryTotalBytes: numeric,
  powerWatts: numeric,
  temperatureCelsius: numeric
})

const sample = z.looseObject({
  sampledAt: z.number(),
  cpu: numeric,
  memory: z.looseObject({
    usedBytes: numeric,
    totalBytes: numeric,
    processUsedBytes: numeric,
    processAvailableBytes: numeric
  }),
  gpus: metric(z.array(gpuSample))
})

export const systemResult = z.object({
  object: z.literal('system'),
  capabilities,
  sample: sample.optional()
})

export const SYSTEM_FIELD_CODES: Record<string, string> = {
  sample: 'invalid_sample'
}
