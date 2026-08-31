import fp from 'fastify-plugin'
import type { FastifyError, FastifyPluginAsync } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError
} from 'fastify-type-provider-zod'
import { HttpError, errorType } from '@/serve/lib/http-error'
import { sendSSE, endSSE } from '@/serve/lib/sse'

export interface ErrorHandlerOptions {
  /**
   * Request field to error code, contributed by the mounted extensions. A key
   * may name the validation failure too — `field:<zod issue code>` wins over
   * the bare `field` when that is how the body failed.
   */
  fieldCodes?: Record<string, string>
}

// `model` is core's: every route resolves it through `requireModel`. Each
// extension contributes the fields of its own request bodies.
const CORE_FIELD_CODES: Record<string, string> = {
  model: 'missing_model'
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsync<ErrorHandlerOptions> = async (app, opts) => {
  const fieldCodes = { ...CORE_FIELD_CODES, ...opts.fieldCodes }

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const sseSentinel = req.routeOptions?.config?.sseSentinel ?? true
    const message = err.message ?? 'An internal error occurred.'

    if (reply.raw.headersSent) {
      app.qvac.logger.error(formatServerError('streaming_error', req.method, req.url, err))
      sendSSE(reply.raw, {
        error: {
          message,
          type: 'server_error',
          code: err instanceof HttpError ? err.code : 'internal_error'
        }
      })
      endSSE(reply.raw, { sentinel: sseSentinel })
      return
    }

    if (err instanceof HttpError) {
      reply.code(err.status).send({
        error: { message, type: errorType(err.status), code: err.code }
      })
      return
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
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

    if (
      err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
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
    // Bare OPTIONS (no `--cors`, so @fastify/cors didn't claim it) must still
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

function formatServerError(label: string, method: string, url: string, err: FastifyError): string {
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

export default fp(plugin, { name: 'qvac-error-handler' })
