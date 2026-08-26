import { z } from 'zod'
import { expectationSchema } from '../schemas/expectations.js'

// Re-export for convenience
export type { Expectation } from '../schemas/expectations.js'

/**
 * Skip information for disabled tests
 */
export const skipInfoSchema = z.object({
  reason: z.string().describe('Why this test is skipped'),
  issue: z.string().optional().describe('Issue tracker reference (e.g., QVAC-8339)'),
  impact: z
    .string()
    .optional()
    .describe('Impact description (e.g., "causes 87+ tests to timeout")'),
  platforms: z
    .array(z.string())
    .optional()
    .describe('If set, skip only on these platforms (e.g., ["mobile-ios", "mobile-android"])')
})

export type SkipInfo = z.infer<typeof skipInfoSchema>

/**
 * Test definition schema
 */
export const testDefinitionSchema = z.object({
  testId: z
    .string()
    .describe('Unique identifier for this test (e.g., "api-create-user", "completion-basic")'),

  params: z.any().describe('Parameters to pass to the test executor'),

  expectation: expectationSchema.describe('Expected outcome specification for validation'),

  metadata: z
    .record(z.any())
    .optional()
    .describe(
      'Optional metadata: setup requirements, categories, timeouts, or any repo-specific info'
    ),

  suites: z
    .array(z.string())
    .optional()
    .describe('Suite tags for grouping and filtering (e.g., ["smoke", "regression", "slow"])'),

  skip: skipInfoSchema.optional().describe('If present, test is skipped with reason logged'),

  retryOnFailure: z
    .boolean()
    .optional()
    .describe(
      'Opt-in diagnostic reload retry. Disabled by default; when omitted or false the test ' +
        'behaves exactly as before (no retry). Set to true to enable: on failure the executor ' +
        'reload() is called and the test runs once more. The test is always reported as failed ' +
        'regardless of retry outcome — diagnostic only.'
    )
})

export type TestDefinition = z.infer<typeof testDefinitionSchema>
