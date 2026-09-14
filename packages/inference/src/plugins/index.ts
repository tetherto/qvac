import { registerPlugins } from '@/plugins/registry'
import * as hostApi from '@/api/index'
import type { QvacPlugin } from '@/schemas/plugin'

export {
  registerPlugin,
  registerPlugins,
  getPlugin,
  getPluginHandler,
  getTurboVecIndexProvider,
  hasPlugin,
  getAllPlugins,
  clearPlugins,
  unregisterPlugin
} from '@/plugins/registry'

/**
 * Register a set of plugins and return the host API bound to them. The
 * ergonomic entry point for assembling an explicit plugin subset — we ship
 * no default plugins, so an app registers exactly the engines it needs.
 */
export function plugins(pluginList: readonly QvacPlugin[]): typeof hostApi {
  registerPlugins(pluginList)
  return hostApi
}
