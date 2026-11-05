import type { HttpErrorShape, HttpPlugin } from '@/lib/http'
import { hasSchemaValidationErrors, isResponseSerializationError } from '@/lib/http'
import { ContextOverflowError, RequestRejectedByPolicyError } from '@qvac/sdk'
import { HttpError, errorType } from '@/lib/api/lib/http-error'
import { isLifecycleBlockedError, runtimeSuspendedError } from '@/lib/api/core/lifecycle'
import { sendSSE, endSSE } from '@/lib/api/lib/sse'

export interface ErrorHandlerOptions {
  /**
   * Request field to error code, contributed by the mounted extensions. A key
   * may name the validation failure too — `field:<zod issue code>` wins over
   * the bare `field` when that is how the body failed.
   */
  fieldCodes?: Record<string, string>
}

// `model` is core's: every route resolves it through `requireModel`. Paging is
// core's too, so its codes don't depend on which extensions are mounted. Each
// extension contributes the fields of its own request bodies.
const CORE_FIELD_CODES: Record<string, string> = {
  model: 'missing_model',
  limit: 'invalid_limit',
  offset: 'invalid_offset'
}

// lunte-disable-next-line require-await
const plugin: HttpPlugin<ErrorHandlerOptions> = async (app, opts) => {
  const fieldCodes = { ...CORE_FIELD_CODES, ...opts.fieldCodes }

  app.setErrorHandler((err: HttpErrorShape, req, reply) => {
    // Disconnect cancellation can reject after the client has gone. There is
    // no response left to send, and this is not a server failure to log.
    if (reply.raw.destroyed || reply.raw.writableEnded) return

    const sseSentinel = req.routeOptions?.config?.sseSentinel ?? true
    const sdkHttpError = sdkErrorAsHttp(err)
    const httpError = sdkHttpError ?? (err instanceof HttpError ? err : undefined)
    const message = httpError?.message ?? err.message ?? 'An internal error occurred.'

    if (reply.raw.headersSent) {
      if (!sdkHttpError) {
        app.qvac.logger.error(formatServerError('streaming_error', req.method, req.url, err))
      }
      sendSSE(reply.raw, {
        error: {
          message: httpError?.message ?? 'An internal error occurred.',
          type: sdkHttpError ? errorType(sdkHttpError.status) : 'server_error',
          code: httpError?.code ?? 'internal_error'
        }
      })
      endSSE(reply.raw, { sentinel: sseSentinel })
      return
    }

    if (httpError) {
      reply.code(httpError.status).send({
        error: { message, type: errorType(httpError.status), code: httpError.code }
      })
      return
    }

    if (err instanceof RequestRejectedByPolicyError) {
      reply.code(429).send({
        error: { message, type: 'rate_limit_error', code: 'request_rejected_by_policy' }
      })
      return
    }

    if (hasSchemaValidationErrors(err)) {
      const issue = err.validation[0] as
        { instancePath?: string; message?: string; keyword?: string } | undefined
      const head = headFromInstancePath(issue?.instancePath)
      const code = fieldCode(fieldCodes, head, issue?.keyword)
      const detail = issue?.message ?? 'Request body failed validation.'
      reply.code(400).send({
        error: {
          message: head ? `${head}: ${detail}` : detail,
          type: 'invalid_request_error',
          code
        }
      })
      return
    }

    if (err.code === 'HTTP_INVALID_JSON_BODY' || err.code === 'HTTP_EMPTY_JSON_BODY') {
      reply.code(400).send({
        error: {
          message: 'Request body must be valid JSON.',
          type: 'invalid_request_error',
          code: 'invalid_json'
        }
      })
      return
    }

    if (isResponseSerializationError(err)) {
      app.qvac.logger.error(
        formatServerError('response_serialization_error', req.method, req.url, err)
      )
      reply.code(500).send({
        error: {
          message: 'Response serialization failed.',
          type: 'server_error',
          code: 'internal_error'
        }
      })
      return
    }

    if (Array.isArray(err.validation)) {
      reply.code(err.statusCode ?? 400).send({
        error: { message, type: 'invalid_request_error', code: 'invalid_request' }
      })
      return
    }

    if (err.statusCode === 413) {
      reply.code(413).send({
        error: { message, type: 'invalid_request_error', code: 'request_too_large' }
      })
      return
    }

    if (err.statusCode !== undefined && err.statusCode < 500) {
      reply.code(err.statusCode).send({
        error: { message, type: errorType(err.statusCode), code: 'invalid_request' }
      })
      return
    }

    app.qvac.logger.error(formatServerError('unhandled', req.method, req.url, err))
    reply.code(500).send({
      error: {
        message: 'An internal error occurred.',
        type: 'server_error',
        code: 'internal_error'
      }
    })
  })

  app.setNotFoundHandler((req, reply) => {
    // Bare OPTIONS (without CORS handling) must still
    // return 204 to match the legacy node:http server's behavior — browsers
    // and HTTP clients rely on it as a preflight no-op even when CORS is off.
    if (req.method === 'OPTIONS') {
      reply.code(204).send()
      return
    }
    reply.code(404).send({
      error: {
        message: `Unknown endpoint: ${req.method} ${req.url}`,
        type: 'invalid_request_error',
        code: 'not_found'
      }
    })
  })
}

// SDK errors a client can act on, rather than a server fault.
export function sdkErrorAsHttp(err: unknown): HttpError | undefined {
  if (err instanceof ContextOverflowError) {
    return new HttpError(
      400,
      'context_length_exceeded',
      "The request exceeds the model's context capacity. Shorten the input, start a new conversation, or increase ctx_size."
    )
  }
  if (isLifecycleBlockedError(err)) return runtimeSuspendedError()
  return undefined
}

function formatServerError(
  label: string,
  method: string,
  url: string,
  err: HttpErrorShape
): string {
  const stack = err.stack ?? `${err.name}: ${err.message}`
  return `${label} ${method} ${url}\n${stack}`
}

function fieldCode(
  fieldCodes: Record<string, string>,
  head: string,
  keyword: string | undefined
): string {
  if (keyword !== undefined) {
    const specific = fieldCodes[`${head}:${keyword}`]
    if (specific !== undefined) return specific
  }
  return fieldCodes[head] ?? 'invalid_request'
}

function headFromInstancePath(instancePath: string | undefined): string {
  if (!instancePath) return ''
  const trimmed = instancePath.replace(/^\/+/, '')
  const slash = trimmed.indexOf('/')
  return slash >= 0 ? trimmed.slice(0, slash) : trimmed
}

export default plugin
