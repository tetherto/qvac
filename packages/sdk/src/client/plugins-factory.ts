import { registerPlugins } from '@/server/plugins'
import * as hostApi from '@/client/api'
import type { QvacPlugin } from '@qvac/inference/surface'

/**
 * Register plugins and return the client host API.
 */
export function plugins(pluginList: readonly QvacPlugin[]): typeof hostApi {
  registerPlugins(pluginList)
  return hostApi
}
