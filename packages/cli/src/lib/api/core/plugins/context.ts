import type { HttpPlugin } from '@/lib/http'
import type { QvacContext } from '@/lib/api/core/context'

// lunte-disable-next-line require-await
const plugin: HttpPlugin<{ context: QvacContext }> = async (app, opts) => {
  app.decorate('qvac', opts.context)
}

export default plugin
