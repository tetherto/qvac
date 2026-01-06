import { z } from 'zod';

/**
 * Consumer registration message schema
 */
export const consumerRegistrationSchema = z.object({
  runId: z.string().describe('Run identifier for this test batch'),
  consumerId: z.string().describe('Unique consumer identifier'),
  platform: z.string().describe('Platform: desktop, ios, android, etc.'),
  timestamp: z.string().describe('ISO timestamp of registration'),
});

export type ConsumerRegistration = z.infer<typeof consumerRegistrationSchema>;

/**
 * Test request message schema
 */
export const testRequestSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  timestamp: z.string().optional(),
});

export type TestRequest = z.infer<typeof testRequestSchema>;

/**
 * Test start notification schema
 */
export const testStartSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  uniqueTestId: z.string(),
  timestamp: z.string(),
});

export type TestStart = z.infer<typeof testStartSchema>;

/**
 * Test result schema
 */
export const testResultSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  testId: z.string().describe('Test identifier'),
  uniqueTestId: z.string().describe('Unique test instance ID'),
  outcome: z.enum(['success', 'failure']),
  duration: z.number().describe('Test duration in milliseconds'),
  timestamp: z.string(),
  error: z.string().optional().describe('Error message if failed'),
  output: z.string().optional().describe('Test output'),
});

export type TestResult = z.infer<typeof testResultSchema>;

/**
 * Heartbeat message schema
 */
export const heartbeatSchema = z.object({
  runId: z.string(),
  consumerId: z.string(),
  timestamp: z.string().optional(),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

/**
 * Batch complete message schema
 */
export const batchCompleteSchema = z.object({
  runId: z.string(),
  status: z.literal('complete'),
  totalTests: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  duration: z.number(),
});

export type BatchComplete = z.infer<typeof batchCompleteSchema>;

/**
 * Registration acknowledgment schema
 */
export const registerAckSchema = z.object({
  runId: z.string(),
  status: z.literal('registered'),
  totalTests: z.number(),
});

export type RegisterAck = z.infer<typeof registerAckSchema>;

/**
 * Test assignment message schema
 */
export const testAssignmentSchema = z.union([
  z.object({
    status: z.literal('queue-empty'),
    runId: z.string(),
  }),
  z.object({
    status: z.literal('assigned'),
    runId: z.string(),
    uniqueTestId: z.string(),
    test: z.object({
      testId: z.string(),
      params: z.unknown(),
      expectation: z.unknown(),
    }),
  }),
]);

export type TestAssignment = z.infer<typeof testAssignmentSchema>;
