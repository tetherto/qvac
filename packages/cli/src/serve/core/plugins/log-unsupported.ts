import type { preHandlerAsyncHookHandler } from 'fastify'

// lunte-disable-next-line require-await
export const logUnsupported: preHandlerAsyncHookHandler = async function (req) {
  const list = req.routeOptions?.config?.unsupportedParams
  if (!list || list.length === 0) return
  const body = req.body as Record<string, unknown> | undefined
  if (!body) return
  const logger = req.server.qvac.logger
  for (const key of list) {
    const value = body[key]
    if (value === undefined) continue
    logger.warn(`Ignoring unsupported param: ${key}`)
  }
}
