import { z } from 'zod'

const errorBody = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string()
  })
})

/** `error.code` to when a route returns it. */
export type ErrorCodes = Record<string, string>

/**
 * Response schemas for a route's error statuses, each described by the codes it
 * carries so the OpenAPI document lists them.
 */
export function errorResponses(statuses: Record<number, ErrorCodes>): Record<number, z.ZodType> {
  const responses: Record<number, z.ZodType> = {}
  for (const [status, codes] of Object.entries(statuses)) {
    const lines = Object.entries(codes).map(([code, when]) => `- \`${code}\`: ${when}`)
    responses[Number(status)] = errorBody.describe(lines.join('\n'))
  }
  return responses
}
