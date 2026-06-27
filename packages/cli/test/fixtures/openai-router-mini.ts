// Minimal router slice for coverage tests (parsed as text only).
// Mirrors the Fastify route plugin shape used under `serve/routes/`.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  // lunte-disable-next-line require-await
  app.post('/v1/chat/completions', {}, async () => ({}))
  // lunte-disable-next-line require-await
  app.post('/v1/embeddings', {}, async () => ({}))
  // lunte-disable-next-line require-await
  app.get('/v1/models', {}, async () => ({}))
  // lunte-disable-next-line require-await
  app.get('/v1/files', {}, async () => ({}))
  // lunte-disable-next-line require-await
  app.post('/v1/files', {}, async () => ({}))
  // lunte-disable-next-line require-await
  app.get('/v1/files/:id', {}, async () => ({}))
}

export default plugin
