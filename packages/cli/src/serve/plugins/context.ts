import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import type { QvacContext } from '../lib/types.js'

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsync<{ context: QvacContext }> = async (app, opts) => {
  app.decorate('qvac', opts.context)
}

export default fp(plugin, { name: 'qvac-context' })
