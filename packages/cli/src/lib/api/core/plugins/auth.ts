import { timingSafeEqual } from 'node:crypto'
import type { HttpPlugin } from '@/lib/http'
import { IDENTITY_PATH } from '@/lib/api/core/identity'
import { HttpError } from '@/lib/api/lib/http-error'

const PUBLIC_PATHS = new Set(['/openapi.json', '/docs', '/docs/', IDENTITY_PATH])

function matches(header: string | undefined, expected: Buffer): boolean {
  const presented = Buffer.from(header ?? '', 'utf8')
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

// lunte-disable-next-line require-await
const plugin: HttpPlugin<{ apiKey: string }> = async (app, opts) => {
  const expected = Buffer.from(`Bearer ${opts.apiKey}`, 'utf8')

  // lunte-disable-next-line require-await
  app.addHook('onRequest', async (req) => {
    // Strip query before whitelist lookup so `/openapi.json?pretty=1` (or any
    // tool that tacks on params) still resolves to the public path.
    const path = req.url.split('?')[0]!
    if (PUBLIC_PATHS.has(path) || path.startsWith('/docs/')) return
    if (!matches(req.headers['authorization'], expected)) {
      throw new HttpError(401, 'invalid_api_key', 'Invalid or missing API key.')
    }
  })
}

export default plugin
