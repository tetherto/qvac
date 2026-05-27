import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { HttpError } from '../lib/http-error.js'
import { unloadModel } from '../core/lifecycle.js'
import type { ModelEntry } from '../core/model-registry.js'

const modelIdParams = z.object({ id: z.string().min(1) })

function toModelObject (entry: ModelEntry): { id: string; object: 'model'; created: number; owned_by: string } {
  return {
    id: entry.id,
    object: 'model',
    created: Math.floor(entry.createdAt / 1000),
    owned_by: 'qvac'
  }
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/v1/models', {
    schema: { tags: ['Models'], summary: 'List ready models' }
  }, async () => ({
    object: 'list' as const,
    data: app.qvac.registry.getReady().map(toModelObject)
  }))

  app.get('/v1/models/:id', {
    schema: { params: modelIdParams, tags: ['Models'], summary: 'Get a model' }
  }, async (req) => {
    const entry = app.qvac.registry.getEntry(decodeURIComponent(req.params.id))
    if (!entry || entry.state !== app.qvac.registry.STATES.READY) {
      throw new HttpError(404, 'model_not_found', `Model "${req.params.id}" not found or not loaded.`)
    }
    return toModelObject(entry)
  })

  app.delete('/v1/models/:id', {
    schema: { params: modelIdParams, tags: ['Models'], summary: 'Unload a model' }
  }, async (req) => {
    const id = decodeURIComponent(req.params.id)
    const entry = app.qvac.registry.getEntry(id)
    if (!entry) {
      throw new HttpError(404, 'model_not_found', `Model "${id}" not found.`)
    }
    await unloadModel(id, app.qvac.registry, app.qvac.logger)
    return { id, object: 'model' as const, deleted: true }
  })
}

export default plugin
