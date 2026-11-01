import type { FastifyInstance } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { HttpError } from '@/serve/lib/http-error'
import { unloadModel } from '@/serve/core/lifecycle'
import type { ModelState } from '@/serve/core/model-registry'

const modelIdParams = z.object({ id: z.string().min(1) })

interface ModelObject {
  id: string
  object: 'model'
  created: number
  owned_by: string
  // Non-standard QVAC extension. OpenAI clients ignore unknown fields; QVAC
  // clients use it to see load state (idle/loading/ready/error) without loading.
  state: ModelState
}

// Every configured alias is usable — it lazy-loads on first request — so all of
// them are listed, whether or not they are currently loaded. `created` and
// `state` come from the registry entry once the alias has been registered.
function toModelObject(app: FastifyInstance, alias: string): ModelObject {
  const entry = app.qvac.registry.getEntry(alias)
  const createdMs = entry?.createdAt ?? Date.now()
  return {
    id: alias,
    object: 'model',
    created: Math.floor(createdMs / 1000),
    owned_by: 'qvac',
    state: entry?.state ?? app.qvac.registry.STATES.IDLE
  }
}

const descriptions = {
  list: `
List every model configured under \`serve.models\`. Each is usable: a model that
is not yet loaded is loaded on first request (unless \`preload: true\` loaded it
at startup). \`owned_by\` is always \`"qvac"\`.
`.trim(),
  getById: `
Fetch a single model by alias. Returns 404 \`model_not_found\` only when the
alias is not configured. A configured-but-not-yet-loaded alias is returned
normally; it loads on first inference request.
`.trim(),
  deleteById: `
Unload a model from the SDK and release its resources. The alias stays
configured and reloadable: the next inference request targeting it loads it
again (lazy load).
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/models',
    {
      schema: {
        tags: ['Models'],
        summary: 'List configured models',
        description: descriptions.list
      }
    },
    // lunte-disable-next-line require-await
    async () => ({
      object: 'list' as const,
      data: [...app.qvac.serveConfig.models.keys()].map((alias) => toModelObject(app, alias))
    })
  )

  app.get(
    '/v1/models/:id',
    {
      schema: {
        params: modelIdParams,
        tags: ['Models'],
        summary: 'Get a model',
        description: descriptions.getById
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const id = decodeURIComponent(req.params.id)
      const configured =
        app.qvac.serveConfig.models.has(id) || app.qvac.registry.getEntry(id) !== null
      if (!configured) {
        throw new HttpError(404, 'model_not_found', `Model "${id}" not found.`)
      }
      return toModelObject(app, id)
    }
  )

  app.delete(
    '/v1/models/:id',
    {
      schema: {
        params: modelIdParams,
        tags: ['Models'],
        summary: 'Unload a model',
        description: descriptions.deleteById
      }
    },
    async (req) => {
      const id = decodeURIComponent(req.params.id)
      const entry = app.qvac.registry.getEntry(id)
      if (!entry) {
        throw new HttpError(404, 'model_not_found', `Model "${id}" not found.`)
      }
      await unloadModel(id, app.qvac.registry, app.qvac.logger, app.qvac.loadManager)
      return { id, object: 'model' as const, deleted: true }
    }
  )
}

export default plugin
