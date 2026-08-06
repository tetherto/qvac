import { z } from 'zod'
import {
  gpuResourceSampleSchema,
  inferenceBackendDiagnosticsSchema,
  resourceMetricSchema,
  systemResourceSampleSchema
} from '@/schemas/system-resources'

/** Internal envelope key for profiling metadata in RPC payloads */
export const PROFILING_KEY = '__profiling'

/** Marker key for profiling-only trailer frames in streaming responses */
export const PROFILING_TRAILER_KEY = '__profilingTrailer'

/**
 * Symbol key for attaching delegation breakdown to response objects.
 */
export const DELEGATION_BREAKDOWN_KEY = Symbol.for('@qvac/sdk:delegation-breakdown')

/**
 * Symbol key for attaching operation event to response objects.
 */
export const OPERATION_EVENT_KEY = Symbol.for('@qvac/sdk:operation-event')

/**
 * Symbol key for attaching model execution timing.
 */
export const MODEL_EXECUTION_KEY = Symbol.for('@qvac/sdk:model-execution')

export const BACKEND_DIAGNOSTICS_KEY = Symbol.for('@qvac/sdk:backend-diagnostics')

export const profilerModeSchema = z.enum(['summary', 'verbose'])

export const profilerGPUResourceGaugeSchema = z.object({
  id: z.string(),
  compute: gpuResourceSampleSchema.shape.compute,
  memoryUsedBytes: gpuResourceSampleSchema.shape.memoryUsedBytes
})

export const profilerResourceGaugeSchema = z.object({
  origin: z.enum(['local', 'provider']),
  sampledAt: systemResourceSampleSchema.shape.sampledAt,
  cpu: systemResourceSampleSchema.shape.cpu,
  memory: systemResourceSampleSchema.shape.memory,
  gpus: resourceMetricSchema(z.array(profilerGPUResourceGaugeSchema))
})

/**
 * Server-side timing breakdown (server → client).
 * Attached to profiling response when includeServerBreakdown is enabled.
 */
export const serverBreakdownSchema = z.object({
  requestJsonParseMs: z.number().optional(),
  requestZodValidationMs: z.number().optional(),
  handlerExecutionMs: z.number().optional(),
  responseZodValidationMs: z.number().optional(),
  responseStringifyMs: z.number().optional(),
  totalServerMs: z.number().optional()
})

/**
 * Delegation timing breakdown (consumer server → client).
 * Captures timing for server-to-provider delegation hops.
 * Note: Only injected for unary requests; streaming delegation
 * records server-side but does not inject into response.
 */
export const delegationBreakdownSchema = z.object({
  profileId: z.string().optional(),
  connectionMs: z.number().optional(),
  requestStringifyMs: z.number().optional(),
  serverWaitMs: z.number().optional(),
  responseJsonParseMs: z.number().optional(),
  totalDelegationMs: z.number().optional()
})

export const operationEventSchema = z.object({
  op: z.string(),
  kind: z.literal('handler'),
  ms: z.number(),
  profileId: z.string().optional(),
  gauges: z.record(z.string(), z.number()).optional(),
  resources: profilerResourceGaugeSchema.optional(),
  backend: inferenceBackendDiagnosticsSchema.optional(),
  tags: z.record(z.string(), z.string()).optional(),
  count: z.number().optional()
})

export const profilingRequestMetaSchema = z.object({
  enabled: z.boolean().optional(),
  id: z.string().optional(),
  includeServer: z.boolean().optional(),
  includeResources: z.boolean().optional(),
  resourceOrigin: z.enum(['local', 'provider']).optional(),
  mode: profilerModeSchema.optional()
})

export const profilingResponseMetaSchema = z.object({
  id: z.string(),
  server: serverBreakdownSchema.optional(),
  delegation: delegationBreakdownSchema.optional(),
  operation: operationEventSchema.optional()
})

export const perCallProfilingSchema = z.object({
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Enable profiling for this call only; when omitted, the SDK-level profiler configuration applies.'
    ),
  includeServerBreakdown: z
    .boolean()
    .optional()
    .describe('Include server-side timing breakdown in the profiling payload.'),
  includeResourceGauges: z
    .boolean()
    .optional()
    .describe('Attach one local CPU, memory, and GPU resource sample to the operation event.'),
  mode: profilerModeSchema
    .optional()
    .describe(
      'Profiling detail level: `"summary"` aggregates only, `"verbose"` retains recent events.'
    )
})

export type ProfilingResponseMeta = z.infer<typeof profilingResponseMetaSchema>
export type ProfilerMode = z.infer<typeof profilerModeSchema>
export type ProfilingRequestMeta = z.infer<typeof profilingRequestMetaSchema>
export type ServerBreakdown = z.infer<typeof serverBreakdownSchema>
export type DelegationBreakdown = z.infer<typeof delegationBreakdownSchema>
export type PerCallProfiling = z.infer<typeof perCallProfilingSchema>
export type OperationEvent = z.infer<typeof operationEventSchema>
export type ProfilerGPUResourceGauge = z.infer<typeof profilerGPUResourceGaugeSchema>
export type ProfilerResourceGauge = z.infer<typeof profilerResourceGaugeSchema>
