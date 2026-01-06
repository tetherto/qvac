import { z } from 'zod';
import { expectationSchema } from '../schemas/expectations.js';

// Re-export for convenience
export type { Expectation } from '../schemas/expectations.js';

/**
 * Skip information for disabled tests
 */
export const skipInfoSchema = z.object({
  reason: z.string().describe('Why this test is skipped'),
  issue: z.string().optional().describe('Issue tracker reference (e.g., QVAC-8339)'),
  impact: z.string().optional().describe('Impact description (e.g., "causes 87+ tests to timeout")'),
});

export type SkipInfo = z.infer<typeof skipInfoSchema>;

/**
 * Test definition schema
 */
export const testDefinitionSchema = z.object({
  testId: z.string().describe('Unique identifier for this test (e.g., "api-create-user", "completion-basic")'),

  params: z.any().describe('Parameters to pass to the test executor'),

  expectation: expectationSchema.describe('Expected outcome specification for validation'),

  metadata: z
    .record(z.any())
    .optional()
    .describe('Optional metadata: setup requirements, categories, timeouts, or any repo-specific info'),

  skip: skipInfoSchema.optional().describe('If present, test is skipped with reason logged'),
});

export type TestDefinition = z.infer<typeof testDefinitionSchema>;
