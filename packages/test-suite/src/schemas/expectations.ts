import { z } from 'zod'

/**
 * Contains validation: all or any strings must be present
 */
const containsExpectationSchema = z.object({
  validation: z
    .enum(['contains-all', 'contains-any'])
    .describe(
      'contains-all: all strings must be present | contains-any: at least one string must be present'
    ),
  contains: z.array(z.string()).describe('Array of strings to check for in the result')
})

/**
 * Regex validation: pattern must match
 */
const regexExpectationSchema = z.object({
  validation: z.literal('regex'),
  pattern: z.string().describe('Regular expression pattern to match against result')
})

/**
 * Numeric range validation: value within bounds
 */
const numericExpectationSchema = z.object({
  validation: z.literal('numeric-range'),
  min: z.number().optional().describe('Minimum value (inclusive)'),
  max: z.number().optional().describe('Maximum value (inclusive)')
})

/**
 * Type validation: check result type
 */
const typeExpectationSchema = z.object({
  validation: z.literal('type'),
  expectedType: z.enum(['string', 'number', 'array']).describe('Expected JavaScript type'),
  minLength: z.number().optional().describe('For array type: minimum array length')
})

/**
 * Error validation: test must throw with specific message
 */
const errorExpectationSchema = z.object({
  validation: z.literal('throws-error'),
  errorContains: z.string().describe('String that must be present in the error message')
})

/**
 * Function validation: user-provided function returning TestResult
 * Only works when consumer has local test definitions (not serializable over MQTT).
 */
const functionExpectationSchema = z.object({
  validation: z.literal('function'),
  fn: z
    .function()
    .args(z.any())
    .returns(z.any())
    .describe('Validator function: (result) => TestResult ({ passed, output })')
})

/**
 * Union of all expectation types
 */
export const expectationSchema = z.union([
  containsExpectationSchema,
  regexExpectationSchema,
  numericExpectationSchema,
  typeExpectationSchema,
  errorExpectationSchema,
  functionExpectationSchema
])

export type Expectation = z.infer<typeof expectationSchema>
