import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { HttpError } from '@/serve/lib/http-error'
import { buildCatalog, filterCatalog, paginate } from '@/serve/core/model-catalog'
import { loadModelConstants } from '@/serve/sdk-constants'
import { modelCatalogQuery, modelCatalogIdParams } from '@/serve/schemas/models-catalog'

const descriptions = {
  list: `
Browse every model this server knows of, filterable by capability. Rows are
catalog entries (\`object: "model_catalog_entry"\`), NOT usable \`model\` objects:
a \`not_configured\` entry is a model the SDK provides but which is not in
\`serve.models\`, so it cannot be called until it is configured. Configured models
carry their live load \`state\` (idle/loading/ready/error). Fully in-process — no
model loads or downloads are triggered.
`.trim(),
  getById: `
Fetch a single catalog entry by id (alias or SDK constant name). Same shape as a
list row. 404 \`model_not_found\` if the id is neither configured nor a known
SDK constant.
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/models/catalog',
    {
      schema: {
        querystring: modelCatalogQuery,
        tags: ['Model Catalog'],
        summary: 'Browse available models',
        description: descriptions.list
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const q = req.query
      const all = buildCatalog(app.qvac.serveConfig, app.qvac.registry, loadModelConstants())
      const filtered = filterCatalog(all, {
        search: q.search,
        role: q.role,
        addon: q.addon ?? q.type,
        quantization: q.quantization,
        engine: q.engine,
        configured: q.configured
      })
      const { data, hasMore } = paginate(filtered, q.limit, q.offset)
      return { object: 'list' as const, data, has_more: hasMore }
    }
  )

  app.get(
    '/v1/models/catalog/:id',
    {
      schema: {
        params: modelCatalogIdParams,
        tags: ['Model Catalog'],
        summary: 'Get a catalog model',
        description: descriptions.getById
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const id = decodeURIComponent(req.params.id)
      const all = buildCatalog(app.qvac.serveConfig, app.qvac.registry, loadModelConstants())
      const entry = all.find((e) => e.id === id)
      if (!entry) {
        throw new HttpError(404, 'model_not_found', `Model "${id}" not found in the catalog.`)
      }
      return entry
    }
  )
}

export default plugin
