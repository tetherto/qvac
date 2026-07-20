import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { bindClientDisconnectCancel } from '../core/cancel-bridge.js'

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', (req, reply, done) => {
    req.bindCancel = (requestId: string) => {
      bindClientDisconnectCancel(req.raw, reply.raw, requestId, app.qvac.logger)
    }
    done()
  })
}

export default fp(plugin, { name: 'qvac-cancel-bridge' })
