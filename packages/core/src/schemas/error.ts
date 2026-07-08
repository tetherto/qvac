import { z } from 'zod'
import { QvacErrorBase } from '@qvac/error'
import { formatZodError } from '../utils/zod-error'

/**
 * Serialized shape for errors that cross a response boundary — a
 * delegated provider's response over `bare-rpc`, or a duplex stream.
 * The fields are the union of (a) the `QvacErrorBase` serialisation
 * (`name`, `code`, `message`, `stack`, `cause`, `timestamp`) and (b) the
 * `typedFields` map carrying per-class structured data a receiver uses
 * to rebuild the original typed error.
 *
 * `typedFields` is opaque in transit — `z.unknown()` — and a receiver
 * casts each member at the boundary. The single-map shape keeps the
 * schema compact regardless of how many typed-error classes core
 * surfaces. A new typed-error class that needs reconstruction adds a
 * `toErrorResponseFields()` method; the schema itself doesn't change.
 */
export const errorResponseSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  stack: z.string().optional(),
  timestamp: z.string().optional(),
  name: z.string().optional(),
  code: z.number().optional(),
  cause: z.unknown().optional(),
  typedFields: z.record(z.string(), z.unknown()).optional()
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

/**
 * A `QvacErrorBase` subclass that opts into typed-field serialisation.
 * The method returns the subset of own properties a receiver needs to
 * rebuild the original class with its named constructor arguments
 * populated.
 *
 * Co-located with each class (see `utils/errors-server.ts`) so adding a
 * new typed error that survives serialisation is a two-step change:
 * define the class and implement the method.
 */
export interface TypedErrorSerializer {
  toErrorResponseFields(): Record<string, unknown>
}

function hasTypedFields(error: unknown): error is TypedErrorSerializer {
  return (
    error !== null &&
    typeof error === 'object' &&
    'toErrorResponseFields' in error &&
    typeof (error as { toErrorResponseFields?: unknown }).toErrorResponseFields === 'function'
  )
}

function isQvacError(error: unknown): error is QvacErrorBase {
  return error instanceof QvacErrorBase
}

export function createErrorResponse(error: unknown): ErrorResponse {
  if (isQvacError(error)) {
    const qvacData = error.toJSON()
    const response: ErrorResponse = {
      type: 'error',
      name: qvacData.name,
      code: qvacData.code,
      message: qvacData.message,
      stack: qvacData.stack,
      timestamp: new Date().toISOString()
    }
    if (hasTypedFields(error)) {
      response.typedFields = error.toErrorResponseFields()
    }
    return response
  }

  const message =
    error instanceof z.ZodError
      ? formatZodError(error)
      : error instanceof Error
        ? error.message
        : String(error)
  const stack = error instanceof Error ? error.stack : undefined

  return {
    type: 'error',
    message,
    stack,
    timestamp: new Date().toISOString()
  }
}
