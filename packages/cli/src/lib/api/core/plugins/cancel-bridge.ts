import type { HttpPlugin } from '@/lib/http'
import { bindClientDisconnectCancel } from '@/lib/api/core/cancel-bridge'

// lunte-disable-next-line require-await
const plugin: HttpPlugin = async (app) => {
  app.addHook('onRequest', (req, reply, done) => {
    req.bindCancel = (requestId: string) => {
      bindClientDisconnectCancel(reply.raw, requestId, app.qvac.logger)
    }
    done()
  })
}

export default plugin
