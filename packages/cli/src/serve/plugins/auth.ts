import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { HttpError } from '../lib/http-error.js'

const PUBLIC_PATHS = new Set(['/openapi.json', '/docs', '/docs/'])

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsync<{ apiKey: string }> = async (app, opts) => {
  const expected = `Bearer ${opts.apiKey}`

  // lunte-disable-next-line require-await
  app.addHook('onRequest', async (req) => {
    // Strip query before whitelist lookup so `/openapi.json?pretty=1` (or any
    // tool that tacks on params) still resolves to the public path.
    const path = req.url.split('?')[0]!
    if (PUBLIC_PATHS.has(path) || path.startsWith('/docs/')) return
    if (req.headers['authorization'] !== expected) {
      throw new HttpError(401, 'invalid_api_key', 'Invalid or missing API key.')
    }
  })
}

export default fp(plugin, { name: 'qvac-auth' })
