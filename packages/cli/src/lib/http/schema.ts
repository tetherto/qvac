import { z } from 'zod'
import type { HttpSchema } from './index.js'

export interface HttpSchemaValidationError {
  instancePath: string
  keyword: string
  message: string
}
export interface HttpErrorShape extends Error {
  code?: string
  statusCode?: number
  validation?: HttpSchemaValidationError[]
  validationContext?: string
}
export function validationError(
  issues: readonly z.core.$ZodIssue[],
  context: string
): HttpErrorShape {
  return Object.assign(new Error('Request failed validation'), {
    code: 'HTTP_SCHEMA_VALIDATION',
    statusCode: 400,
    validationContext: context,
    validation: issues.map((issue) => ({
      instancePath:
        '/' +
        issue.path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/'),
      keyword: issue.code,
      message: issue.message
    }))
  })
}
export function hasSchemaValidationErrors(
  error: unknown
): error is HttpErrorShape & { validation: HttpSchemaValidationError[] } {
  return error instanceof Error && 'code' in error && error.code === 'HTTP_SCHEMA_VALIDATION'
}
export function isResponseSerializationError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'HTTP_RESPONSE_SERIALIZATION'
}
interface CompilerOptions {
  schema: z.ZodType
  method?: string
  url?: string
  httpPart?: string
  httpStatus?: string
}
export function validatorCompiler({ schema, httpPart = 'body' }: CompilerOptions) {
  return (value: unknown) => {
    const parsed = schema.safeParse(value)
    return parsed.success
      ? { value: parsed.data }
      : { error: validationError(parsed.error.issues, httpPart).validation! }
  }
}
export function serializerCompiler({ schema }: CompilerOptions) {
  return (value: unknown): string => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw Object.assign(new Error('Response serialization failed', { cause: parsed.error }), {
        code: 'HTTP_RESPONSE_SERIALIZATION',
        statusCode: 500
      })
    }
    return JSON.stringify(parsed.data)
  }
}
export function validate(schema: z.ZodType | undefined, value: unknown, context: string): unknown {
  if (!schema) return value
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validationError(parsed.error.issues, context)
  return parsed.data
}
function jsonSchema(schema: z.ZodType, io: 'input' | 'output') {
  const document = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'openapi-3.0' })
  delete document.$schema
  return document
}
export function operation(schema: HttpSchema, method: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of ['tags', 'summary', 'description', 'operationId', 'security', 'deprecated']) {
    if (schema[key] !== undefined) result[key] = schema[key]
  }
  const parameters: unknown[] = []
  for (const [where, source] of [
    ['path', schema.params],
    ['query', schema.querystring]
  ] as const) {
    if (!source) continue
    const document = jsonSchema(source, 'input')
    const properties = document.properties ?? {}
    const required = document.required ?? []
    for (const [name, property] of Object.entries(properties)) {
      parameters.push({
        name,
        in: where,
        required: where === 'path' || required.includes(name),
        schema: property
      })
    }
  }
  if (parameters.length) result['parameters'] = parameters
  if (schema.body && method !== 'GET' && method !== 'HEAD') {
    result['requestBody'] = {
      required: !schema.body.safeParse(undefined).success,
      content: Object.fromEntries(
        (schema.consumes ?? ['application/json']).map((type) => [
          type,
          { schema: jsonSchema(schema.body!, 'input') }
        ])
      )
    }
  }
  result['responses'] = schema.response
    ? Object.fromEntries(
        Object.entries(schema.response).map(([status, response]) => [
          status,
          {
            description: response.description ?? 'Response',
            content: Object.fromEntries(
              (schema.produces ?? ['application/json']).map((type) => [
                type,
                { schema: jsonSchema(response, 'output') }
              ])
            )
          }
        ])
      )
    : { 200: { description: 'Successful response' } }
  return result
}
