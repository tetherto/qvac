import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  InferenceCancelledError,
  ModelRegistryBusyError,
  ModelRegistryModelNotFoundError,
  modelRegistryGetModel,
  modelRegistrySearch,
  type ModelRegistryEntry,
  type ModelRegistrySearchParams
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import { paginate } from '@/serve/core/model-catalog'
import {
  registryLookupQuery,
  registryModel,
  registryModelsQuery,
  registryModelsResult
} from '@/serve/extensions/default/schemas/registry'

const descriptions = {
  list: `
Browse and search the live QVAC model registry, backed by the SDK's
\`modelRegistrySearch()\`. Read-only: nothing is downloaded or loaded.

Filters combine with AND; with none, every entry is listed. Entries are
registry models, not \`serve.models\` aliases: one is only callable once a
\`serve.models\` alias points at it (\`src: "registry://<registrySource>/<registryPath>"\`).

The first request after start-up connects to the registry over P2P and can
take several seconds. While another QVAC process on this machine is using the
registry, a request waits for it, up to a minute, then returns
\`503 registry_busy\`. Disconnecting stops the wait.
`.trim(),
  lookup: `
Fetch one registry entry by the \`registrySource\` and \`registryPath\` a list
row carries, backed by the SDK's \`modelRegistryGetModel()\`. Same shape as a
list row.
`.trim()
}

const registryFailed = {
  registry_query_failed: 'The registry could not be reached or queried'
}

const registryBusy = {
  registry_busy: 'Another QVAC process kept the registry for longer than the request waits'
}

// Seconds a client should wait before retrying when the holder runs this SDK
// and hands the registry over once its own work ends.
const BUSY_RETRY_AFTER_S = 5

/** The SDK queries return their `requestId` so a disconnect can cancel the wait. */
type RegistryQuery<T> = Promise<T> & { requestId?: string }

export interface RegistryQueries {
  search: (params: ModelRegistrySearchParams) => RegistryQuery<ModelRegistryEntry[]>
  getModel: (registryPath: string, registrySource: string) => RegistryQuery<ModelRegistryEntry>
}

const SDK_QUERIES: RegistryQueries = {
  search: modelRegistrySearch,
  getModel: modelRegistryGetModel
}

export function registryRoutes(queries: RegistryQueries = SDK_QUERIES): FastifyPluginAsyncZod {
  // lunte-disable-next-line require-await
  return async (app) => {
    function queryFailed(err: unknown, reply: FastifyReply): unknown {
      // Only a client disconnect cancels a query. The error handler drops it
      // once the client is gone, so it is neither logged nor answered.
      if (err instanceof InferenceCancelledError) return err
      if (err instanceof ModelRegistryBusyError) {
        if (err.holder === 'current') reply.header('retry-after', String(BUSY_RETRY_AFTER_S))
        return new HttpError(503, 'registry_busy', err.message)
      }
      const message = err instanceof Error ? err.message : String(err)
      app.qvac.logger.error(`  registry query failed: ${message}`)
      return new HttpError(502, 'registry_query_failed', 'Failed to query the model registry.')
    }

    // Binds the query to the request, so a client that disconnects stops its wait.
    function track<T>(req: FastifyRequest, query: RegistryQuery<T>): Promise<T> {
      if (query.requestId) req.bindCancel(query.requestId)
      return query
    }

    app.get(
      '/qvac/v1/registry/models',
      {
        schema: {
          querystring: registryModelsQuery,
          response: {
            200: registryModelsResult,
            ...errorResponses({
              400: {
                invalid_addon: '`addon` is not a registry addon',
                invalid_limit: '`limit` is not a positive integer',
                invalid_offset: '`offset` is not a non-negative integer'
              },
              502: registryFailed,
              503: registryBusy
            })
          },
          tags: ['Registry'],
          summary: 'Browse the model registry',
          description: descriptions.list
        }
      },
      async (req, reply) => {
        const { search: filter, addon, engine, quantization, limit, offset } = req.query
        let models: ModelRegistryEntry[]
        try {
          models = await track(
            req,
            queries.search({
              ...(filter !== undefined && { filter }),
              ...(addon !== undefined && { addon }),
              ...(engine !== undefined && { engine }),
              ...(quantization !== undefined && { quantization })
            })
          )
        } catch (err) {
          throw queryFailed(err, reply)
        }
        const { data, hasMore } = paginate(models, limit, offset)
        return { object: 'list' as const, data, has_more: hasMore }
      }
    )

    app.get(
      '/qvac/v1/registry/models/lookup',
      {
        schema: {
          querystring: registryLookupQuery,
          response: {
            200: registryModel,
            ...errorResponses({
              400: {
                invalid_registry_source: '`registrySource` is missing or empty',
                invalid_registry_path: '`registryPath` is missing or empty'
              },
              404: { model_not_found: 'No registry entry has this source and path' },
              502: registryFailed,
              503: registryBusy
            })
          },
          tags: ['Registry'],
          summary: 'Get a registry model',
          description: descriptions.lookup
        }
      },
      async (req, reply) => {
        const { registrySource, registryPath } = req.query
        try {
          return await track(req, queries.getModel(registryPath, registrySource))
        } catch (err) {
          if (err instanceof ModelRegistryModelNotFoundError) {
            throw new HttpError(
              404,
              'model_not_found',
              `No registry model at ${registrySource}/${registryPath}.`
            )
          }
          throw queryFailed(err, reply)
        }
      }
    )
  }
}

export default registryRoutes()
