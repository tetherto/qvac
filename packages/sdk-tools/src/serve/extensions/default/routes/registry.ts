import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
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
take several seconds.
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

export interface RegistryQueries {
  search: (params: ModelRegistrySearchParams) => Promise<ModelRegistryEntry[]>
  getModel: (registryPath: string, registrySource: string) => Promise<ModelRegistryEntry>
}

const SDK_QUERIES: RegistryQueries = {
  search: modelRegistrySearch,
  getModel: modelRegistryGetModel
}

export function registryRoutes(queries: RegistryQueries = SDK_QUERIES): FastifyPluginAsyncZod {
  // lunte-disable-next-line require-await
  return async (app) => {
    function queryFailed(err: unknown): HttpError {
      const message = err instanceof Error ? err.message : String(err)
      app.qvac.logger.error(`  registry query failed: ${message}`)
      return new HttpError(502, 'registry_query_failed', 'Failed to query the model registry.')
    }

    async function search(params: ModelRegistrySearchParams): Promise<ModelRegistryEntry[]> {
      try {
        return await queries.search(params)
      } catch (err) {
        throw queryFailed(err)
      }
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
              502: registryFailed
            })
          },
          tags: ['Registry'],
          summary: 'Browse the model registry',
          description: descriptions.list
        }
      },
      async (req) => {
        const { search: filter, addon, engine, quantization, limit, offset } = req.query
        const models = await search({
          ...(filter !== undefined && { filter }),
          ...(addon !== undefined && { addon }),
          ...(engine !== undefined && { engine }),
          ...(quantization !== undefined && { quantization })
        })
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
              502: registryFailed
            })
          },
          tags: ['Registry'],
          summary: 'Get a registry model',
          description: descriptions.lookup
        }
      },
      async (req) => {
        const { registrySource, registryPath } = req.query
        try {
          return await queries.getModel(registryPath, registrySource)
        } catch (err) {
          if (err instanceof ModelRegistryModelNotFoundError) {
            throw new HttpError(
              404,
              'model_not_found',
              `No registry model at ${registrySource}/${registryPath}.`
            )
          }
          throw queryFailed(err)
        }
      }
    )
  }
}

export default registryRoutes()
