import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { getSystemResources } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import { systemQuery, systemResult } from '@/serve/extensions/default/schemas/system'

const description = `
Report the host's capacity, backed by the SDK's \`getSystemResources()\`.

\`capabilities\` describes the CPU, total memory and each GPU with its graphics
drivers. \`?sample=true\` adds \`sample\`: CPU load, memory in use (system-wide
and for the serving process), and per-GPU utilization at the time of the request.

Every figure is a metric with a \`status\`. Only \`supported\` carries a
\`value\`, with the \`provenance\` it was read from; \`unavailable\`,
\`unverified\` and \`failed\` mean the platform could not give a trustworthy
number, and may carry a \`reason\`.

The figures describe the machine the server runs on, not the caller's.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/qvac/v1/system',
    {
      schema: {
        querystring: systemQuery,
        response: {
          200: systemResult,
          ...errorResponses({
            400: { invalid_sample: '`sample` is not `true` or `false`' },
            500: { system_resources_failed: 'The SDK could not read system resources' }
          })
        },
        tags: ['System'],
        summary: 'Read system resources',
        description
      }
    },
    async (req) => {
      try {
        const resources = await getSystemResources({ sample: req.query.sample })
        return { object: 'system' as const, ...resources }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        app.qvac.logger.error(`  system resources failed: ${message}`)
        throw new HttpError(500, 'system_resources_failed', 'Failed to read system resources.')
      }
    }
  )
}

export default plugin
