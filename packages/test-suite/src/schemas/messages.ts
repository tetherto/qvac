import { z } from 'zod'

/**
 * Consumer registration message schema
 */
export const consumerRegistrationSchema = z.object({
  runId: z.string().describe('Run identifier for this test batch'),
  consumerId: z.string().describe('Unique consumer identifier'),
  platform: z.string().describe('Platform: desktop, ios, android, etc.'),
  timestamp: z.string().describe('ISO timestamp of registration')
})

export type ConsumerRegistration = z.infer<typeof consumerRegistrationSchema>

/**
 * Test request message schema
 */
export const testRequestSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  timestamp: z.string().optional()
})

export type TestRequest = z.infer<typeof testRequestSchema>

/**
 * Consumer notification that it is about to process a queued test.
 * This preserves the producer's pre-setup timeout and memory window.
 */
export const testPrepareSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  uniqueTestId: z.string(),
  timestamp: z.string()
})

export type TestPrepare = z.infer<typeof testPrepareSchema>

/**
 * Test start notification schema
 */
export const testStartSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  uniqueTestId: z.string(),
  timestamp: z.string()
})

export type TestStart = z.infer<typeof testStartSchema>

/**
 * Published immediately before reload starts.
 */
export const testReloadSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  uniqueTestId: z.string(),
  testId: z.string(),
  ts: z.number()
})

export type TestReload = z.infer<typeof testReloadSchema>

/**
 * Test result schema
 */
export const testResultSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  testId: z.string().describe('Test identifier'),
  uniqueTestId: z.string().describe('Unique test instance ID'),
  outcome: z.enum(['success', 'failure', 'skipped']),
  duration: z.number().describe('Test duration in milliseconds including retry if any'),
  timestamp: z.string(),
  error: z.string().optional().describe('Error message if failed'),
  output: z.string().optional().describe('Test output'),
  retried: z.boolean().optional(),
  retryPassed: z.boolean().optional(),
  retryOutput: z.string().optional(),
  attempt1DurationMs: z.number().optional()
})

export type TestResult = z.infer<typeof testResultSchema>

/**
 * Heartbeat message schema
 */
export const heartbeatSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  bootstrapped: z.boolean().optional(),
  timestamp: z.string().optional()
})

export type Heartbeat = z.infer<typeof heartbeatSchema>

/**
 * Batch complete message schema
 */
export const batchCompleteSchema = z.object({
  runId: z.string(),
  status: z.literal('complete'),
  totalTests: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  skippedCount: z.number(),
  duration: z.number()
})

export type BatchComplete = z.infer<typeof batchCompleteSchema>

export const testQueueItemSchema = z.object({
  uniqueTestId: z.string(),
  testId: z.string()
})

export type TestQueueItem = z.infer<typeof testQueueItemSchema>

export const queueEmptySchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  timestamp: z.string()
})

export type QueueEmpty = z.infer<typeof queueEmptySchema>

/**
 * Registration acknowledgment schema
 */
export const registerAckSchema = z.object({
  runId: z.string(),
  status: z.literal('registered'),
  totalTests: z.number(),
  queue: z.array(testQueueItemSchema),
  // Unique testIds left in the producer queue after --filter/--suite/--exclude-suite/skip.
  // Consumers can use this to scope bootstrap. Optional for back-compat with older producers.
  filteredTestIds: z.array(z.string()).optional()
})

export type RegisterAck = z.infer<typeof registerAckSchema>

/**
 * Test assignment message schema
 */
export const testAssignmentSchema = z.union([
  z.object({
    status: z.literal('queue-empty'),
    runId: z.string()
  }),
  z.object({
    status: z.literal('assigned'),
    runId: z.string(),
    uniqueTestId: z.string(),
    testId: z.string()
  })
])

export type TestAssignment = z.infer<typeof testAssignmentSchema>

/**
 * Aggregate statistics for a single metric.
 */
export const aggregateStatsSchema = z.object({
  count: z.number().describe('Number of samples collected'),
  min: z.number().describe('Minimum value observed'),
  max: z.number().describe('Maximum value observed'),
  avg: z.number().describe('Arithmetic mean of all samples'),
  sum: z.number().optional().describe('Sum of all sample values'),
  total: z.number().optional().describe('Sum of all sample values alias for sum'),
  last: z.number().optional().describe('Most recent sample value')
})

export type AggregateStats = z.infer<typeof aggregateStatsSchema>

/**
 * Profiler configuration as reported in export.
 */
export const profilerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.string().optional(),
    includeServerBreakdown: z.boolean().optional(),
    operationFilters: z.array(z.string()).optional(),
    maxRecentEvents: z.number().optional()
  })
  .passthrough()

/**
 * Profiler export data schema.
 */
export const profilerExportSchema = z
  .object({
    config: profilerConfigSchema.optional(),
    aggregates: z.record(z.string(), aggregateStatsSchema).optional(),
    recentEvents: z.array(z.record(z.string(), z.unknown())).optional(),
    exportedAt: z.number().optional()
  })
  .passthrough()

export type ProfilerExport = z.infer<typeof profilerExportSchema>

/**
 * Profiling data message schema
 */
export const profilingDataSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  timestamp: z.string(),
  kind: z.enum(['checkpoint', 'final']).optional(),
  sequence: z.number().int().nonnegative().optional(),
  profilerExport: profilerExportSchema
})

export type ProfilingData = z.infer<typeof profilingDataSchema>
