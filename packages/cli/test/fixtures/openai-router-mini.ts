// Minimal router slice for coverage tests (parsed as text only).
// Mirrors the HTTP route plugin shape used under `serve/routes/`.
import type { HttpPlugin } from '@/lib/http'

// lunte-disable-next-line require-await
const plugin: HttpPlugin = async (app) => {
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
  // lunte-disable-next-line require-await
  app.get('/v1/audio/models', {}, async () => ({}))
}

export default plugin
