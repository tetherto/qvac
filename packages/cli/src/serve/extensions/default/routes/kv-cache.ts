import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { deleteCache } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'

const reclaimResult = z.object({
  object: z.literal('kv_cache.reclaim'),
  deleted: z.literal(true)
})

const description = `
Reclaim the automatic KV cache on disk.

Chat requests cache their conversation prefix under \`~/.qvac/kv-cache\` so a
follow-up turn only prefills the new tail. Those caches are already bounded — a
4 GiB least-recently-used quota on desktop (512 MiB on mobile) and a 24-hour
idle TTL, swept at most every five minutes — so the directory does not grow
without limit and a sweeper of your own is not needed. This frees them
immediately instead of waiting for the policy, for when reclaiming disk matters
more than keeping conversations warm.

Removes every automatic cache no in-flight request is using. Deleting one costs
the next turn a full prefill instead of a partial one; no conversation content
is lost, since a KV cache is derived data.

Caller-owned *named* caches (\`completion({ kvCache: "my-session" })\`) sit
outside the retention policy and outside this endpoint. Use the SDK's
\`deleteCache({ kvCacheKey })\` for those, or \`deleteCache({ all: true })\` to
clear the directory wholesale.

**Scope is the host, not this server.** The cache directory is shared by every
QVAC process running under the same home directory, so another local process's
automatic caches are reclaimed too — the same scope the automatic sweep already
acts on. Nothing in a cache path identifies the process that wrote it, because
cache identity is content-derived, so per-server scoping is not available.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.delete(
    '/qvac/v1/kv_cache',
    {
      schema: {
        response: { 200: reclaimResult },
        tags: ['KV Cache'],
        summary: 'Reclaim automatic KV cache',
        description
      }
    },
    async () => {
      try {
        await deleteCache({ auto: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        app.qvac.logger.error(`  kv-cache reclaim failed: ${message}`)
        throw new HttpError(500, 'kv_cache_reclaim_failed', 'Failed to reclaim KV cache.')
      }
      return { object: 'kv_cache.reclaim' as const, deleted: true as const }
    }
  )
}

export default plugin
