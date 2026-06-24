// Minimal router slice for coverage tests (parsed as text only).
// Mirrors the Fastify route plugin shape used under `serve/routes/`.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/chat/completions', {}, async () => ({}))
  app.post('/v1/embeddings', {}, async () => ({}))
  app.get('/v1/models', {}, async () => ({}))
  app.get('/v1/files', {}, async () => ({}))
  app.post('/v1/files', {}, async () => ({}))
  app.get('/v1/files/:id', {}, async () => ({}))
}

export default plugin
